import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { sensitiveByContent, sensitiveByName } from "./sensitive.js";
import type { Waivers } from "./store/allowlist.js";

/** Small built-in table; enough to give the agent a type hint without another dependency. */
const MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".log": "text/plain",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".dmg": "application/x-apple-diskimage",
  ".pkg": "application/vnd.apple.installer+xml",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".msi": "application/x-msi",
  ".deb": "application/vnd.debian.binary-package",
  ".epub": "application/epub+zip",
  ".ics": "text/calendar",
  ".eml": "message/rfc822",
};

export function mimeOf(file: string): string | null {
  return MIME[path.extname(file).toLowerCase()] ?? null;
}

export interface Extracted {
  /** How the excerpt was obtained. */
  method: "text" | "pdf" | "docx" | "pptx" | "xlsx" | "none";
  excerpt: string;
  /** True when the excerpt is the file's entire text (short file): no summary needed. */
  complete: boolean;
  /** Why the file looks like it holds credentials. Its excerpt is withheld. */
  sensitive?: string;
  /** Id of the rule that flagged it (for allowlisting). */
  sensitiveRule?: string;
  /** Why content wasn't read (too big, known binary). */
  skipped?: string;
  error?: string;
}

const SNIFF_BYTES = 8192;
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

function decodeText(sample: Buffer, whole: boolean): string | undefined {
  if (sample.includes(0)) return undefined;
  // Only a bounded read may end in an incomplete character. Validate every byte
  // of complete files; streaming decode holds back a partial trailing sequence.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: !whole });
  } catch {
    return undefined;
  }
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

/** Returns the text and whether all of the document's text was read. */
async function extractOffice(buf: Buffer, ext: string, limit: number): Promise<{ text: string; whole: boolean }> {
  const zip = await JSZip.loadAsync(buf);
  const read = (name: string) => zip.file(name)?.async("string") ?? Promise.resolve("");
  if (ext === ".docx") return { text: xmlText(await read("word/document.xml"), "w:t", "w:p"), whole: true };
  if (ext === ".pptx") {
    const slides = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort(byNumber);
    const parts: string[] = [];
    let len = 0;
    for (const s of slides) {
      const t = xmlText(await read(s), "a:t", "a:p");
      parts.push(t);
      len += t.length;
      if (len > limit) break;
    }
    return { text: parts.join("\n---\n"), whole: parts.length === slides.length };
  }
  // xlsx: sheet names + shared strings is a cheap, representative summary.
  const sheets = [...(await read("xl/workbook.xml")).matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decodeXml(m[1] ?? ""));
  const strings = xmlText(await read("xl/sharedStrings.xml"), "t", "si");
  // Worksheet values, inline strings and formulas are not read by this preview.
  // Even a short preview must not suppress agent summarization of the workbook.
  return { text: `Sheets: ${sheets.join(", ")}\n${strings}`, whole: false };
}

/** Text of the first MAX_PDF_PAGES pages, stopping early once `limit` characters are collected. */
async function extractPdf(buf: Buffer, limit: number): Promise<{ text: string; whole: boolean }> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
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

export async function extractExcerpt(file: string, limit: number, waivers: Waivers = NO_WAIVERS): Promise<Extracted> {
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
      ({ text, whole } = ext === ".pdf" ? await extractPdf(buf, limit) : await extractOffice(buf, ext, limit));
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
    const byContent = waivers.content ? undefined : sensitiveByContent(normalized, { disabled: waivers.disabled });
    if (byContent) return { method, excerpt: "", complete: false, sensitive: byContent.reason, sensitiveRule: byContent.rule };
    return {
      method,
      excerpt: normalized.slice(0, limit),
      complete: normalized.length > 0 && whole && normalized.length <= limit,
    };
  } catch (err) {
    return { method, excerpt: "", complete: false, error: err instanceof Error ? err.message : String(err) };
  }
}
