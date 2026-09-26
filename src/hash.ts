import { createHash } from "node:crypto";
import fs from "node:fs";

/** Files above this size get a sampled hash so scanning a folder of videos stays fast. */
export const FULL_HASH_LIMIT = 64 * 1024 * 1024;
const SAMPLE = 4 * 1024 * 1024;

/**
 * Content hash used as the summary-cache key.
 * `sha256:` = whole file; `quick:` = size + first/last 4 MiB (large files only).
 */
export async function hashFile(file: string, size: number): Promise<string> {
  const h = createHash("sha256");
  if (size <= FULL_HASH_LIMIT) {
    for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
    return `sha256:${h.digest("hex")}`;
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
