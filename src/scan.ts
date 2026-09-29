import fs from "node:fs";
import path from "node:path";
import { TidyError } from "./errors.js";
import { extractExcerpt, mimeOf } from "./extract.js";
import { contractHome, isWithin, resolvePath } from "./paths.js";
import type { SmartFolder } from "./store/folders.js";
import { loadAllowances, waiversFor } from "./store/allowlist.js";
import { loadConfig } from "./store/config.js";
import { FileIndex, appendSummary, compactSummaries, loadSummaries } from "./store/summaries.js";

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
  /** Rule id that flagged it; see `tidybot sensitive rules`. */
  sensitiveRule?: string;
  summary?: string;
  keywords?: string[];
  /** Set when no cached summary exists and one would help (required for images). */
  needsSummary?: SummaryNeed;
}

export interface ListOptions {
  recursive?: boolean;
  maxFiles: number;
  /** Skip this many matching files first (paging through big directories). */
  offset?: number;
  /** Only files whose name matches this glob-ish pattern (supports * and ?). */
  match?: string;
  /** Don't descend into these smart folders (already organized). */
  skipFolders?: SmartFolder[];
  /** Only files that arrived and were last modified before this time (ms since epoch). */
  before?: number;
}

export interface ScanOptions extends ListOptions {
  excerptChars: number;
  /** Sensitive-detection rule ids turned off in config. */
  allowRules?: string[];
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

/** Parse "14d", "2w", "12h", "3m" (months), "1y" into milliseconds. */
export function parseAge(s: string): number {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(h|d|w|m|y)$/i);
  if (!m) throw new TidyError(`Invalid age "${s}". Use e.g. 12h, 14d, 2w, 3m, 1y.`, "invalid_input");
  const unit = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3, y: 365 * 86400e3 }[(m[2] as string).toLowerCase() as "h"];
  return Number(m[1]) * unit;
}

/**
 * When a file became "recent" for the user: the later of modification and creation time.
 * Birth time catches downloads whose mtime was set to the server's (old) timestamp.
 */
const recency = (st: fs.Stats) => Math.max(st.mtimeMs, st.birthtimeMs || 0);

function makeEntry(full: string, rel: string, st: fs.Stats): FileEntry {
  const name = path.basename(full);
  return {
    path: full,
    rel,
    name,
    ext: path.extname(name).toLowerCase(),
    mime: mimeOf(name),
    size: st.size,
    modified: st.mtime.toISOString(),
  };
}

export function listFiles(dir: string, opts: ListOptions) {
  assertDir(dir);
  const matcher = opts.match ? globToRegex(opts.match) : undefined;
  // A smart folder that contains the scan root was asked for explicitly; only skip ones below it.
  const skip = (opts.skipFolders ?? [])
    .map((f) => ({ name: f.name, abs: resolvePath(f.path) }))
    .filter((f) => !isWithin(dir, f.abs));
  const skippedFolders = new Set<string>();
  const files: FileEntry[] = [];
  let skippedRecent = 0;
  let seen = 0;
  let truncated = false;
  const walk = (current: string) => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (truncated) return;
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
      const st = fs.statSync(full);
      if (opts.before !== undefined && recency(st) > opts.before) {
        skippedRecent++;
        continue;
      }
      if (seen++ < (opts.offset ?? 0)) continue;
      if (files.length >= opts.maxFiles) {
        truncated = true;
        return;
      }
      files.push(makeEntry(full, path.relative(dir, full), st));
    }
  };
  walk(dir);
  return {
    files,
    truncated,
    /** Pass as --offset to get the next page. */
    nextOffset: truncated ? (opts.offset ?? 0) + files.length : undefined,
    skippedFolders: [...skippedFolders],
    skippedRecent,
  };
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

/** Fill in excerpt, sensitivity, hash and summary state for each entry (in place). */
export async function enrich(
  files: FileEntry[],
  opts: Pick<ScanOptions, "excerptChars" | "noHash"> & { allowRules?: string[] },
): Promise<void> {
  const index = opts.noHash ? undefined : new FileIndex();
  const summaries = opts.noHash ? new Map() : loadSummaries();
  const allowances = loadAllowances();
  const disabled = new Set(opts.allowRules ?? []);
  let cachedNew = false;
  // Bounded reads keep memory flat, but PDF/Office parsing still buffers up to MAX_DOC_BYTES each.
  await mapLimit(files, 4, async (f) => {
    // Hash first: per-file allowances are keyed by content hash.
    if (index) f.hash = await index.hashOf(f.path);
    const r = await extractExcerpt(f.path, opts.excerptChars, waiversFor(f.hash, allowances, disabled));
    const { excerpt, complete, sensitive } = r;
    if (excerpt) f.excerpt = excerpt;
    if (complete) f.complete = true;
    if (r.error) f.extractError = r.error;
    if (sensitive) {
      f.sensitive = sensitive;
      f.sensitiveRule = r.sensitiveRule;
    }
    if (!f.hash) return;
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
      cachedNew = true;
    } else if (excerpt) {
      f.needsSummary = "recommended";
    }
  });
  index?.save();
  if (cachedNew) compactSummaries(loadConfig().summariesMax);
}

export interface DuplicateGroup {
  hash: string;
  size: number;
  /** Copies among the scanned files (relative paths). */
  files: string[];
  /** Identical files tidybot has seen elsewhere (e.g. already filed in a smart folder). */
  elsewhere: string[];
}

/** Group identical files (same content hash). Empty files are ignored. */
export async function findDuplicates(files: FileEntry[], index = new FileIndex()): Promise<DuplicateGroup[]> {
  const byHash = new Map<string, FileEntry[]>();
  for (const f of files) {
    if (!f.hash || f.size === 0) continue;
    byHash.set(f.hash, [...(byHash.get(f.hash) ?? []), f]);
  }
  const groups: DuplicateGroup[] = [];
  for (const [hash, group] of byHash) {
    const scanned = new Set(group.map((f) => f.path));
    const elsewhere = index.pathsFor(hash).filter((p) => !scanned.has(p));
    if (group.length + elsewhere.length < 2) continue;
    if (!hash.startsWith("quick:")) {
      groups.push({ hash, size: group[0]?.size ?? 0, files: group.map((f) => f.rel), elsewhere: elsewhere.map(contractHome) });
      continue;
    }
    // Sampling only identifies candidates. Verify every member, including indexed copies
    // outside this scan, before suggesting identical duplicates. The index keeps verified
    // hashes, so unchanged files are read in full only once.
    const candidates = [...scanned, ...elsewhere];
    const full = await mapLimit(candidates, 4, (file) => index.fullHashOf(file).catch(() => undefined));
    const verified = new Map<string, DuplicateGroup>();
    candidates.forEach((file, i) => {
      const fullHash = full[i];
      if (!fullHash) return; // A vanished, unreadable or changing candidate is not a verified duplicate.
      const match = verified.get(fullHash) ?? { hash: fullHash, size: group[0]?.size ?? 0, files: [], elsewhere: [] };
      const entry = group.find((f) => f.path === file);
      if (entry) match.files.push(entry.rel);
      else match.elsewhere.push(contractHome(file));
      verified.set(fullHash, match);
    });
    groups.push(...[...verified.values()].filter((g) => g.files.length > 0 && g.files.length + g.elsewhere.length > 1));
  }
  index.save();
  return groups.sort((a, b) => b.size - a.size);
}

export async function scan(dir: string, opts: ScanOptions) {
  const listing = listFiles(dir, opts);
  await enrich(listing.files, opts);
  return { ...listing, duplicates: opts.noHash ? [] : await findDuplicates(listing.files) };
}

/** Full details for specific files (the second step after a compact scan). */
export async function inspect(
  files: string[],
  base: string,
  opts: Pick<ScanOptions, "excerptChars"> & { allowRules?: string[] },
): Promise<FileEntry[]> {
  const entries = files.map((f) => {
    const full = resolvePath(f, base);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new TidyError(`File not found: ${f}`, "not_found");
    return makeEntry(full, path.relative(base, full), fs.statSync(full));
  });
  await enrich(entries, opts);
  return entries;
}

/**
 * Compact view for the first scan step: enough to classify most files, ~5–10x smaller than full.
 * Drops absolute paths and long excerpts; `preview` is the first `previewChars` of content.
 */
export interface CompactFile {
  rel: string;
  mime: string | null;
  size: number;
  /** YYYY-MM-DD */
  modified: string;
  summary?: string;
  keywords?: string[];
  preview?: string;
  /** More text is available via `inspect`. */
  more?: boolean;
  sensitive?: string;
  sensitiveRule?: string;
  needsSummary?: SummaryNeed;
  duplicate?: boolean;
}

export function compactEntry(f: FileEntry, previewChars: number, duplicate: boolean): CompactFile {
  const preview = f.excerpt ? (f.excerpt.length > previewChars ? `${f.excerpt.slice(0, previewChars)}…` : f.excerpt) : undefined;
  return {
    rel: f.rel,
    mime: f.mime ?? (f.ext || null),
    size: f.size,
    modified: f.modified.slice(0, 10),
    ...(f.summary ? { summary: f.summary, keywords: f.keywords } : preview ? { preview } : {}),
    ...(f.excerpt && !f.complete && !f.summary && f.excerpt.length > previewChars ? { more: true } : {}),
    ...(f.sensitive ? { sensitive: f.sensitive, sensitiveRule: f.sensitiveRule } : {}),
    ...(f.needsSummary ? { needsSummary: f.needsSummary } : {}),
    ...(duplicate ? { duplicate: true } : {}),
  };
}
