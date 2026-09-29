// Copy pdf.js's CMaps into dist/, so published builds read CJK PDFs without pdfjs-dist at runtime.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const pdfjs = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
fs.rmSync("dist/cmaps", { recursive: true, force: true });
fs.cpSync(path.join(pdfjs, "cmaps"), "dist/cmaps", { recursive: true });
