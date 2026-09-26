import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { extractExcerpt } from "../src/extract.js";
import { pdf, sandbox, write, zip } from "./helpers.js";

let root: string;
beforeEach(() => {
  root = sandbox();
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
