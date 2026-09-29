import fs from "node:fs";
import path from "node:path";
import { TidyError } from "./errors.js";
import { pathKey } from "./names.js";

export interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export function identity(file: string): FileIdentity {
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new TidyError(`Not a regular file: ${file}`, "invalid_input");
  return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
}

export function matches(file: string, expected: FileIdentity): boolean {
  try {
    const actual = identity(file);
    return actual.dev === expected.dev && actual.ino === expected.ino && actual.size === expected.size && actual.mtimeMs === expected.mtimeMs;
  } catch {
    return false;
  }
}

function lstat(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch {
    return undefined;
  }
}

/** The same file object (device and inode), even if it has been written to since. */
export function sameInode(file: string, expected: FileIdentity): boolean {
  const st = lstat(file);
  return !!st && st.dev === expected.dev && st.ino === expected.ino;
}

/** FAT and exFAT may renumber a file when it is renamed; its size and mtime survive. */
export function sameStamp(file: string, expected: FileIdentity): boolean {
  const st = lstat(file);
  return !!st && st.dev === expected.dev && st.size === expected.size && st.mtimeMs === expected.mtimeMs;
}

/** Unlike existsSync, distinguish the two spellings of a case-only rename. */
export function hasSpelling(file: string): boolean {
  try {
    return fs.readdirSync(path.dirname(file)).some((name) => name.normalize("NFC") === path.basename(file).normalize("NFC"));
  } catch {
    return false;
  }
}

/** The path with its file name spelled as stored on disk. Case-insensitive filesystems
 * accept other spellings, but journals and history need the real name. */
export function onDiskPath(file: string): string {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return file;
    const stored = path.basename(fs.realpathSync.native(file));
    // Accept only another spelling of the same name, never a different name for the file.
    return pathKey(stored) === pathKey(path.basename(file)) ? path.join(path.dirname(file), stored) : file;
  } catch {
    return file;
  }
}

export interface PreparedMove {
  /** What `to` will hold once in place: the source itself, or a staged copy. */
  destination?: FileIdentity;
  /** A case-only rename or cross-device copy retains a staging file. */
  backup?: string;
  /** Placed by rename because the filesystem can't hard-link. */
  renamed?: boolean;
}

/** link(2) errors meaning the filesystem can't hard-link: exFAT and FAT (ENOTSUP), some
 * network shares, and Linux protected_hardlinks (EPERM). */
const NO_LINKS = new Set(["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS", "EMLINK"]);

/** Exclusively create `to` as another name for `from`. False if the filesystem can't. */
function tryLink(from: string, to: string): boolean {
  try {
    fs.linkSync(from, to);
    return true;
  } catch (err) {
    if (NO_LINKS.has((err as NodeJS.ErrnoException).code ?? "")) return false;
    throw err;
  }
}

/** Node has no no-replace rename. Without hard links, checking first narrows the race
 * with another writer to the moment between the check and the rename. */
function renameExclusive(from: string, to: string): void {
  if (fs.lstatSync(to, { throwIfNoEntry: false })) {
    throw Object.assign(new Error(`EEXIST: file already exists, rename '${from}' -> '${to}'`), { code: "EEXIST" });
  }
  fs.renameSync(from, to);
}

/** Put a held (staged) file at `to` without replacing anything. */
export function place(held: string, to: string, renamed: boolean): void {
  if (renamed) renameExclusive(held, to);
  else fs.linkSync(held, to);
}

const changed = (file: string) => new TidyError(`Source changed during move: ${file}`, "conflict");

/** Create the destination exclusively. The optional callback journals recovery
 * information before each step that changes what either name points at. */
export function moveFile(from: string, to: string, prepared: (state: PreparedMove) => void = () => {}): void {
  if (path.resolve(from) === path.resolve(to)) return;
  const source = identity(from);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (matches(to, source)) {
    if (hasSpelling(to)) throw new TidyError(`destination already exists: ${to}`, "conflict");
    renameCase(from, to, source, prepared);
    return;
  }

  let placed: FileIdentity | undefined; // What this operation put at `to`.
  let renamed = false;
  let stagingDir: string | undefined;
  const ours = () => !!placed && (renamed ? sameStamp(to, placed) : sameInode(to, placed));
  const original = () => sameInode(from, source);
  try {
    // A hard link makes `to` another name for the source. Journal that before it exists.
    prepared({ destination: source });
    let outcome: "linked" | "no links" | "cross-device";
    try {
      outcome = tryLink(from, to) ? "linked" : "no links";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      outcome = "cross-device";
    }
    if (outcome === "no links") {
      renamed = true;
      prepared({ destination: source, renamed });
      if (!matches(from, source)) throw changed(from);
      renameExclusive(from, to);
      return;
    }
    if (outcome === "linked") placed = source;
    else {
      const st = fs.statSync(from);
      stagingDir = fs.mkdtempSync(path.join(path.dirname(to), ".tidybot-move-"));
      const backup = path.join(stagingDir, "file");
      prepared({ backup, destination: undefined });
      fs.copyFileSync(from, backup, fs.constants.COPYFILE_EXCL);
      // Seconds as a number keep sub-millisecond precision; a Date would truncate to milliseconds.
      fs.utimesSync(backup, st.atimeMs / 1000, st.mtimeMs / 1000);
      const fd = fs.openSync(backup, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // The public destination only appears once the copy is complete and journaled.
      const copy = identity(backup);
      prepared({ destination: copy });
      if (!tryLink(backup, to)) {
        renamed = true;
        prepared({ destination: copy, renamed });
        renameExclusive(backup, to);
      }
      placed = copy;
    }
    if (!matches(from, source)) throw changed(from);
    fs.unlinkSync(from);
  } catch (err) {
    // Only remove what this operation put at `to`, and only while the original is still in
    // place. Never delete a competing writer's file.
    if (ours() && original()) fs.unlinkSync(to);
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new TidyError(`destination already exists: ${to}`, "conflict");
    throw err;
  } finally {
    if (stagingDir && (original() || ours())) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

/** On a case-insensitive filesystem `to` already names the source. Hold the file under a
 * private name in between, so neither final placement nor rollback can replace a file
 * created by another writer. */
function renameCase(from: string, to: string, source: FileIdentity, prepared: (state: PreparedMove) => void): void {
  const dir = fs.mkdtempSync(path.join(path.dirname(from), ".tidybot-move-"));
  const backup = path.join(dir, "file");
  let renamed = false;
  const holds = (file: string) => (renamed ? sameStamp(file, source) : sameInode(file, source));
  try {
    prepared({ backup, destination: source });
    if (tryLink(from, backup)) fs.unlinkSync(from);
    else {
      renamed = true;
      prepared({ backup, destination: source, renamed });
      fs.renameSync(from, backup);
    }
    try {
      place(backup, to, renamed);
    } catch (err) {
      try {
        place(backup, from, renamed);
      } catch {
        throw new TidyError(`Rename interrupted; original file retained at ${backup}.`, "recovery_required");
      }
      throw err;
    }
  } finally {
    if (holds(from) || holds(to)) fs.rmSync(dir, { recursive: true, force: true });
  }
}
