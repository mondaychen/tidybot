import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { Mime } from "mime";
import otherTypes from "mime/types/other.js";
import standardTypes from "mime/types/standard.js";
import { extensionOf } from "./names.js";
import { maskPersonal, type PersonalKind } from "./personal.js";
import { sensitiveByContent, sensitiveByName } from "./sensitive.js";
import type { Waivers } from "./store/allowlist.js";

/** mime-db's types, with a few overrides: mime-db files installers under the generic
 * application/octet-stream, and lists YAML as text/yaml rather than RFC 9512's application/yaml. */
const MIME = new Mime(standardTypes, otherTypes).define(
  {
    "application/yaml": ["yaml", "yml"],
    "application/x-apple-diskimage": ["dmg"],
    "application/vnd.apple.installer+xml": ["pkg"],
    "application/vnd.microsoft.portable-executable": ["exe"],
    "application/x-msi": ["msi"],
    "application/vnd.debian.binary-package": ["deb"],
  },
  true,
);

/** Extensions that mime-db gives a binary format but that are as often text: TypeScript (not an
 * MPEG transport stream) and SSH public keys (not Microsoft Publisher). The file's head decides. */
const TEXT_TYPES: Record<string, string> = {
  ".ts": "text/typescript",
  ".mts": "text/typescript",
  ".pub": "text/plain",
};
const TYPE_SNIFF_BYTES = 4096;

/** Type by extension. For the extensions above, give a path so the file's head can be checked. */
export function mimeOf(file: string): string | null {
  const ext = extensionOf(path.basename(file));
  const text = TEXT_TYPES[ext];
  if (text && isTextFile(file)) return text;
  return MIME.getType(ext);
}

/** False when the file can't be read: then only its extension tells. */
function isTextFile(file: string): boolean {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(TYPE_SNIFF_BYTES);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return decodeText(buf.subarray(0, n), n < buf.length) !== undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export interface Extracted {
  /** How the excerpt was obtained. */
  method: "text" | "pdf" | "docx" | "pptx" | "xlsx" | "none";
  excerpt: string;
  /** True when the excerpt is the file's entire text (short file): no summary needed. */
  complete: boolean;
  /** Hash of all the text read (more than the excerpt), when there is enough of it to compare
   * files: equal for copies saved again or by another app, whose bytes differ. */
  textHash?: string;
  /** Why the file looks like it holds credentials. Its excerpt is withheld. */
  sensitive?: string;
  /** Id of the rule that flagged it (for allowlisting). */
  sensitiveRule?: string;
  /** Why content wasn't read (too big, known binary). */
  skipped?: string;
  error?: string;
}

const SNIFF_BYTES = 8192;
/** Shorter text is too generic ("Page 1", a title) to tell that two files are copies. */
const MIN_COMPARE_CHARS = 100;
/** PDFs and Office files are parsed in memory; don't try on huge ones. */
export const MAX_DOC_BYTES = 50 * 1024 * 1024;
export const MAX_PDF_PAGES = 5;

/** Never opened for content: nothing useful to extract, and often huge. */
const BINARY_EXT = new Set(
  (
    ".dmg .pkg .mpkg .iso .img .zip .gz .tgz .bz2 .xz .zst .tar .7z .rar .xip .exe .msi .deb .rpm .apk .ipa .jar .whl " +
    ".app .bin .so .dylib .dll .o .a .class .wasm .mp4 .mov .mkv .avi .webm .m4v .wmv .flv .mp3 .wav .flac .m4a .aac .ogg .aiff " +
    ".jpg .jpeg .png .gif .heic .heif .webp .tif .tiff .bmp .ico .psd .ai .raw .cr2 .nef .arw .dng .sketch .fig " +
    ".woff .woff2 .ttf .otf .sqlite .db .parquet .pyc .doc .xls .ppt"
  ).split(" "),
);

const BOMS: [number[], string][] = [
  [[0xef, 0xbb, 0xbf], "utf-8"],
  [[0xff, 0xfe], "utf-16le"],
  [[0xfe, 0xff], "utf-16be"],
];

/** Control characters other than tab, newline, form feed and carriage return: binary data, not text. */
const CONTROL = /[\x01-\x08\x0b\x0e-\x1f]/;

/** Text in UTF-8, or UTF-16 with a byte-order mark (as Excel and Windows tools export it).
 * Other text that isn't valid UTF-8 is most likely Windows-1252 (a superset of Latin-1). */
function decodeText(sample: Buffer, whole: boolean): string | undefined {
  // Only a bounded read may end in an incomplete character. Validate every byte
  // of complete files; streaming decode holds back a partial trailing sequence.
  const decode = (encoding: string, bytes: Buffer) => {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: !whole });
    } catch {
      return undefined;
    }
  };
  const bom = BOMS.find(([mark]) => mark.every((b, i) => sample[i] === b));
  if (bom) return decode(bom[1], sample.subarray(bom[0].length));
  if (sample.includes(0)) return undefined;
  return decode("utf-8", sample) ?? (CONTROL.test(sample.toString("latin1")) ? undefined : new TextDecoder("windows-1252").decode(sample));
}

/** Read at most `max` bytes from the start of a file. */
async function readHead(file: string, max: number): Promise<Buffer> {
  const fd = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fd.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

/** Pull the text of `<tag>` elements, inserting newlines at paragraph boundaries. */
function xmlText(xml: string, tag: string, paragraphTag: string): string {
  const withBreaks = xml.replace(new RegExp(`</${paragraphTag}>`, "g"), `\n`);
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>|\\n`, "g");
  let out = "";
  for (const m of withBreaks.matchAll(re)) out += m[1] !== undefined ? decodeXml(m[1]) : "\n";
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

const byNumber = (a: string, b: string) =>
  Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0);

const SLIDE = /^ppt\/slides\/slide\d+\.xml$/;
const OFFICE_PARTS: Record<string, (name: string) => boolean> = {
  ".docx": (n) => n === "word/document.xml",
  ".pptx": (n) => SLIDE.test(n),
  ".xlsx": (n) => n === "xl/workbook.xml" || n === "xl/sharedStrings.xml",
};

/** Returns the text and whether all of the document's text was read. */
function extractOffice(buf: Buffer, ext: string, limit: number): { text: string; whole: boolean } {
  const wanted = OFFICE_PARTS[ext] as (name: string) => boolean;
  // Only the parts read below are decompressed.
  const parts = unzipSync(buf, { filter: (f) => wanted(f.name) });
  const read = (name: string) => (parts[name] ? strFromU8(parts[name]) : "");
  if (ext === ".docx") return { text: xmlText(read("word/document.xml"), "w:t", "w:p"), whole: true };
  if (ext === ".pptx") {
    const slides = Object.keys(parts).sort(byNumber);
    const texts: string[] = [];
    let len = 0;
    for (const s of slides) {
      const t = xmlText(read(s), "a:t", "a:p");
      texts.push(t);
      len += t.length;
      if (len > limit) break;
    }
    return { text: texts.join("\n---\n"), whole: texts.length === slides.length };
  }
  // xlsx: sheet names + shared strings is a cheap, representative summary.
  const sheets = [...read("xl/workbook.xml").matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decodeXml(m[1] ?? ""));
  const strings = xmlText(read("xl/sharedStrings.xml"), "t", "si");
  // Worksheet values, inline strings and formulas are not read by this preview.
  // Even a short preview must not suppress agent summarization of the workbook.
  return { text: `Sheets: ${sheets.join(", ")}\n${strings}`, whole: false };
}

/** A pdf.js data directory: dist/<name> in builds, else from pdfjs-dist, a dev dependency.
 * Under Node, pdf.js reads `<url><file>` with fs.readFile, so this is a directory path, not a
 * file: URL (unpdf's default is a file: URL, which fails to load). */
function pdfDataDir(name: string): string | undefined {
  const bundled = fileURLToPath(new URL(`${name}/`, import.meta.url));
  if (fs.existsSync(bundled)) return bundled;
  try {
    return path.join(path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), name) + path.sep;
  } catch {
    return undefined;
  }
}

/** CMaps for CJK fonts that aren't embedded; without them such text extracts as nothing. Standard
 * fonts (Dingbats, Symbol and others) that aren't embedded. unpdf bundles neither. Warnings are
 * off: pdf.js prints them to the console for broken fonts, which clutters every command. */
function pdfOptions() {
  const cMapUrl = pdfDataDir("cmaps");
  const standardFontDataUrl = pdfDataDir("standard_fonts");
  return { verbosity: 0, ...(cMapUrl ? { cMapUrl, cMapPacked: true } : {}), ...(standardFontDataUrl ? { standardFontDataUrl } : {}) };
}

/** Text of the first MAX_PDF_PAGES pages, stopping early once `limit` characters are collected. */
async function extractPdf(buf: Buffer, limit: number): Promise<{ text: string; whole: boolean }> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf), pdfOptions());
  try {
    const pages: string[] = [];
    let len = 0;
    const last = Math.min(pdf.numPages, MAX_PDF_PAGES);
    for (let i = 1; i <= last && len <= limit; i++) {
      const content = await (await pdf.getPage(i)).getTextContent();
      const text = content.items.map((it) => ("str" in it ? it.str : "")).join(" ");
      pages.push(text);
      len += text.length;
    }
    return { text: pages.join("\n"), whole: pages.length === pdf.numPages };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

const NO_WAIVERS: Waivers = { disabled: new Set(), names: false, content: false };

/** `mask`: kinds of personal data to replace with labels in the excerpt (see personal.ts). */
export async function extractExcerpt(
  file: string,
  limit: number,
  waivers: Waivers = NO_WAIVERS,
  mask: readonly PersonalKind[] = [],
): Promise<Extracted> {
  const ext = path.extname(file).toLowerCase();
  const byName = waivers.names ? undefined : sensitiveByName(file, waivers.disabled);
  if (byName) return { method: "none", excerpt: "", complete: false, sensitive: byName.reason, sensitiveRule: byName.rule };
  if (limit <= 0) return { method: "none", excerpt: "", complete: false };
  if (BINARY_EXT.has(ext)) return { method: "none", excerpt: "", complete: false, skipped: "binary type" };

  let method: Extracted["method"] = "none";
  try {
    const size = (await fs.promises.stat(file)).size;
    let text = "";
    let whole = true;
    if (ext === ".pdf" || ext === ".docx" || ext === ".pptx" || ext === ".xlsx") {
      if (size > MAX_DOC_BYTES) return { method, excerpt: "", complete: false, skipped: `larger than ${MAX_DOC_BYTES / 1024 / 1024} MB` };
      const buf = await fs.promises.readFile(file);
      method = ext.slice(1) as Extracted["method"];
      ({ text, whole } = ext === ".pdf" ? await extractPdf(buf, limit) : extractOffice(buf, ext, limit));
    } else {
      // Enough bytes for `limit` characters of (up to 4-byte) UTF-8, and at least a sniff sample.
      const head = await readHead(file, Math.max(SNIFF_BYTES, limit * 4));
      whole = head.length >= size;
      const decoded = decodeText(head, whole);
      if (decoded === undefined) return { method, excerpt: "", complete: false };
      method = "text";
      text = decoded;
    }
    const normalized = text.replace(/[ \t]+/g, " ").trim();
    // Check all the text we read, not just the excerpt, so a secret just past the cut still counts.
    const byContent = waivers.content ? undefined : await sensitiveByContent(normalized, { disabled: waivers.disabled });
    if (byContent) return { method, excerpt: "", complete: false, sensitive: byContent.reason, sensitiveRule: byContent.rule };
    // Mask before the cut, so a number that crosses it isn't shown in part.
    const masked = maskPersonal(normalized, mask);
    return {
      method,
      excerpt: masked.slice(0, limit),
      complete: masked.length > 0 && whole && masked.length <= limit,
      ...(normalized.length >= MIN_COMPARE_CHARS ? { textHash: createHash("sha256").update(normalized).digest("hex") } : {}),
    };
  } catch (err) {
    return { method, excerpt: "", complete: false, error: err instanceof Error ? err.message : String(err) };
  }
}
