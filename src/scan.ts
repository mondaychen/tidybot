import fs from "node:fs";
import path from "node:path";
import pMap from "p-map";
import picomatch from "picomatch";
import { TidyError } from "./errors.js";
import { extractExcerpt, mimeOf } from "./extract.js";
import { alwaysSkipped, type HiddenOptions, hiddenFilter } from "./hidden.js";
import { contractHome, isWithin, resolvePath } from "./paths.js";
import type { Place } from "./store/places.js";
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
  /** Hash of the extracted text, to find copies whose bytes differ (see `findSimilar`). */
  textHash?: string;
  /** Likely holds credentials: no excerpt or summary is stored or shown. Suggest a password manager. */
  sensitive?: string;
  /** Rule id that flagged it; see `tidybot sensitive rules`. */
  sensitiveRule?: string;
  summary?: string;
  keywords?: string[];
  /** Set when no cached summary exists and one would help (required for images; recommended for long or text-less documents). */
  needsSummary?: SummaryNeed;
}

export interface ListOptions extends HiddenOptions {
  recursive?: boolean;
  maxFiles: number;
  /** Skip this many matching files first (paging through big directories). */
  offset?: number;
  /** Only files whose name matches this glob, e.g. `*.pdf` or `*.{jpg,png}` (case-insensitive). */
  match?: string;
  /** Don't descend into these places (already organized). */
  skipPlaces?: Place[];
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

/** Archive types that unzip tools extract into a folder of the same name, longest first. */
const ARCHIVE_EXT = [".tar.gz", ".tar.bz2", ".tar.xz", ".zip", ".7z", ".rar", ".tar", ".tgz", ".xip"];

/** "photos.zip" → "photos"; undefined for a file that isn't an archive. */
export function archiveStem(name: string): string | undefined {
  const ext = ARCHIVE_EXT.find((e) => name.toLowerCase().endsWith(e));
  return ext && name.length > ext.length ? name.slice(0, -ext.length) : undefined;
}

/** An archive next to the folder it was extracted into. One of them is usually redundant. */
export interface ExtractedArchive {
  /** Relative path of the archive file. */
  archive: string;
  /** Relative path of the folder. */
  dir: string;
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
    mime: mimeOf(full),
    size: st.size,
    modified: st.mtime.toISOString(),
  };
}

export function listFiles(dir: string, opts: ListOptions) {
  assertDir(dir);
  const matcher = opts.match ? picomatch(opts.match, { nocase: true, dot: true }) : undefined;
  // A place that contains the scan root was asked for explicitly; only skip ones below it.
  const skip = (opts.skipPlaces ?? [])
    .map((f) => ({ name: f.name, abs: resolvePath(f.path) }))
    .filter((f) => !isWithin(dir, f.abs));
  const skippedPlaces = new Set<string>();
  const hiddenIn = hiddenFilter(dir, opts);
  const files: FileEntry[] = [];
  const unreadable: string[] = [];
  const skippedDirs: string[] = [];
  const extractedArchives: ExtractedArchive[] = [];
  let skippedRecent = 0;
  let skippedHidden = 0;
  let seen = 0;
  let truncated = false;
  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      // A subdirectory the user can't read (e.g. ~/.Trash without Full Disk Access) shouldn't end the scan.
      const code = (err as NodeJS.ErrnoException).code;
      if (current === dir || (code !== "EACCES" && code !== "EPERM")) throw err;
      unreadable.push(path.relative(dir, current));
      return;
    }
    const hidden = hiddenIn(current);
    const visible = entries.filter((e) => !alwaysSkipped(e.name) && !hidden(e.name));
    const dirNames = new Set(visible.filter((e) => e.isDirectory()).map((e) => e.name));
    for (const e of visible) {
      const stem = e.isFile() ? archiveStem(e.name) : undefined;
      if (stem && dirNames.has(stem)) {
        extractedArchives.push({ archive: path.relative(dir, path.join(current, e.name)), dir: path.relative(dir, path.join(current, stem)) });
      }
    }
    for (const e of entries) {
      if (truncated) return;
      if (alwaysSkipped(e.name)) continue;
      const full = path.join(current, e.name);
      // Without -r, say which subfolders were left out, so they aren't mistaken for missing files.
      if (e.isDirectory() && !opts.recursive && !hidden(e.name)) {
        const organized = skip.find((f) => isWithin(full, f.abs));
        if (organized) skippedPlaces.add(organized.name);
        else skippedDirs.push(path.relative(dir, full));
        continue;
      }
      // Only count hidden entries that would otherwise be listed or descended into.
      const listable = e.isDirectory() ? opts.recursive && !SKIP_DIRS.has(e.name) : e.isFile() && (!matcher || matcher(e.name));
      if (!listable) continue;
      if (hidden(e.name)) {
        skippedHidden++;
        continue;
      }
      if (e.isDirectory()) {
        const organized = skip.find((f) => isWithin(full, f.abs));
        if (organized) skippedPlaces.add(organized.name);
        else walk(full);
        continue;
      }
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
    skippedPlaces: [...skippedPlaces],
    skippedRecent,
    /** Hidden files and folders left out (see `includeHidden` and `include`). */
    skippedHidden,
    /** Subdirectories that couldn't be read, relative to `dir`. */
    unreadable,
    /** Subdirectories left out because the scan isn't recursive. */
    skippedDirs,
    extractedArchives,
  };
}

export const isImage = (mime: string | null) => !!mime?.startsWith("image/");

/** Fill in excerpt, sensitivity, hash and summary state for each entry (in place). */
export async function enrich(
  files: FileEntry[],
  opts: Pick<ScanOptions, "excerptChars" | "noHash"> & { allowRules?: string[] },
): Promise<void> {
  const index = opts.noHash ? undefined : new FileIndex();
  const summaries = opts.noHash ? new Map() : await loadSummaries();
  const allowances = loadAllowances();
  const disabled = new Set(opts.allowRules ?? []);
  let cachedNew = false;
  // Bounded reads keep memory flat, but PDF/Office parsing still buffers up to MAX_DOC_BYTES each.
  await pMap(files, async (f) => {
    // Hash first: per-file allowances are keyed by content hash.
    if (index) f.hash = await index.hashOf(f.path);
    const r = await extractExcerpt(f.path, opts.excerptChars, waiversFor(f.hash, allowances, disabled));
    const { excerpt, complete, sensitive } = r;
    if (excerpt) f.excerpt = excerpt;
    if (complete) f.complete = true;
    if (r.textHash) f.textHash = r.textHash;
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
    } else if (r.method !== "none" && r.method !== "text" && !r.error) {
      // A document that parsed but has no text, such as a scanned PDF: only viewing it tells what it is.
      f.needsSummary = "recommended";
    }
  }, { concurrency: 4 });
  index?.save();
  if (cachedNew) compactSummaries(loadConfig().summariesMax);
}

export interface DuplicateGroup {
  hash: string;
  size: number;
  /** Copies among the scanned files (relative paths). */
  files: string[];
  /** Identical files tidybot has seen elsewhere (e.g. already filed in a place). */
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
    const full = await pMap(candidates, (file) => index.fullHashOf(file).catch(() => undefined), { concurrency: 4 });
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

/** Files that are probably copies of each other, but not byte for byte. */
export interface SimilarGroup {
  /** "same text": same extracted text. "same name": same name apart from a copy marker such as
   * " (1)", " copy" or "-2". "same size": same type and exact size (large files only). */
  why: "same text" | "same name" | "same size";
  /** Relative paths. */
  files: string[];
}

/** Browser and Finder copy markers: "x (1)", "x copy", "x copy 2", "x - Copy", "x - Copy (2)". */
const COPY_MARK = /(?: \(\d+\)| copy(?: \d+)?| - copy(?: \(\d+\))?)$/i;
/** "x-2", "x_2", "x 2": also used for versions and parts, so it only counts next to a plain "x". */
const NUMBER_MARK = /[-_ ]\d{1,2}$/;
/** Same size counts only for files this big; small files share sizes by chance. */
const SAME_SIZE_MIN = 64 * 1024;

/**
 * Groups of probable copies that `findDuplicates` misses because their bytes differ: saved
 * again, downloaded twice from a site that stamps each download, or exported once more. Hints
 * for the agent to check, not proof: they are never identical.
 */
export function findSimilar(files: FileEntry[]): SimilarGroup[] {
  const groups: SimilarGroup[] = [];
  const add = (why: SimilarGroup["why"], members: FileEntry[]) => {
    if (members.length < 2) return;
    // Identical bytes are already a duplicate group.
    if (members.every((m) => m.hash && m.hash === members[0]?.hash)) return;
    const rels = members.map((m) => m.rel);
    // A stronger signal already grouped these files.
    if (groups.some((g) => rels.every((r) => g.files.includes(r)))) return;
    groups.push({ why, files: rels });
  };
  const groupBy = (key: (f: FileEntry) => string | undefined) => {
    const map = new Map<string, FileEntry[]>();
    for (const f of files) {
      const k = key(f);
      if (k !== undefined) map.set(k, [...(map.get(k) ?? []), f]);
    }
    return [...map.values()];
  };

  for (const g of groupBy((f) => f.textHash)) add("same text", g);

  const stem = (f: FileEntry) => path.basename(f.name, path.extname(f.name)).normalize("NFC").toLowerCase();
  const plain = new Set(files.map((f) => `${f.ext}\0${stem(f)}`));
  const marked = new Set<FileEntry>();
  const nameKey = (f: FileEntry) => {
    const s = stem(f);
    const base = s.replace(COPY_MARK, "");
    const numbered = s.replace(NUMBER_MARK, "");
    const key = base !== s ? base : numbered !== s && plain.has(`${f.ext}\0${numbered}`) ? numbered : s;
    if (key !== s) marked.add(f);
    return `${f.ext}\0${key}`;
  };
  // Same-named files in different subfolders (with -r) aren't copies by name alone.
  for (const g of groupBy(nameKey)) if (g.some((f) => marked.has(f))) add("same name", g);

  for (const g of groupBy((f) => (f.size >= SAME_SIZE_MIN && f.hash ? `${f.mime}\0${f.size}` : undefined))) add("same size", g);
  return groups;
}

export async function scan(dir: string, opts: ScanOptions) {
  const listing = listFiles(dir, opts);
  await enrich(listing.files, opts);
  return { ...listing, duplicates: opts.noHash ? [] : await findDuplicates(listing.files), similar: findSimilar(listing.files) };
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
  /** In a `similar` group: probably a copy, but not identical. */
  similar?: boolean;
}

export function compactEntry(f: FileEntry, previewChars: number, flags: { duplicate?: boolean; similar?: boolean } = {}): CompactFile {
  const preview = f.excerpt ? (f.excerpt.length > previewChars ? `${f.excerpt.slice(0, previewChars)}…` : f.excerpt) : undefined;
  return {
    rel: f.rel,
    mime: f.mime ?? (f.ext || null),
    size: f.size,
    modified: f.modified.slice(0, 10),
    ...(f.summary ? { summary: f.summary, keywords: f.keywords } : preview ? { preview } : {}),
    // The preview is cut short: `inspect` shows the rest, even when the excerpt is the whole file.
    ...(f.excerpt && !f.summary && f.excerpt.length > previewChars ? { more: true } : {}),
    ...(f.sensitive ? { sensitive: f.sensitive, sensitiveRule: f.sensitiveRule } : {}),
    ...(f.needsSummary ? { needsSummary: f.needsSummary } : {}),
    ...(flags.duplicate ? { duplicate: true } : {}),
    ...(flags.similar ? { similar: true } : {}),
  };
}
