import path from "node:path";
import { z } from "zod";
import { TidyError } from "../errors.js";
import { pinPath, resolvePath, settingsDir } from "../paths.js";
import { readYaml, writeYaml } from "./io.js";

export const SmartFolderSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  path: z.string().trim().min(1, "path is required").transform(pinPath),
  rule: z.string().trim().default(""),
});
export type SmartFolder = z.infer<typeof SmartFolderSchema>;

const FoldersFileSchema = z.object({ folders: z.array(SmartFolderSchema).default([]) });

const HEADER = `# tidybot smart folders. Edit freely; names and paths must be unique.
# rule: natural-language description of what belongs here (read by the AI agent).`;

/** In a project, the project's folders.yaml fully replaces the global set. */
export const foldersFile = () => path.join(settingsDir(), "folders.yaml");

export function loadFolders(file = foldersFile()): SmartFolder[] {
  const parsed = FoldersFileSchema.safeParse(readYaml(file) ?? {});
  if (!parsed.success) throw new TidyError(`Invalid ${file}: ${parsed.error.message}`);
  return parsed.data.folders;
}

export function validateFolders(folders: SmartFolder[]): void {
  const names = new Map<string, string>();
  const paths = new Map<string, string>();
  for (const f of folders) {
    const nameKey = f.name.toLowerCase();
    if (names.has(nameKey)) throw new TidyError(`Duplicate smart folder name "${f.name}"`, "duplicate");
    names.set(nameKey, f.name);
    const abs = resolvePath(f.path);
    const other = paths.get(abs);
    if (other) throw new TidyError(`Smart folders "${other}" and "${f.name}" share the path ${f.path}`, "duplicate");
    paths.set(abs, f.name);
  }
}

export function saveFolders(folders: SmartFolder[], file = foldersFile()): void {
  validateFolders(folders);
  writeYaml(file, { folders }, HEADER);
}

/** Look up by name (case-insensitive). */
export function findFolder(folders: SmartFolder[], name: string): SmartFolder | undefined {
  const key = name.trim().toLowerCase();
  return folders.find((f) => f.name.toLowerCase() === key);
}

function requireFolder(folders: SmartFolder[], name: string): SmartFolder {
  const found = findFolder(folders, name);
  if (!found) throw new TidyError(`No smart folder named "${name}"`, "not_found");
  return found;
}

export function addFolder(input: unknown): SmartFolder {
  const folder = SmartFolderSchema.parse(input);
  saveFolders([...loadFolders(), folder]);
  return folder;
}

export function updateFolder(name: string, patch: Partial<SmartFolder>): SmartFolder {
  const folders = loadFolders();
  const current = requireFolder(folders, name);
  const next = SmartFolderSchema.parse({ ...current, ...patch });
  saveFolders(folders.map((f) => (f === current ? next : f)));
  return next;
}

export function removeFolder(name: string): SmartFolder {
  const folders = loadFolders();
  const current = requireFolder(folders, name);
  saveFolders(folders.filter((f) => f !== current));
  return current;
}

export interface ImportResult {
  added: SmartFolder[];
  updated: SmartFolder[];
  folders: SmartFolder[];
}

/**
 * Merge a batch of folders (e.g. proposed by an agent during onboarding).
 * Existing folders with the same name are updated; `replace` discards everything else.
 */
export function importFolders(input: unknown, opts: { replace?: boolean; dryRun?: boolean } = {}): ImportResult {
  const list = Array.isArray(input) ? input : (input as { folders?: unknown })?.folders;
  const incoming = z.array(SmartFolderSchema).parse(list);
  const base = opts.replace ? [] : loadFolders();
  const existingNames = new Set(loadFolders().map((f) => f.name.toLowerCase()));
  const result: ImportResult = { added: [], updated: [], folders: [...base] };
  for (const folder of incoming) {
    const idx = result.folders.findIndex((f) => f.name.toLowerCase() === folder.name.toLowerCase());
    if (idx >= 0) result.folders[idx] = folder;
    else result.folders.push(folder);
    (existingNames.has(folder.name.toLowerCase()) ? result.updated : result.added).push(folder);
  }
  validateFolders(result.folders);
  if (!opts.dryRun) saveFolders(result.folders);
  return result;
}
