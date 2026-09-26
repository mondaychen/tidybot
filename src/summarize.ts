import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { TidyError } from "./errors.js";
import { mimeOf } from "./extract.js";
import { resolvePath } from "./paths.js";
import { sensitiveByContent } from "./sensitive.js";
import { FileIndex, type Summary, SummaryInputSchema, appendSummary, loadSummaries } from "./store/summaries.js";

/** Store summaries written by an agent (or its subagents). Files are hashed by tidybot, not trusted from input. */
export async function saveSummaries(input: unknown, opts: { base: string; model?: string }): Promise<Summary[]> {
  const list = Array.isArray(input) ? input : (input as { items?: unknown })?.items;
  const parsed = z.array(SummaryInputSchema).min(1).safeParse(list);
  if (!parsed.success) throw new TidyError(`Invalid summaries: ${z.prettifyError(parsed.error)}`, "invalid_input");

  const index = new FileIndex();
  const existing = loadSummaries();
  const saved: Summary[] = [];
  for (const s of parsed.data) {
    const leak = sensitiveByContent([s.summary, ...s.keywords].join("\n"), { valuesOnly: true });
    if (leak) {
      throw new TidyError(`Summary for ${s.file ?? s.hash} looks like it contains a secret (${leak}). Describe the file without copying credentials.`, "sensitive");
    }
    let hash = s.hash;
    let name = "";
    let mime: string | null = null;
    if (s.file) {
      const file = resolvePath(s.file, opts.base);
      if (!fs.existsSync(file)) throw new TidyError(`File not found: ${s.file}`, "not_found");
      hash = await index.hashOf(file);
      name = path.basename(file);
      mime = mimeOf(file);
    } else if (hash) {
      const prev = existing.get(hash);
      if (!prev && index.pathsFor(hash).length === 0) throw new TidyError(`Unknown hash ${hash}; pass \`file\` instead.`, "not_found");
      const known = index.pathsFor(hash)[0];
      name = prev?.name ?? (known ? path.basename(known) : "");
      mime = prev?.mime ?? (known ? mimeOf(known) : null);
    }
    const record: Summary = {
      hash: hash as string,
      summary: s.summary,
      keywords: [...new Set(s.keywords.map((k) => k.toLowerCase()))],
      name,
      mime,
      source: "agent",
      model: s.model ?? opts.model,
      at: new Date().toISOString(),
    };
    appendSummary(record);
    saved.push(record);
  }
  index.save();
  return saved;
}

/** Cached summaries for specific files (by path). Hashes files as needed. */
export async function getSummaries(files: string[], base: string) {
  const index = new FileIndex();
  const summaries = loadSummaries();
  const out = [];
  for (const f of files) {
    const file = resolvePath(f, base);
    if (!fs.existsSync(file)) throw new TidyError(`File not found: ${f}`, "not_found");
    const hash = await index.hashOf(file);
    out.push({ file, hash, summary: summaries.get(hash) ?? null });
  }
  index.save();
  return out;
}

/** Every cached summary with its current known locations (for agent-side semantic search). */
export function listSummaries(opts: { includeMissing?: boolean } = {}) {
  const index = new FileIndex();
  return [...loadSummaries().values()]
    .map((s) => ({ ...s, paths: index.pathsFor(s.hash) }))
    .filter((s) => opts.includeMissing || s.paths.length > 0);
}
