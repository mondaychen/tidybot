import { createHash } from "node:crypto";
import fs from "node:fs";

/** Files above this size get a sampled hash so scanning a folder of videos stays fast. */
export const FULL_HASH_LIMIT = 64 * 1024 * 1024;
const SAMPLE = 4 * 1024 * 1024;

/** Stream the entire file when equality, rather than a cache hint, is required. */
export async function fullHashFile(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return `sha256:${h.digest("hex")}`;
}

/**
 * Content hash used as the summary-cache key.
 * `sha256:` = whole file; `quick:` = size + first/last 4 MiB (large files only).
 */
export async function hashFile(file: string, size: number): Promise<string> {
  const h = createHash("sha256");
  if (size <= FULL_HASH_LIMIT) {
    return fullHashFile(file);
  }
  const fd = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(SAMPLE);
    h.update(String(size));
    const head = await fd.read(buf, 0, SAMPLE, 0);
    h.update(buf.subarray(0, head.bytesRead));
    const tail = await fd.read(buf, 0, SAMPLE, size - SAMPLE);
    h.update(buf.subarray(0, tail.bytesRead));
  } finally {
    await fd.close();
  }
  return `quick:${h.digest("hex")}`;
}

/** Byte-for-byte comparison, stopping at the first difference. False if either can't be read. */
export function sameContent(a: string, b: string): boolean {
  let fa: number | undefined;
  let fb: number | undefined;
  try {
    fa = fs.openSync(a, "r");
    fb = fs.openSync(b, "r");
    if (fs.fstatSync(fa).size !== fs.fstatSync(fb).size) return false;
    const ba = Buffer.alloc(1024 * 1024);
    const bb = Buffer.alloc(ba.length);
    for (let pos = 0; ; pos += ba.length) {
      const na = fs.readSync(fa, ba, 0, ba.length, pos);
      const nb = fs.readSync(fb, bb, 0, bb.length, pos);
      if (na !== nb || !ba.subarray(0, na).equals(bb.subarray(0, nb))) return false;
      if (na === 0) return true;
    }
  } catch {
    return false;
  } finally {
    if (fa !== undefined) fs.closeSync(fa);
    if (fb !== undefined) fs.closeSync(fb);
  }
}
