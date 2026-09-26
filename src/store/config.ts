import path from "node:path";
import { z } from "zod";
import { TidyError } from "../errors.js";
import { projectDir, tidybotHome } from "../paths.js";
import { readYaml, writeYaml } from "./io.js";

export const RENAME_MODES = ["auto", "always", "off"] as const;

const fields = {
  /** Directory to organize when none is given on the command line. */
  source: z.string(),
  /** Max characters of extracted content per file handed to the agent. */
  excerptChars: z.number().int().min(0),
  /** Safety cap on files per scan. */
  maxFiles: z.number().int().min(1),
  /** Skip files already inside a smart folder when scanning. */
  skipOrganized: z.boolean(),
  /** auto: agent renames unhelpful names and conflicts; always: every file; off: never. */
  rename: z.enum(RENAME_MODES),
  /** Naming style guidance for renames, in the user's words. */
  naming: z.string(),
  /** Extra instructions that don't belong to a single smart folder. */
  rules: z.array(z.string()),
};

/** What a config file may contain (no defaults, so a project file only overrides what it sets). */
const RawConfigSchema = z.object(fields).partial();
type RawConfig = z.infer<typeof RawConfigSchema>;

export const ConfigSchema = z.object({
  source: fields.source.default("~/Downloads"),
  excerptChars: fields.excerptChars.default(1000),
  maxFiles: fields.maxFiles.default(200),
  skipOrganized: fields.skipOrganized.default(true),
  rename: fields.rename.default("auto"),
  naming: fields.naming.default(""),
  rules: fields.rules.default([]),
});
export type Config = z.infer<typeof ConfigSchema>;

/** Keys settable with `config set`; list-valued `rules` has its own command. */
export const SCALAR_KEYS = ["source", "excerptChars", "maxFiles", "skipOrganized", "rename", "naming"] as const;
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
 * Global settings with project overrides on top. `rules` from both scopes are combined.
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
  const value = typeof def === "number" ? Number(raw) : typeof def === "boolean" ? parseBool(raw) : raw;
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
