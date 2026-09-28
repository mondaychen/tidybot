import fs from "node:fs";
import path from "node:path";
import { TidyError } from "./errors.js";

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

/** Unlike existsSync, distinguish the two spellings of a case-only rename. */
export function hasSpelling(file: string): boolean {
  try {
    return fs.readdirSync(path.dirname(file)).some((name) => name.normalize("NFC") === path.basename(file).normalize("NFC"));
  } catch {
    return false;
  }
}

export interface PreparedMove {
  destination?: FileIdentity;
  /** A case-only rename or cross-device copy retains a staging file. */
  backup?: string;
}

/** Create the destination exclusively. The optional callback journals recovery
 * information before the source name is removed. */
export function moveFile(from: string, to: string, prepared: (state: PreparedMove) => void = () => {}): void {
  if (path.resolve(from) === path.resolve(to)) return;
  const source = identity(from);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (matches(to, source)) {
    if (hasSpelling(to)) throw new TidyError(`destination already exists: ${to}`, "conflict");
    // The destination aliases the source on a case-insensitive filesystem.
    // Retain another link before unlinking the old spelling; neither final
    // installation nor rollback may replace a file created by another writer.
    const dir = fs.mkdtempSync(path.join(path.dirname(from), ".tidybot-move-"));
    const backup = path.join(dir, "file");
    try {
      prepared({ backup, destination: source });
      fs.linkSync(from, backup);
      fs.unlinkSync(from);
      try {
        fs.linkSync(backup, to);
      } catch (err) {
        try {
          fs.linkSync(backup, from);
        } catch {
          throw new TidyError(`Rename interrupted; original file retained at ${backup}.`, "recovery_required");
        }
        throw err;
      }
    } finally {
      if (matches(from, source) || matches(to, source)) fs.rmSync(dir, { recursive: true, force: true });
    }
    return;
  }

  let destination: FileIdentity | undefined;
  let stagingDir: string | undefined;
  try {
    try {
      fs.linkSync(from, to); // Atomic no-replace, including dangling symlinks.
      destination = identity(to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      const st = fs.statSync(from);
      stagingDir = fs.mkdtempSync(path.join(path.dirname(to), ".tidybot-move-"));
      const backup = path.join(stagingDir, "file");
      prepared({ backup });
      fs.copyFileSync(from, backup, fs.constants.COPYFILE_EXCL);
      fs.utimesSync(backup, st.atime, st.mtime);
      const fd = fs.openSync(backup, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // The public destination only appears once the copy is complete.
      fs.linkSync(backup, to);
      destination = identity(to);
    }
    if (!matches(from, source)) throw new TidyError(`Source changed during move: ${from}`, "conflict");
    prepared({ destination });
    fs.unlinkSync(from);
  } catch (err) {
    // Only remove the destination that this operation created, and only while
    // the original still exists. Never delete a competing writer's file.
    if (destination && matches(from, source) && matches(to, destination)) fs.unlinkSync(to);
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new TidyError(`destination already exists: ${to}`, "conflict");
    throw err;
  } finally {
    if (stagingDir && (matches(from, source) || (destination && matches(to, destination)))) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }
}
