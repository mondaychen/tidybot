import fs from "node:fs";
import path from "node:path";
import MiniSearch from "minisearch";
import { z } from "zod";
import { fullHashFile, hashFile } from "../hash.js";
import { tidybotHome } from "../paths.js";
import { sensitiveByContent, sensitiveByName } from "../sensitive.js";
import { loadAllowances } from "./allowlist.js";
import { loadConfig } from "./config.js";
import { appendJsonl, readJson, readJsonl, writeJson, writeJsonl } from "./io.js";

/**
 * File summaries, keyed by content hash so they survive renames and moves.
 * Global (not per-project): the same bytes have the same summary everywhere.
 */
export const SummaryInputSchema = z
  .object({
    file: z.string().optional(),
    hash: z.string().optional(),
    summary: z.string().trim().min(1).max(2000),
    keywords: z.array(z.string().trim().min(1)).max(30).default([]),
    model: z.string().optional(),
  })
  .refine((s) => s.file || s.hash, { message: "each summary needs `file` or `hash`" });
export type SummaryInput = z.infer<typeof SummaryInputSchema>;

export interface Summary {
  hash: string;
  summary: string;
  keywords: string[];
  /** Filename when summarized (a hint; the file may have been renamed since). */
  name: string;
  mime: string | null;
  /** agent: written by an AI agent; content: the file is short, so its text is the summary. */
  source: "agent" | "content";
  model?: string;
  at: string;
}

const summariesFile = () => path.join(tidybotHome(), "summaries.jsonl");
const indexFile = () => path.join(tidybotHome(), "index.json");

export async function loadSummaries(): Promise<Map<string, Summary>> {
  const map = new Map<string, Summary>();
  for (const s of readJsonl<Summary>(summariesFile())) map.set(s.hash, s);
  const allowances = loadAllowances();
  const disabled = new Set(loadConfig().allowRules);
  // All readers (including find and --include-missing) use the current policy.
  // Do not trust a summary just because it was permitted when it was written.
  for (const [hash, s] of map) {
    const allowance = allowances[hash];
    if ((!allowance && s.source === "content" && sensitiveByName(s.name, disabled)) ||
        (!allowance?.content && (await sensitiveByContent([s.summary, ...s.keywords].join("\n"), { valuesOnly: s.source === "agent", disabled })))) {
      map.delete(hash);
    }
    // Older builds marked this partial extraction as the full spreadsheet.
    if (s.source === "content" && s.mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") map.delete(hash);
  }
  return map;
}

export function appendSummary(s: Summary): void {
  appendJsonl(summariesFile(), s);
}

/**
 * Rewrite summaries.jsonl with one record per hash (superseded records are dropped), keeping
 * only the `max` most recently written (0 = unlimited). Returns how many records were removed.
 */
export function compactSummaries(max: number): number {
  const records = readJsonl<Summary>(summariesFile());
  // A Map keeps first-insertion order, so re-insert to order by the latest write.
  const latest = new Map<string, Summary>();
  for (const s of records) {
    latest.delete(s.hash);
    latest.set(s.hash, s);
  }
  let kept = [...latest.values()];
  if (max > 0 && kept.length > max) kept = kept.slice(kept.length - max);
  const removed = records.length - kept.length;
  if (removed > 0) writeJsonl(summariesFile(), kept);
  return removed;
}

interface IndexEntry {
  hash: string;
  size: number;
  mtimeMs: number;
  /** sha256 of the whole file, once duplicate detection has verified a sampled `hash`. */
  full?: string;
}

/** Size and modification time of a file at some moment. */
interface Stamp {
  size: number;
  mtimeMs: number;
}

/**
 * path → hash cache. Avoids rehashing unchanged files (same size + mtime) and lets
 * `find` map a summary back to where the file lives now.
 */
export class FileIndex {
  private entries: Record<string, IndexEntry>;
  private dirty = false;

  constructor() {
    this.entries = readJson<Record<string, IndexEntry>>(indexFile()) ?? {};
  }

  async hashOf(file: string, st?: fs.Stats): Promise<string> {
    const stat = st ?? (await fs.promises.stat(file));
    const cached = this.entries[file];
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.hash;
    const hash = await hashFile(file, stat.size);
    this.entries[file] = { hash, size: stat.size, mtimeMs: stat.mtimeMs };
    this.dirty = true;
    return hash;
  }

  /** Hash only if already known and unchanged; never reads file contents. */
  cachedHash(file: string): string | undefined {
    const e = this.entries[file];
    if (!e) return undefined;
    try {
      const st = fs.statSync(file);
      return st.size === e.size && st.mtimeMs === e.mtimeMs ? e.hash : undefined;
    } catch {
      return undefined;
    }
  }

  /** sha256 of the entire file, for files whose `hash` is sampled. Cached while unchanged. */
  async fullHashOf(file: string): Promise<string> {
    const before = await fs.promises.stat(file);
    const e = this.entries[file];
    const current = e && e.size === before.size && e.mtimeMs === before.mtimeMs ? e : undefined;
    if (current?.full) return current.full;
    const hash = await fullHashFile(file);
    const after = await fs.promises.stat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`${file} changed while it was being hashed`);
    }
    if (current) {
      current.full = hash;
      this.dirty = true;
    }
    return hash;
  }

  /**
   * `source` is the file as it was moved, `destination` what the move put at `to`. A copy
   * across devices can get a slightly different timestamp, so the new one is recorded.
   */
  moved(from: string, to: string, source: Stamp, destination: Stamp): void {
    const e = this.entries[from];
    if (!e && this.cachedHash(to)) return; // Idempotent journal replay.
    delete this.entries[from];
    delete this.entries[to];
    try {
      const st = fs.statSync(to);
      // Never bless an old hash with a new timestamp. A source changed since it was
      // indexed, or a destination changed since the move, must be hashed again.
      const indexed = e && e.size === source.size && e.mtimeMs === source.mtimeMs;
      const unchanged = st.size === destination.size && st.mtimeMs === destination.mtimeMs;
      if (indexed && unchanged) this.entries[to] = { ...e, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      /* destination vanished; drop the entry */
    }
    this.dirty = true;
  }

  /** The file is gone (sent to the system Trash). */
  forget(file: string): void {
    if (file in this.entries) {
      delete this.entries[file];
      this.dirty = true;
    }
  }

  /** Current, verified locations of files with this hash. */
  pathsFor(hash: string): string[] {
    return Object.entries(this.entries)
      .filter(([p, e]) => e.hash === hash && this.cachedHash(p) === hash)
      .map(([p]) => p);
  }

  /** Drop entries for files that no longer exist. */
  prune(): number {
    let n = 0;
    for (const p of Object.keys(this.entries)) {
      if (!fs.existsSync(p)) {
        delete this.entries[p];
        n++;
      }
    }
    if (n) this.dirty = true;
    return n;
  }

  save(): void {
    if (this.dirty) writeJson(indexFile(), this.entries);
    this.dirty = false;
  }
}

export interface FindHit {
  hash: string;
  score: number;
  summary: string;
  keywords: string[];
  name: string;
  paths: string[];
}

const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });
/** Word segmentation that also splits Chinese and Japanese, which don't separate words with spaces. */
const tokenize = (text: string) => [...WORDS.segment(text)].filter((s) => s.isWordLike).map((s) => s.segment);

/**
 * Ranked full-text search (BM25 with prefix and fuzzy matching). Keywords count most, then the
 * filename, then the summary text. For semantic lookups, agents read `summary list` and judge.
 */
export async function findSummaries(query: string, opts: { limit: number; includeMissing?: boolean }): Promise<FindHit[]> {
  const summaries = await loadSummaries();
  const search = new MiniSearch<Summary>({
    idField: "hash",
    fields: ["keywords", "name", "summary"],
    extractField: (s, field) => (field === "keywords" ? s.keywords.join(" ") : String(s[field as keyof Summary] ?? "")),
    tokenize,
    searchOptions: { boost: { keywords: 3, name: 2 }, prefix: true, fuzzy: 0.2 },
  });
  search.addAll([...summaries.values()]);
  const index = new FileIndex();
  const hits: FindHit[] = [];
  for (const r of search.search(query)) {
    const s = summaries.get(r.id) as Summary;
    const paths = index.pathsFor(s.hash);
    if (paths.length === 0 && !opts.includeMissing) continue;
    hits.push({ hash: s.hash, score: Math.round(r.score * 100) / 100, summary: s.summary, keywords: s.keywords, name: s.name, paths });
    if (hits.length >= opts.limit) break;
  }
  return hits;
}
