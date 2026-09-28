import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractExcerpt } from "../src/extract.js";
import { scan } from "../src/scan.js";
import { loadSummaries } from "../src/store/summaries.js";
import { pdf, sandbox, write, zip } from "./helpers.js";

let root: string;
beforeEach(() => {
  vi.stubEnv("TIDYBOT_HOME", undefined);
  vi.stubEnv("TIDYBOT_NO_PROJECT", undefined);
  vi.stubEnv("TIDYBOT_PROJECT", undefined);
  root = sandbox();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
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

  it("rejects invalid UTF-8 even in the final bytes of a complete file", async () => {
    const file = write(path.join(root, "notes.txt"), Buffer.concat([Buffer.from("plain words"), Buffer.from([0xff])]));
    expect(await extractExcerpt(file, 100)).toMatchObject({ method: "none", excerpt: "", complete: false });
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
      expect(loadSummaries().has(entry!.hash!)).toBe(false);
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
    const r = await extractExcerpt(f, 100);
    expect(r.excerpt.length).toBe(100);
    expect(r.complete).toBe(false);
  });

  it("limits PDF parsing to the first pages", async () => {
    const r = await extractExcerpt(write(path.join(root, "a.pdf"), pdf("Short notice")), 500);
    expect(r).toMatchObject({ method: "pdf", complete: true });
  });
});
