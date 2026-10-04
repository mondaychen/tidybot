import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type * as Fswin from "fswin";
import picomatch from "picomatch";

/**
 * Hidden files, as the OS file browser decides. Dotfiles count everywhere; each OS adds its own
 * mechanism. Hidden entries are left out of scans and surveys unless asked for.
 */

/** Never listed, even with --include-hidden: tidybot's own state and staging directories, and
 * metadata the OS keeps for a folder (moving it would break the folder's view settings). */
const ALWAYS_SKIP = new Set([".tidybot", ".DS_Store", ".localized", "Thumbs.db", "desktop.ini"]);
const isOwnStaging = (name: string) => name.startsWith(".tidybot-move-");
export const alwaysSkipped = (name: string) => ALWAYS_SKIP.has(name) || isOwnStaging(name);

/** Names in `dir` that the OS hides, beyond dotfiles. Empty if the OS can't be asked. */
function osHidden(dir: string): Set<string> {
  switch (process.platform) {
    case "darwin":
      return flaggedHidden(dir);
    case "win32":
      return attributedHidden(dir);
    default:
      return listedHidden(dir);
  }
}

/** macOS: the UF_HIDDEN flag (`chflags hidden`), which is how Finder hides ~/Library. Node's fs.Stats
 * doesn't expose file flags, so BSD find lists them: one process per directory, not per file. The
 * full path avoids GNU find from Homebrew, which has no -flags test. */
function flaggedHidden(dir: string): Set<string> {
  const r = spawnSync("/usr/bin/find", [path.resolve(dir), "-mindepth", "1", "-maxdepth", "1", "-flags", "+hidden", "-print0"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  // find exits non-zero when an entry is unreadable, but still prints the rest.
  const out = r.stdout?.toString("utf8") ?? "";
  return new Set(out.split("\0").filter(Boolean).map((p) => path.basename(p)));
}

let fswin: typeof Fswin | null | undefined;

/** Windows: the hidden or system attribute (Explorer hides both by default). fswin is an optional
 * dependency with prebuilt binaries; without it, only dotfiles count as hidden. */
function attributedHidden(dir: string): Set<string> {
  if (fswin === undefined) {
    try {
      fswin = createRequire(import.meta.url)("fswin") as typeof Fswin | null;
    } catch {
      fswin = null;
    }
  }
  if (!fswin) return new Set();
  try {
    const entries = fswin.findSync(path.join(path.resolve(dir), "*")) ?? [];
    return new Set(entries.filter((f) => f.IS_HIDDEN || f.IS_SYSTEM).map((f) => f.LONG_NAME));
  } catch {
    return new Set();
  }
}

/** Linux desktops: a `.hidden` file listing names to hide, one per line (GNOME Files, KDE Dolphin). */
function listedHidden(dir: string): Set<string> {
  try {
    return new Set(fs.readFileSync(path.join(dir, ".hidden"), "utf8").split(/\r?\n/).filter((line) => line.trim() !== ""));
  } catch {
    return new Set();
  }
}

export interface HiddenOptions {
  /** List hidden files and folders too. */
  includeHidden?: boolean;
  /** Globs for hidden entries to list anyway: matched against the name, or against the path
   * relative to the scan root when the glob contains a slash. */
  include?: string[];
}

/**
 * Decides which entries of a directory walk are hidden. The returned function gives a test for one
 * directory's entries; the OS is asked at most once per directory.
 */
export function hiddenFilter(root: string, opts: HiddenOptions): (dir: string) => (name: string) => boolean {
  if (opts.includeHidden) return () => () => false;
  // picomatch's `basename` option would match every glob against the name, even one with a slash.
  const globs = opts.include ?? [];
  const matcher = (list: string[]) => (list.length ? picomatch(list, { dot: true, nocase: true }) : () => false);
  const byPath = matcher(globs.filter((g) => g.includes("/")));
  const byName = matcher(globs.filter((g) => !g.includes("/")));
  return (dir) => {
    let hidden: Set<string> | undefined;
    return (name) => {
      if (!name.startsWith(".") && !(hidden ??= osHidden(dir)).has(name)) return false;
      return !byName(name) && !byPath(path.relative(root, path.join(dir, name)).split(path.sep).join("/"));
    };
  };
}
