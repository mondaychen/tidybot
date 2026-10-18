// Copy pdf.js's CMaps and standard fonts into dist/, so published builds read CJK PDFs and PDFs
// with non-embedded standard fonts without pdfjs-dist at runtime.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const pdfjs = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
for (const dir of ["cmaps", "standard_fonts"]) {
  fs.rmSync(path.join("dist", dir), { recursive: true, force: true });
  fs.cpSync(path.join(pdfjs, dir), path.join("dist", dir), { recursive: true });
}
