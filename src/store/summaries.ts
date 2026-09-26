import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hashFile } from "../hash.js";
import { tidybotHome } from "../paths.js";
import { appendJsonl, readJson, readJsonl, writeJson } from "./io.js";

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

export function loadSummaries(): Map<string, Summary> {
  const map = new Map<string, Summary>();
  for (const s of readJsonl<Summary>(summariesFile())) map.set(s.hash, s);
  return map;
}

export function appendSummary(s: Summary): void {
  appendJsonl(summariesFile(), s);
}

interface IndexEntry {
  hash: string;
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

  moved(from: string, to: string): void {
    const e = this.entries[from];
    if (!e) return;
    delete this.entries[from];
    try {
      this.entries[to] = { ...e, mtimeMs: fs.statSync(to).mtimeMs };
    } catch {
      /* destination vanished; drop the entry */
    }
    this.dirty = true;
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

/** Simple keyword scoring. For fuzzy/semantic lookups, agents read `summary list` and judge. */
export function findSummaries(query: string, opts: { limit: number; includeMissing?: boolean }): FindHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const index = new FileIndex();
  const hits: FindHit[] = [];
  for (const s of loadSummaries().values()) {
    const keywords = s.keywords.map((k) => k.toLowerCase());
    const text = s.summary.toLowerCase();
    const name = s.name.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (keywords.includes(t)) score += 3;
      else if (keywords.some((k) => k.includes(t))) score += 2;
      if (name.includes(t)) score += 2;
      if (text.includes(t)) score += 1;
    }
    if (score === 0) continue;
    const paths = index.pathsFor(s.hash);
    if (paths.length === 0 && !opts.includeMissing) continue;
    hits.push({ hash: s.hash, score, summary: s.summary, keywords: s.keywords, name: s.name, paths });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, opts.limit);
}
