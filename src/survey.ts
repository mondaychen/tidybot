import fs from "node:fs";
import path from "node:path";
import { alwaysSkipped, type HiddenOptions, hiddenFilter } from "./hidden.js";
import { extensionOf } from "./names.js";
import { contractHome, resolvePath } from "./paths.js";
import { assertDir } from "./scan.js";

export interface DirSummary {
  path: string;
  depth: number;
  /** Files directly inside this directory. */
  files: number;
  /** Files in this directory and all descendants (within the walk limits). */
  totalFiles: number;
  subdirs: number;
  topExtensions: { ext: string; count: number }[];
  sampleNames: string[];
  /** Name of the place at this path, if any. */
  place?: string;
}

export interface SurveyOptions extends HiddenOptions {
  depth: number;
  samples: number;
  maxDirs: number;
  /** Places to annotate in the output. */
  places?: { name: string; path: string }[];
}

/** Never useful for proposing places. (~/Library is skipped as a hidden folder on macOS.) */
const SKIP = new Set(["node_modules", ".git", "__pycache__", ".venv"]);

/**
 * Summarize existing directory structure so an agent can propose places.
 * Returns one row per directory, breadth-limited by depth and maxDirs.
 */
export interface SurveyResult {
  root: string;
  dirs: DirSummary[];
  truncated: boolean;
  /** Which limits cut the survey short: deeper folders (raise --depth), more folders (raise --max-dirs). */
  truncatedBy: ("depth" | "maxDirs")[];
}

export function survey(root: string, opts: SurveyOptions): SurveyResult {
  assertDir(root);
  const dirs: DirSummary[] = [];
  const truncatedBy = new Set<SurveyResult["truncatedBy"][number]>();
  const placeAt = new Map((opts.places ?? []).map((f) => [resolvePath(f.path), f.name]));
  const hiddenIn = hiddenFilter(root, opts);

  const visit = (dir: string, depth: number): number => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    const hidden = hiddenIn(dir);
    const visible = entries.filter((e) => !alwaysSkipped(e.name) && !hidden(e.name));
    const fileNames = visible.filter((e) => e.isFile()).map((e) => e.name);
    const subdirs = visible.filter((e) => e.isDirectory() && !SKIP.has(e.name));
    const exts = new Map<string, number>();
    for (const n of fileNames) {
      const ext = extensionOf(n) || "(none)";
      exts.set(ext, (exts.get(ext) ?? 0) + 1);
    }
    const row: DirSummary | undefined =
      dirs.length < opts.maxDirs
        ? {
            path: contractHome(dir),
            depth,
            files: fileNames.length,
            totalFiles: fileNames.length,
            subdirs: subdirs.length,
            topExtensions: [...exts.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([ext, count]) => ({ ext, count })),
            sampleNames: fileNames.slice(0, opts.samples),
            ...(placeAt.has(dir) ? { place: placeAt.get(dir) } : {}),
          }
        : undefined;
    if (row) dirs.push(row);
    else truncatedBy.add("maxDirs");

    let total = fileNames.length;
    if (depth < opts.depth) {
      for (const sub of subdirs.sort((a, b) => a.name.localeCompare(b.name))) total += visit(path.join(dir, sub.name), depth + 1);
    } else if (subdirs.length > 0) {
      truncatedBy.add("depth");
    }
    if (row) row.totalFiles = total;
    return total;
  };

  visit(root, 0);
  return { root: contractHome(root), dirs, truncated: truncatedBy.size > 0, truncatedBy: [...truncatedBy] };
}
