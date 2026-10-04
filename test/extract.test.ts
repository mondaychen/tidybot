import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractExcerpt, mimeOf } from "../src/extract.js";
import { scan } from "../src/scan.js";
import { loadSummaries } from "../src/store/summaries.js";
import { chinesePdf, pdf, sandbox, write, zip } from "./helpers.js";

let root: string;
beforeEach(() => {
  root = sandbox();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extractExcerpt", () => {
  it("reads text files and truncates", async () => {
    const f = write(path.join(root, "a.md"), "# Title\n\nhello world ".repeat(50));
    const r = await extractExcerpt(f, 20);
    expect(r.method).toBe("text");
    expect(r.excerpt.length).toBe(20);
  });

  it("sniffs text in files with unknown extensions", async () => {
    const r = await extractExcerpt(write(path.join(root, "notes.weird"), "plain words"), 100);
    expect(r).toMatchObject({ method: "text", excerpt: "plain words" });
  });

  it("returns nothing for binary files", async () => {
    const r = await extractExcerpt(write(path.join(root, "x.bin"), Buffer.from([0, 1, 2, 3])), 100);
    expect(r).toMatchObject({ method: "none", excerpt: "" });
  });

  it("extracts docx paragraphs", async () => {
    const xml = `<w:document><w:body><w:p><w:r><w:t>Lease Agreement</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Tenant &amp; Landlord</w:t></w:r></w:p></w:body></w:document>`;
    const f = write(path.join(root, "lease.docx"), await zip({ "word/document.xml": xml }));
    const r = await extractExcerpt(f, 500);
    expect(r.excerpt).toBe("Lease Agreement\nTenant & Landlord");
  });

  it("extracts pptx slides in order", async () => {
    const slide = (t: string) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
    const f = write(
      path.join(root, "deck.pptx"),
      await zip({ "ppt/slides/slide10.xml": slide("Ten"), "ppt/slides/slide2.xml": slide("Two"), "ppt/slides/slide1.xml": slide("One") }),
    );
    expect((await extractExcerpt(f, 500)).excerpt).toBe("One\n---\nTwo\n---\nTen");
  });

  it("extracts xlsx sheet names and strings", async () => {
    const f = write(
      path.join(root, "budget.xlsx"),
      await zip({
        "xl/workbook.xml": `<workbook><sheets><sheet name="2026 Budget" sheetId="1"/></sheets></workbook>`,
        "xl/sharedStrings.xml": `<sst><si><t>Rent</t></si><si><t>Groceries</t></si></sst>`,
      }),
    );
    const r = await extractExcerpt(f, 500);
    expect(r.excerpt).toContain("2026 Budget");
    expect(r.excerpt).toContain("Groceries");
  });

  it("extracts pdf text", async () => {
    const f = write(path.join(root, "notice.pdf"), pdf("Form I-485 Receipt Notice"));
    const r = await extractExcerpt(f, 500);
    expect(r.method).toBe("pdf");
    expect(r.excerpt).toContain("Receipt Notice");
  });

  it("reports corrupt files instead of throwing", async () => {
    const r = await extractExcerpt(write(path.join(root, "broken.docx"), "not a zip"), 500);
    expect(r.excerpt).toBe("");
    expect(r.error).toBeTruthy();
  });
});

describe("mimeOf", () => {
  it("knows common types, with overrides for installers and YAML", () => {
    expect(mimeOf("photo.HEIF")).toBe("image/heif");
    expect(mimeOf("scan.tiff")).toBe("image/tiff");
    expect(mimeOf("config.yml")).toBe("application/yaml");
    expect(mimeOf("Installer.dmg")).toBe("application/x-apple-diskimage");
    expect(mimeOf("README")).toBeNull();
  });

  it("checks the head of .ts and .pub files, which may be text or binary", () => {
    expect(mimeOf(write(path.join(root, "app.ts"), "export const answer: number = 42;\n"))).toBe("text/typescript");
    expect(mimeOf(write(path.join(root, "worker.mts"), "import os from 'node:os';\n"))).toBe("text/typescript");
    expect(mimeOf(write(path.join(root, "laptop.pub"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI me@laptop\n"))).toBe("text/plain");
    // An MPEG transport stream packet starts with sync byte 0x47 and has NUL padding.
    const packet = Buffer.alloc(188 * 30);
    for (let i = 0; i < packet.length; i += 188) packet.set([0x47, 0x40, 0x00, 0x10], i);
    expect(mimeOf(write(path.join(root, "recording.ts"), packet))).toBe("video/mp2t");
    // Microsoft Publisher files are OLE compound documents.
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
    expect(mimeOf(write(path.join(root, "flyer.pub"), ole))).toBe("application/x-mspublisher");
    // Without a readable file, only the extension tells.
    expect(mimeOf(path.join(root, "missing.ts"))).toBe("video/mp2t");
  });

  it("is used by scan with the file's path", async () => {
    write(path.join(root, "dl", "laptop.pub"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI me@laptop\n");
    const { files } = await scan(path.join(root, "dl"), { maxFiles: 10, excerptChars: 100 });
    expect(files[0]?.mime).toBe("text/plain");
  });
});

describe("extraction completeness", () => {
  it.each(["你好世界", "abcéxyz", "abc🌍xyz"])("recognizes valid UTF-8 text: %s", async (text) => {
    const file = write(path.join(root, "notes.txt"), text);
    expect(await extractExcerpt(file, 100)).toMatchObject({ method: "text", excerpt: text, complete: true });
  });

  it("accepts a bounded read ending partway through a UTF-8 character", async () => {
    const file = write(path.join(root, "notes.txt"), "a".repeat(8191) + "世界");
    const result = await extractExcerpt(file, 100);
    expect(result).toMatchObject({ method: "text", excerpt: "a".repeat(100), complete: false });
    expect(result.excerpt).not.toContain("�");
  });

  it("keeps invalid UTF-8 in the final bytes of a complete file, read as Windows-1252", async () => {
    const file = write(path.join(root, "notes.txt"), Buffer.concat([Buffer.from("plain words"), Buffer.from([0xff])]));
    expect(await extractExcerpt(file, 100)).toMatchObject({ method: "text", excerpt: "plain wordsÿ", complete: true });
  });

  it("reads Latin-1 text", async () => {
    const file = write(path.join(root, "menu.txt"), Buffer.from("Café crème brûlée", "latin1"));
    expect(await extractExcerpt(file, 100)).toMatchObject({ method: "text", excerpt: "Café crème brûlée", complete: true });
  });

  it("reads UTF-16 with a byte-order mark", async () => {
    const le = Buffer.from("Name,Amount\nRent,2400", "utf16le");
    const be = Buffer.from(le).swap16();
    for (const [name, bytes] of [["le.csv", Buffer.concat([Buffer.from([0xff, 0xfe]), le])], ["be.csv", Buffer.concat([Buffer.from([0xfe, 0xff]), be])]] as const) {
      const file = write(path.join(root, name), bytes);
      expect(await extractExcerpt(file, 100), name).toMatchObject({ method: "text", excerpt: "Name,Amount\nRent,2400", complete: true });
    }
  });

  it("still treats binary data without NUL bytes as binary", async () => {
    const bytes = Buffer.from(Array.from({ length: 600 }, (_, i) => [0x89, 0x02, 0x9c, 0x07, 0xfe, 0x03][i % 6] as number));
    expect(await extractExcerpt(write(path.join(root, "blob.dat"), bytes), 100)).toMatchObject({ method: "none", excerpt: "" });
  });

  it("does not cache an incomplete worksheet preview as the complete document", async () => {
    const file = write(path.join(root, "budget.xlsx"), await zip({
      "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      "_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      "xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Quarterly revenue</t></is></c><c r="B1"><v>250000</v></c></row></sheetData></worksheet>`,
    }));
    const result = await scan(root, { maxFiles: 10, excerptChars: 1000 });
    const entry = result.files.find((f) => f.path === file);
    expect(entry).toBeDefined();
    expect(entry?.extractError).toBeUndefined();
    // Both fixes are valid: extract the cells, or request a proper summary.
    if (entry?.complete) {
      expect(entry.excerpt).toContain("Quarterly revenue");
      expect(entry.excerpt).toContain("250000");
    } else {
      expect(entry?.needsSummary).toBe("recommended");
      expect((await loadSummaries()).has(entry!.hash!)).toBe(false);
    }
  });
});

describe("bounded reads", () => {
  it("doesn't open known binary types", async () => {
    const r = await extractExcerpt(write(path.join(root, "big.dmg"), "plain text pretending"), 100);
    expect(r).toMatchObject({ excerpt: "", skipped: "binary type" });
  });

  it("reads only the head of large text files", async () => {
    const f = write(path.join(root, "huge.log"), "line of log text\n".repeat(200_000)); // ~3.4 MB
    const open = fs.promises.open;
    let bytesRead = 0;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
      handle.read = (async (...a: unknown[]) => {
        const r = await read(...a);
        bytesRead += r.bytesRead;
        return r;
      }) as typeof handle.read;
      return handle;
    });
    const readFile = vi.spyOn(fs.promises, "readFile");
    const readFileSync = vi.spyOn(fs, "readFileSync");
    const r = await extractExcerpt(f, 100);
    expect(r.excerpt.length).toBe(100);
    expect(r.complete).toBe(false);
    expect(bytesRead).toBeGreaterThan(0);
    expect(bytesRead).toBeLessThanOrEqual(64 * 1024);
    expect(readFile).not.toHaveBeenCalled();
    expect(readFileSync.mock.calls.filter(([file]) => file === f)).toEqual([]);
  });

  it("parses a short PDF completely", async () => {
    const r = await extractExcerpt(write(path.join(root, "a.pdf"), pdf("Short notice")), 500);
    expect(r).toMatchObject({ method: "pdf", complete: true });
  });

  it("reads Chinese text in a PDF that uses a standard CJK font", async () => {
    const r = await extractExcerpt(write(path.join(root, "letter.pdf"), chinesePdf("解释信 签证")), 500);
    expect(r.excerpt.replace(/\s+/g, "")).toContain("解释信签证");
  });

  it("limits PDF parsing to the first pages", async () => {
    const pages = [1, 2, 3, 4, 5, 6, 7].map((n) => `Page ${n} marker`);
    const r = await extractExcerpt(write(path.join(root, "long.pdf"), pdf(...pages)), 10_000);
    expect(r).toMatchObject({ method: "pdf", complete: false });
    expect(r.excerpt).toContain("Page 5 marker");
    expect(r.excerpt).not.toContain("Page 6 marker");
  });
});
