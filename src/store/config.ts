import path from "node:path";
import { z } from "zod";
import { TidyError } from "../errors.js";
import { pinPath, projectDir, tidybotHome } from "../paths.js";
import { RULE_IDS } from "../sensitive.js";
import { readYaml, writeYaml } from "./io.js";

export const RENAME_MODES = ["auto", "always", "off"] as const;

const fields = {
  /** Directory to organize when none is given on the command line. */
  source: z.string(),
  /** Max characters of extracted content per file handed to the agent. */
  excerptChars: z.number().int().min(0),
  /** Files per scan page (use --offset for the next page). */
  maxFiles: z.number().int().min(1),
  /** Characters of content shown per file in the compact scan. */
  previewChars: z.number().int().min(0),
  /** Default age filter for scans, e.g. "14d" ("" = off). Recent files are left alone. */
  olderThan: z.string().regex(/^$|^\d+(\.\d+)?\s*[hdwmy]$/i, "use e.g. 12h, 14d, 2w, 3m, 1y"),
  /** Skip files already inside a smart folder when scanning. */
  skipOrganized: z.boolean(),
  /** auto: agent renames unhelpful names and conflicts; always: every file; off: never. */
  rename: z.enum(RENAME_MODES),
  /** Naming style guidance for renames, in the user's words. */
  naming: z.string(),
  /** Moves kept in history.jsonl (0 = unlimited). Older moves can no longer be undone. */
  historyMaxMoves: z.number().int().min(0),
  /** Summaries kept in summaries.jsonl, most recently written first (0 = unlimited). */
  summariesMax: z.number().int().min(0),
  /** Extra instructions that don't belong to a single smart folder. */
  rules: z.array(z.string()),
  /** Sensitive-detection rule ids turned off (see `tidybot sensitive rules`). */
  allowRules: z.array(z.string()),
  /** Let the agent propose files to delete. Deleted files go to the trash, never straight away. */
  allowDelete: z.boolean(),
  /** Folder deleted files are moved to, instead of the system Trash / Recycle Bin ("" = system).
   * Required on Linux. Files moved here can be undone like any move. */
  trashDir: z.string(),
};

/** What a config file may contain (no defaults, so a project file only overrides what it sets). */
const RawConfigSchema = z.object(fields).partial();
type RawConfig = z.infer<typeof RawConfigSchema>;

export const ConfigSchema = z.object({
  source: fields.source.default("~/Downloads"),
  excerptChars: fields.excerptChars.default(1000),
  maxFiles: fields.maxFiles.default(500),
  previewChars: fields.previewChars.default(160),
  olderThan: fields.olderThan.default(""),
  skipOrganized: fields.skipOrganized.default(true),
  rename: fields.rename.default("auto"),
  naming: fields.naming.default(""),
  historyMaxMoves: fields.historyMaxMoves.default(0),
  summariesMax: fields.summariesMax.default(0),
  rules: fields.rules.default([]),
  allowRules: fields.allowRules.default([]),
  allowDelete: fields.allowDelete.default(true),
  trashDir: fields.trashDir.default(""),
});
export type Config = z.infer<typeof ConfigSchema>;

/** Keys settable with `config set`; list-valued `rules` has its own command. */
export const SCALAR_KEYS = [
  "source",
  "excerptChars",
  "maxFiles",
  "previewChars",
  "olderThan",
  "skipOrganized",
  "rename",
  "naming",
  "historyMaxMoves",
  "summariesMax",
  "allowDelete",
  "trashDir",
] as const;
export type ScalarKey = (typeof SCALAR_KEYS)[number];

export type Scope = "global" | "project";

function configFile(scope: Scope): string {
  if (scope === "global") return path.join(tidybotHome(), "config.yaml");
  const dir = projectDir();
  if (!dir) throw new TidyError("No project here. Create one with `tidybot init`.", "no_project");
  return path.join(dir, "config.yaml");
}

/** Where writes go by default: the project if one is active, else global. */
export const activeScope = (): Scope => (projectDir() ? "project" : "global");

function readRaw(scope: Scope): RawConfig {
  const file = configFile(scope);
  const raw = readYaml<RawConfig>(file) ?? {};
  const parsed = RawConfigSchema.safeParse(raw);
  if (!parsed.success) throw new TidyError(`Invalid ${file}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/**
 * Global settings with project overrides on top. `rules` and `allowRules` from both scopes are combined.
 * Inside a project, `source` defaults to the project root.
 */
export function loadConfig(): Config {
  const global = readRaw("global");
  const dir = projectDir();
  const project: RawConfig = dir ? { source: path.dirname(dir), ...readRaw("project") } : {};
  return ConfigSchema.parse({
    ...global,
    ...project,
    rules: [...(global.rules ?? []), ...(project.rules ?? [])],
    allowRules: [...new Set([...(global.allowRules ?? []), ...(project.allowRules ?? [])])],
  });
}

export function loadRules(): { scope: Scope; rules: string[] }[] {
  const out: { scope: Scope; rules: string[] }[] = [{ scope: "global", rules: readRaw("global").rules ?? [] }];
  if (projectDir()) out.push({ scope: "project", rules: readRaw("project").rules ?? [] });
  return out;
}

function update(scope: Scope, fn: (raw: RawConfig) => RawConfig): RawConfig {
  const next = fn(readRaw(scope));
  const parsed = RawConfigSchema.safeParse(next);
  if (!parsed.success) throw new TidyError(z.prettifyError(parsed.error), "invalid_input");
  writeYaml(configFile(scope), parsed.data);
  return parsed.data;
}

export function setConfigValue(key: string, raw: string, scope = activeScope()): Config {
  if (!SCALAR_KEYS.includes(key as ScalarKey)) {
    throw new TidyError(`Unknown config key "${key}". Known keys: ${SCALAR_KEYS.join(", ")} (use \`tidybot rules\` for rules)`);
  }
  const def = ConfigSchema.parse({})[key as ScalarKey];
  const value = typeof def === "number" ? Number(raw) : typeof def === "boolean" ? parseBool(raw) : key === "trashDir" && raw ? pinPath(raw) : raw;
  update(scope, (c) => ({ ...c, [key]: value }));
  return loadConfig();
}

export function unsetConfigValue(key: string, scope = activeScope()): Config {
  update(scope, (c) => {
    const { [key as ScalarKey]: _, ...rest } = c;
    return rest;
  });
  return loadConfig();
}

function parseBool(raw: string): boolean | string {
  if (/^(true|yes|on|1)$/i.test(raw)) return true;
  if (/^(false|no|off|0)$/i.test(raw)) return false;
  return raw; // let zod report it
}

export function addRule(text: string, scope = activeScope()): string[] {
  const rule = text.trim();
  if (!rule) throw new TidyError("Rule text is empty.", "invalid_input");
  return update(scope, (c) => ({ ...c, rules: [...(c.rules ?? []), rule] })).rules ?? [];
}

/** Remove by 1-based position within the scope's list. */
export function removeRule(position: number, scope = activeScope()): string {
  const rules = readRaw(scope).rules ?? [];
  const removed = rules[position - 1];
  if (removed === undefined) throw new TidyError(`No rule #${position} in ${scope} rules.`, "not_found");
  update(scope, (c) => ({ ...c, rules: rules.filter((_, i) => i !== position - 1) }));
  return removed;
}

/** Turn a sensitive-detection rule off (or back on) in the given scope. */
export function setRuleAllowed(id: string, allowed: boolean, scope = activeScope()): string[] {
  if (!RULE_IDS.has(id)) throw new TidyError(`Unknown rule "${id}". See \`tidybot sensitive rules\`.`, "not_found");
  const current = readRaw(scope).allowRules ?? [];
  if (!allowed && !current.includes(id)) throw new TidyError(`Rule ${id} isn't allowed in ${scope} config.`, "not_found");
  const next = allowed ? [...new Set([...current, id])] : current.filter((r) => r !== id);
  return update(scope, (c) => ({ ...c, allowRules: next })).allowRules ?? [];
}
