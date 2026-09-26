import path from "node:path";
import { tidybotHome } from "../paths.js";
import { readJson, writeJson } from "./io.js";

/**
 * Per-file exceptions to sensitive-file detection, keyed by content hash: if the file changes,
 * the exception no longer applies and it is checked again.
 * Rule-wide exceptions live in config (`allowRules`).
 */
export interface FileAllowance {
  hash: string;
  /** Filename when allowed (for humans reviewing the list). */
  name: string;
  reason: string;
  /** false: only filename rules are waived (content is still checked). true: every rule is waived. */
  content: boolean;
  /** The rule that flagged it at the time. */
  rule?: string;
  at: string;
}

const file = () => path.join(tidybotHome(), "allowlist.json");

export function loadAllowances(): Record<string, FileAllowance> {
  return readJson<Record<string, FileAllowance>>(file()) ?? {};
}

export function saveAllowance(a: FileAllowance): void {
  writeJson(file(), { ...loadAllowances(), [a.hash]: a });
}

export function removeAllowance(hash: string): FileAllowance | undefined {
  const all = loadAllowances();
  const removed = all[hash];
  if (removed) {
    delete all[hash];
    writeJson(file(), all);
  }
  return removed;
}

/** What detection should skip for one file. */
export interface Waivers {
  /** Rule ids turned off in config. */
  disabled: ReadonlySet<string>;
  /** Filename rules waived for this exact content. */
  names: boolean;
  /** All content rules waived for this exact content. */
  content: boolean;
}

export function waiversFor(hash: string | undefined, allowances: Record<string, FileAllowance>, disabled: ReadonlySet<string>): Waivers {
  const a = hash ? allowances[hash] : undefined;
  return { disabled, names: !!a, content: !!a?.content };
}
