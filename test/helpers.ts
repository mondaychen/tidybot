import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { onTestFinished, vi } from "vitest";

/** Fresh sandbox with its own TIDYBOT_HOME. The environment and files are restored when
 * the current test finishes, so callers need no cleanup of their own. */
export function sandbox(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tidybot-test-"));
  vi.stubEnv("TIDYBOT_HOME", path.join(root, "home"));
  vi.stubEnv("TIDYBOT_NO_PROJECT", "1");
  vi.stubEnv("TIDYBOT_PROJECT", undefined);
  onTestFinished(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

export function write(file: string, content: string | Buffer = ""): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

export async function zip(files: Record<string, string>): Promise<Buffer> {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)]))));
}

/** Minimal PDF with one page per argument, with a correct xref table. */
export function pdf(...pages: string[]): Buffer {
  const font = 3 + pages.length * 2;
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  return pdfFile([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    ...pages.flatMap((text, i) => page(4 + i * 2, font, `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`)),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

/** One-page PDF in the non-embedded STSong-Light font, as Chinese PDFs often are. Reading it
 * needs pdf.js's predefined CMaps (UniGB-UCS2-H). */
export function chinesePdf(text: string): Buffer {
  const utf16 = [...text].map((c) => (c.codePointAt(0) as number).toString(16).padStart(4, "0")).join("");
  return pdfFile([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    ...page(4, 5, `BT /F1 12 Tf 72 720 Td <${utf16}> Tj ET`),
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 7 0 R >>",
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>",
  ]);
}

/** A page object and its content stream (object `contents`), using font object `font` as /F1. */
function page(contents: number, font: number, stream: string): string[] {
  return [
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
}

function pdfFile(objects: string[]): Buffer {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Is the temp filesystem case-insensitive (default APFS/NTFS)? */
export function caseInsensitiveFs(): boolean {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tb-case-"));
  fs.writeFileSync(path.join(d, "a"), "");
  const result = fs.existsSync(path.join(d, "A"));
  fs.rmSync(d, { recursive: true });
  return result;
}
