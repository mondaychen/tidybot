import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where tidybot keeps global state. Override with TIDYBOT_HOME (tests, multiple profiles). */
export function tidybotHome(): string {
  return process.env.TIDYBOT_HOME
    ? path.resolve(expandHome(process.env.TIDYBOT_HOME))
    : path.join(os.homedir(), ".tidybot");
}

export const PROJECT_DIRNAME = ".tidybot";

let scopeOverride: { global?: boolean; project?: string } = {};
/** Set from CLI flags: --global ignores any project, --project pins one. */
export function setScopeOverride(o: { global?: boolean; project?: string }): void {
  scopeOverride = o;
}

/**
 * The active project settings directory (`<dir>/.tidybot`), if any.
 * Found like git: walk up from cwd. The global home is never treated as a project.
 */
export function projectDir(): string | undefined {
  if (scopeOverride.global || process.env.TIDYBOT_NO_PROJECT === "1") return undefined;
  const pinned = scopeOverride.project ?? process.env.TIDYBOT_PROJECT;
  if (pinned) return path.join(resolvePath(pinned), PROJECT_DIRNAME);
  const globals = new Set([tidybotHome(), path.join(os.homedir(), ".tidybot")]);
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, PROJECT_DIRNAME);
    if (!globals.has(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** Directory holding settings (config, places) for the active scope. */
export function settingsDir(): string {
  return projectDir() ?? tidybotHome();
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** For paths stored in settings: keep `~` paths portable, and pin relative paths to the cwd they
 * were typed in. */
export function pinPath(p: string): string {
  return p === "~" || p.startsWith("~/") || path.isAbsolute(p) ? p : path.resolve(p);
}

/** Expand `~` and make absolute, relative to `base` (default: cwd). */
export function resolvePath(p: string, base = process.cwd()): string {
  return path.resolve(base, expandHome(p));
}

/** Pretty form for humans: replace the home directory with `~`. */
export function contractHome(p: string): string {
  const home = os.homedir();
  if (p === home) return "~";
  if (p.startsWith(home + path.sep)) return "~" + p.slice(home.length);
  return p;
}

/** True if `child` is `parent` or inside it. */
export function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
