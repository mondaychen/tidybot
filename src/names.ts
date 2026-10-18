import fs from "node:fs";
import path from "node:path";

/** ".css" for "site.css?v=1736221786": files saved from a browser can keep the URL's query string. */
export const extensionOf = (name: string) => path.extname(name.replace(/[?#].*$/, "")).toLowerCase();

/** Most filesystems (APFS, ext4, NTFS in UTF-16 units) cap a name at 255 bytes. */
export const MAX_NAME_BYTES = 255;

/**
 * Byte length as the filesystem may store it. Measured on the NFD form, which is never shorter:
 * HFS+ and some tools decompose (é → e + ◌́), so we budget for that.
 */
export const nameBytes = (name: string) => Buffer.byteLength(name.normalize("NFD"), "utf8");

/** Truncate `stem` on grapheme boundaries so `stem + suffix` fits in MAX_NAME_BYTES. */
export function fitName(stem: string, suffix: string): string {
  const budget = MAX_NAME_BYTES - nameBytes(suffix);
  if (nameBytes(stem) <= budget) return (stem + suffix).normalize("NFC");
  let out = "";
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(stem)) {
    if (nameBytes(out + segment) > budget) break;
    out += segment;
  }
  return (out.trimEnd() + suffix).normalize("NFC");
}

/**
 * Comparison key for paths on case- and normalization-insensitive filesystems (macOS, Windows defaults).
 * Used for conflict *warnings*, so being conservative on Linux only costs an extra warning.
 */
export const pathKey = (p: string) => p.normalize("NFC").toLowerCase();

/** True if both paths exist and are the same file (e.g. they differ only by case on APFS). */
export function sameFile(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/** `name (1).ext`, `name (2).ext`, … — first that doesn't exist, still within the byte limit. */
export function availableName(target: string): string {
  const { dir, name, ext } = path.parse(target);
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, fitName(name, ` (${n})${ext}`));
    if (!fs.existsSync(candidate)) return candidate;
  }
}
