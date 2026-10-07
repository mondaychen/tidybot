import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TidyError } from "../errors.js";
import { type FileIdentity, type PreparedMove, hasSpelling, identity, matches, moveFile, onDiskPath, place, sameInode, sameStamp } from "../file-move.js";
import { pathKey } from "../names.js";
import { tidybotHome } from "../paths.js";
import { type HistoryRecord, record } from "./history.js";
import { readJson, readJsonl, repairJsonlTail, writeJson } from "./io.js";
import { type Plan, loadPlan, savePlan } from "./plans.js";
import { FileIndex } from "./summaries.js";

type MoveRecord = Extract<HistoryRecord, { kind: "move" | "undo" }>;
type TrashRecord = Extract<HistoryRecord, { kind: "trash" }>;
interface Operation extends PreparedMove {
  entry: MoveRecord | TrashRecord;
  from: string;
  /** "" for a file sent to the system Trash. */
  to: string;
  source: FileIdentity;
}

const operationsDir = () => path.join(tidybotHome(), "operations");
const operationFile = (id: string) => path.join(operationsDir(), `${id}.json`);
const historyFile = () => path.join(tidybotHome(), "history.jsonl");
const journals = () =>
  fs.existsSync(operationsDir()) ? fs.readdirSync(operationsDir()).filter((n) => n.endsWith(".json")).map((n) => path.join(operationsDir(), n)) : [];

// ---------------------------------------------------------------- lock

/** `<pid>-<uuid>.lock`. Anything else in the directory (Finder's .DS_Store, say) is ignored. */
const CLAIM = /^(\d+)-[0-9a-f-]+\.lock$/;
/** Allowance for clock adjustments between making a claim and checking it. */
const CLOCK_SLACK_MS = 2000;

/** When a process started (ms since the epoch), if the platform can tell. */
function processStart(pid: number): number | undefined {
  if (pid === process.pid) return Date.now() - process.uptime() * 1000;
  try {
    // Linux: field 22 of /proc/<pid>/stat is the start time in clock ticks (USER_HZ, 100/s) since boot.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    const boot = Number(/^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"))?.[1]);
    if (Number.isFinite(ticks) && Number.isFinite(boot)) return boot * 1000 + ticks * 10;
  } catch {
    /* not Linux */
  }
  try {
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const ms = Date.parse(started.trim());
    return Number.isNaN(ms) ? undefined : ms;
  } catch {
    return undefined;
  }
}

/** A claim is live while the process that made it runs. After a crash or reboot, its PID
 * may belong to an unrelated process, which must have started after the claim was made. */
function live(claim: string, pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  const started = processStart(pid);
  if (started === undefined) return true; // Can't tell; assume it is still working.
  const claimed = fs.statSync(claim, { throwIfNoEntry: false })?.mtimeMs;
  return claimed !== undefined && started <= claimed + CLOCK_SLACK_MS;
}

/** Publish a unique claim before checking other live writers. Two simultaneous
 * claimants may both back off, but cannot both enter. Unique names make stale
 * cleanup safe: it can never unlink a new owner's claim in a replacement race. */
export function withMoveLock<T>(fn: () => T): T {
  const dir = path.join(tidybotHome(), "move-locks");
  fs.mkdirSync(dir, { recursive: true });
  const name = `${process.pid}-${randomUUID()}.lock`;
  const claim = path.join(dir, name);
  fs.closeSync(fs.openSync(claim, "wx", 0o600));
  let held = false; // An async `fn` keeps the claim until it settles.
  try {
    for (const other of fs.readdirSync(dir)) {
      const pid = Number(CLAIM.exec(other)?.[1]);
      if (other === name || !pid) continue;
      const file = path.join(dir, other);
      if (live(file, pid)) {
        throw new TidyError(`Another move or recovery is running (lock: ${file}). If no tidybot process is running, delete that file.`, "busy");
      }
      fs.rmSync(file, { force: true });
    }
    const result = fn();
    if (result instanceof Promise) {
      held = true;
      return result.finally(() => fs.unlinkSync(claim)) as T;
    }
    return result;
  } finally {
    if (!held) fs.unlinkSync(claim);
  }
}

// ---------------------------------------------------------------- batches

/** Metadata for completed moves, saved once per batch. Journals are removed only after
 * history, the index and plans are saved, so recovery replays anything a crash cut short. */
export class MoveBatch {
  private readonly index = new FileIndex();
  private readonly plans = new Map<string, Plan | undefined>();
  private done: Operation[] = [];

  constructor(plan?: Plan) {
    if (plan) this.plans.set(plan.id, plan);
  }

  /** Call once the operation's history record is written. */
  complete(op: Operation): void {
    const { entry } = op;
    if (entry.kind === "trash") this.index.forget(op.from);
    else this.index.moved(op.from, op.to, op.source, op.destination ?? op.source);
    if (entry.kind !== "undo" && entry.planId) {
      const item = this.plan(entry.planId)?.items.find((i) => i.file === entry.from);
      if (item) {
        item.status = entry.kind === "trash" || entry.trash ? "trashed" : "moved";
        item.operationId = entry.id;
        item.note = undefined;
      }
    }
    this.done.push(op);
  }

  private plan(id: string): Plan | undefined {
    if (!this.plans.has(id)) {
      let plan: Plan | undefined;
      try {
        plan = loadPlan(id);
      } catch {
        /* the plan was deleted since */
      }
      this.plans.set(id, plan);
    }
    return this.plans.get(id);
  }

  save(): void {
    try {
      this.index.save();
      for (const plan of this.plans.values()) if (plan) savePlan(plan);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new TidyError(`Moves were recorded but metadata could not be saved (${message}). The next tidybot command will finish them.`, "recovery_required");
    }
    for (const op of this.done) retire(op);
    this.done = [];
  }
}

function retire(op: Operation): void {
  if (op.backup) fs.rmSync(path.dirname(op.backup), { recursive: true, force: true });
  fs.unlinkSync(operationFile(op.entry.id));
}

// ---------------------------------------------------------------- recovery

function stuck(op: Operation, journal: string, cause?: unknown): TidyError {
  const why = cause instanceof Error ? ` (${cause.message})` : "";
  const copy = op.backup ? ` A copy may be held at ${op.backup}.` : "";
  return new TidyError(
    `Cannot safely recover ${op.from} → ${op.to}${why}.${copy} Check both paths, then run \`tidybot recover --abandon ${op.entry.id}\`. Recovery record: ${journal}`,
    "recovery_required",
  );
}

/** Work out how far an interrupted operation got. An incomplete one is rolled back, one
 * whose file is in place is "complete", and anything ambiguous is left for the user. */
function settle(op: Operation, journal: string): "complete" | "rolled back" {
  // Nothing is placed anywhere tidybot can see: the file either left for the Trash or it didn't.
  // It wasn't renamed in place, so its inode tells; a look-alike there means it left.
  if (op.entry.kind === "trash") return sameInode(op.from, op.source) ? "rolled back" : "complete";
  try {
    // In a case-only rename both names alias one directory entry, and only the exact
    // spelling tells them apart. Otherwise, any spelling the filesystem accepts will do.
    const caseOnly = pathKey(op.from) === pathKey(op.to);
    const at = (file: string) => (caseOnly ? hasSpelling(file) : !!fs.lstatSync(file, { throwIfNoEntry: false }));
    const same = (file: string, id: FileIdentity) => (op.renamed ? sameStamp(file, id) : sameInode(file, id));
    // Older journals recorded a staged copy's identity only after placing it.
    const destination = op.destination ?? (op.backup && fs.existsSync(op.backup) ? identity(op.backup) : undefined);
    // What sits at `to` is this operation's only if it has the identity journaled before it
    // was placed. A rename also takes the file away from the name it was renamed from, so
    // a look-alike at `to` while that name still exists belongs to someone else.
    const placed = !!destination && at(op.to) && same(op.to, destination) && !(op.renamed && at(op.backup ?? op.from));
    if (!at(op.from)) {
      if (placed) return "complete";
      if (op.backup && at(op.backup) && same(op.backup, op.source)) {
        place(op.backup, op.from, !!op.renamed); // An interrupted case-only rename.
        return "rolled back";
      }
    } else if (sameInode(op.from, op.source) || (op.renamed && sameStamp(op.from, op.source))) {
      // The original is still in place, so whatever this operation added at `to` is redundant.
      // Size and mtime only identify it where renames renumber files (FAT); there `placed` is
      // false here, so nothing is unlinked on the strength of a look-alike.
      if (placed) fs.unlinkSync(op.to);
      return "rolled back";
    }
  } catch (err) {
    throw stuck(op, journal, err);
  }
  throw stuck(op, journal);
}

/** Caller holds the move lock. Resolve interrupted operations before new moves.
 * Returns how many were resolved; throws if any need the user. */
export function recoverPendingMoves(): number {
  const files = journals();
  if (!files.length) return 0;
  repairJsonlTail(historyFile());
  const recorded = new Set(readJsonl<HistoryRecord>(historyFile()).map((r) => r.id));
  const batch = new MoveBatch();
  const unresolved: string[] = [];
  try {
    for (const file of files) {
      const op = readJson<Operation>(file) as Operation;
      try {
        if (settle(op, file) === "complete") {
          // A crash after appending history but before removing the journal is safe to replay.
          if (!recorded.has(op.entry.id)) record(op.entry);
          batch.complete(op);
        } else {
          retire(op);
        }
      } catch (err) {
        if (!(err instanceof TidyError && err.code === "recovery_required")) throw err;
        unresolved.push(err.message);
      }
    }
  } finally {
    batch.save();
  }
  if (unresolved.length) throw new TidyError(unresolved.join("\n"), "recovery_required");
  return files.length;
}

/** Journal first, so an interrupted move can be completed or rolled back. Metadata is
 * saved, and the journal retired, when the batch is saved. */
export function recordedMove(from: string, to: string, entry: MoveRecord, batch: MoveBatch): void {
  // Recovery compares case-only renames by exact spelling, so journal the name as stored.
  const op: Operation = { entry, from: onDiskPath(from), to, source: identity(from) };
  const file = operationFile(entry.id);
  writeJson(file, op);
  try {
    moveFile(op.from, to, (state) => {
      Object.assign(op, state);
      writeJson(file, op);
    });
  } catch (err) {
    // The mover undoes ordinary failures itself. This resolves anything it could not;
    // a file that did arrive is recorded below rather than lost.
    if (settle(op, file) === "rolled back") {
      retire(op);
      throw err;
    }
  }
  try {
    record(entry);
  } catch (err) {
    // If history is unavailable, restore the source when possible. If rollback
    // cannot run safely, retain the journal and report the recovery location.
    try {
      moveFile(to, op.from);
      retire(op);
    } catch {
      throw new TidyError(`Move completed but history could not be saved. Recovery record: ${file}`, "recovery_required");
    }
    throw err;
  }
  batch.complete(op);
}

/** Send a file to the system Trash, journaled first. The Trash can't be undone from here, so
 * once the file has gone it stays gone: if history can't be written, recovery records it later. */
export async function recordedTrash(from: string, entry: TrashRecord, batch: MoveBatch, send: (file: string) => Promise<void>): Promise<void> {
  const op: Operation = { entry, from: onDiskPath(from), to: "", source: identity(from) };
  const file = operationFile(entry.id);
  writeJson(file, op);
  const inPlace = () => sameInode(op.from, op.source);
  try {
    if (!matches(op.from, op.source)) throw new TidyError(`Source changed before it could be deleted: ${op.from}`, "conflict");
    await send(op.from);
    if (inPlace()) throw new TidyError("the file is still in place after moving it to the Trash");
  } catch (err) {
    if (inPlace()) {
      retire(op);
      throw err;
    }
    // The file left despite the error, so record that it was deleted.
  }
  try {
    record(entry);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TidyError(`Moved to the Trash but history could not be saved (${message}). Recovery record: ${file}`, "recovery_required");
  }
  batch.complete(op);
}

/** Before each CLI command, finish or roll back operations that a crash interrupted.
 * While another process is moving files, its journals are in use: leave them alone. */
export function recoverMoves(): void {
  if (!journals().length) return;
  try {
    withMoveLock(recoverPendingMoves);
  } catch (err) {
    if (err instanceof TidyError && err.code === "busy") return;
    throw err;
  }
}

/** Forget an operation that recovery can't resolve, once the user has checked its files.
 * Nothing on disk besides the journal is touched. */
export function abandonOperation(id: string): { id: string; from: string; to: string; backup?: string } {
  if (!/^[a-z]\w*$/i.test(id)) throw new TidyError(`Invalid operation id "${id}"`, "invalid_input");
  return withMoveLock(() => {
    const file = operationFile(id);
    const op = readJson<Operation>(file);
    if (!op) throw new TidyError(`No interrupted operation "${id}"`, "not_found");
    fs.unlinkSync(file);
    return { id, from: op.from, to: op.to, backup: op.backup };
  });
}
