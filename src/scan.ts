import fs from "node:fs";
import path from "node:path";
import { TidyError } from "./errors.js";
import { extractExcerpt, mimeOf } from "./extract.js";
import { isWithin, resolvePath } from "./paths.js";
import type { SmartFolder } from "./store/folders.js";
import { FileIndex, appendSummary, loadSummaries } from "./store/summaries.js";

export type SummaryNeed = "required" | "recommended";

export interface FileEntry {
  path: string;
  /** Path relative to the scanned directory; use this as the id when proposing. */
  rel: string;
  name: string;
  ext: string;
  mime: string | null;
  size: number;
  modified: string;
  hash?: string;
  excerpt?: string;
  /** The excerpt is the whole file. */
  complete?: boolean;
  extractError?: string;
  /** Likely holds credentials: no excerpt or summary is stored or shown. Suggest a password manager. */
  sensitive?: string;
  summary?: string;
  keywords?: string[];
  /** Set when no cached summary exists and one would help (required for images). */
  needsSummary?: SummaryNeed;
}

export interface ScanOptions {
  recursive?: boolean;
  maxFiles: number;
  excerptChars: number;
  /** Only files whose name matches this glob-ish pattern (supports * and ?). */
  match?: string;
  /** Don't descend into these smart folders (already organized). */
  skipFolders?: SmartFolder[];
  /** Skip hashing and the summary cache (fast listing). */
  noHash?: boolean;
}

const SKIP_DIRS = new Set(["node_modules", ".git"]);

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export function assertDir(dir: string): void {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new TidyError(`Directory ${dir} does not exist.`, "not_found");
  }
}

export function listFiles(dir: string, opts: Pick<ScanOptions, "recursive" | "maxFiles" | "match" | "skipFolders">) {
  assertDir(dir);
  const matcher = opts.match ? globToRegex(opts.match) : undefined;
  // A smart folder that contains the scan root was asked for explicitly; only skip ones below it.
  const skip = (opts.skipFolders ?? [])
    .map((f) => ({ name: f.name, abs: resolvePath(f.path) }))
    .filter((f) => !isWithin(dir, f.abs));
  const skippedFolders = new Set<string>();
  const files: FileEntry[] = [];
  let truncated = false;
  const walk = (current: string) => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        if (!opts.recursive || SKIP_DIRS.has(e.name)) continue;
        const organized = skip.find((f) => isWithin(full, f.abs));
        if (organized) skippedFolders.add(organized.name);
        else walk(full);
        continue;
      }
      if (!e.isFile() || (matcher && !matcher.test(e.name))) continue;
      if (files.length >= opts.maxFiles) {
        truncated = true;
        return;
      }
      const st = fs.statSync(full);
      files.push({
        path: full,
        rel: path.relative(dir, full),
        name: e.name,
        ext: path.extname(e.name).toLowerCase(),
        mime: mimeOf(e.name),
        size: st.size,
        modified: st.mtime.toISOString(),
      });
    }
  };
  walk(dir);
  return { files, truncated, skippedFolders: [...skippedFolders] };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const isImage = (mime: string | null) => !!mime?.startsWith("image/");

export async function scan(dir: string, opts: ScanOptions) {
  const listing = listFiles(dir, opts);
  const index = opts.noHash ? undefined : new FileIndex();
  const summaries = opts.noHash ? new Map() : loadSummaries();
  // Bounded reads keep memory flat, but PDF/Office parsing still buffers up to MAX_DOC_BYTES each.
  await mapLimit(listing.files, 4, async (f) => {
    const { excerpt, complete, error, sensitive } = await extractExcerpt(f.path, opts.excerptChars);
    if (excerpt) f.excerpt = excerpt;
    if (complete) f.complete = true;
    if (error) f.extractError = error;
    if (sensitive) f.sensitive = sensitive;
    if (!index) return;
    f.hash = await index.hashOf(f.path);
    const cached = summaries.get(f.hash);
    if (sensitive) {
      // Never surface or cache content of likely-secret files.
    } else if (cached) {
      f.summary = cached.summary;
      f.keywords = cached.keywords;
    } else if (isImage(f.mime)) {
      f.needsSummary = "required";
    } else if (complete && excerpt) {
      // Short file: its text is the summary. Cache it so `find` can see it too.
      const s = { hash: f.hash, summary: excerpt, keywords: [], name: f.name, mime: f.mime, source: "content" as const, at: new Date().toISOString() };
      appendSummary(s);
      summaries.set(f.hash, s);
    } else if (excerpt) {
      f.needsSummary = "recommended";
    }
  });
  index?.save();
  return listing;
}
