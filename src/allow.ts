import fs from "node:fs";
import path from "node:path";
import { TidyError } from "./errors.js";
import { extractExcerpt } from "./extract.js";
import { resolvePath } from "./paths.js";
import { type FileAllowance, saveAllowance } from "./store/allowlist.js";
import { FileIndex } from "./store/summaries.js";

/** Characters read when re-checking a file's content for allowlisting (more than a typical excerpt). */
const CHECK_CHARS = 20_000;

/**
 * Allow files that sensitive-file detection flagged. Without `content`, only filename rules are
 * waived; if the file's content also trips a rule, it is refused so a real secret isn't unlocked
 * by a harmless-looking name.
 */
export async function allowFiles(
  files: string[],
  opts: { base: string; reason: string; content?: boolean; allowRules: string[] },
): Promise<{ allowed: FileAllowance[]; notFlagged: string[] }> {
  if (!opts.reason.trim()) throw new TidyError("Give a --reason (it's shown to the user in `tidybot sensitive list`).", "invalid_input");
  const index = new FileIndex();
  const disabled = new Set(opts.allowRules);
  const result: { allowed: FileAllowance[]; notFlagged: string[] } = { allowed: [], notFlagged: [] };
  const pending: FileAllowance[] = [];
  for (const f of files) {
    const file = resolvePath(f, opts.base);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new TidyError(`File not found: ${f}`, "not_found");
    const hash = await index.hashOf(file);
    const byName = await extractExcerpt(file, CHECK_CHARS, { disabled, names: false, content: true });
    const byContent = await extractExcerpt(file, CHECK_CHARS, { disabled, names: true, content: false });
    if (!byName.sensitive && !byContent.sensitive) {
      result.notFlagged.push(f);
      continue;
    }
    if (byContent.sensitive && !opts.content) {
      throw new TidyError(
        `${f}: its content matches ${byContent.sensitiveRule} (${byContent.sensitive}). Allowing it would expose that text; ` +
          "only do this with the user's explicit OK, using --content.",
        "needs_confirmation",
      );
    }
    pending.push({
      hash,
      name: path.basename(file),
      reason: opts.reason.trim(),
      content: !!opts.content,
      rule: byContent.sensitiveRule ?? byName.sensitiveRule,
      at: new Date().toISOString(),
    });
  }
  // All-or-nothing: nothing is saved if any file was refused above.
  for (const a of pending) saveAllowance(a);
  result.allowed = pending;
  index.save();
  return result;
}
