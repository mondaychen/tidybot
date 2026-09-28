import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TidyError } from "../errors.js";
import { hasSpelling, identity, matches, moveFile, type FileIdentity, type PreparedMove } from "../file-move.js";
import { tidybotHome } from "../paths.js";
import { type HistoryRecord, record } from "./history.js";
import { readJson, readJsonl, repairJsonlTail, writeJson } from "./io.js";
import { loadPlan, savePlan } from "./plans.js";
import { FileIndex } from "./summaries.js";

type MoveRecord = Extract<HistoryRecord, { kind: "move" | "undo" }>;
interface Operation extends PreparedMove {
  entry: MoveRecord;
  from: string;
  to: string;
  source: FileIdentity;
}

const operationsDir = () => path.join(tidybotHome(), "operations");
const operationFile = (id: string) => path.join(operationsDir(), `${id}.json`);

/** Publish a unique claim before checking other live writers. Two simultaneous
 * claimants may both back off, but cannot both enter. Unique names make stale
 * cleanup safe: it can never unlink a new owner's claim in a replacement race. */
export function withMoveLock<T>(fn: () => T): T {
  const dir = path.join(tidybotHome(), "move-locks");
  fs.mkdirSync(dir, { recursive: true });
  const name = `${process.pid}-${randomUUID()}.lock`;
  const claim = path.join(dir, name);
  fs.closeSync(fs.openSync(claim, "wx", 0o600));
  try {
    for (const other of fs.readdirSync(dir)) {
      if (other === name) continue;
      const pid = Number(other.split("-")[0]);
      let alive = true;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (err) {
          alive = (err as NodeJS.ErrnoException).code !== "ESRCH";
        }
      }
      if (alive) throw new TidyError("Another move or recovery is running.", "busy");
      fs.rmSync(path.join(dir, other), { force: true });
    }
    return fn();
  } finally {
    fs.unlinkSync(claim);
  }
}

function finish(op: Operation): void {
  // A crash after appending history but before removing the journal is safe to replay.
  const recorded = readJsonl<HistoryRecord>(path.join(tidybotHome(), "history.jsonl"));
  if (!recorded.some((r) => r.id === op.entry.id)) record(op.entry);
  const index = new FileIndex();
  index.moved(op.from, op.to);
  index.save();
  if (op.entry.kind === "move" && op.entry.planId) {
    const plan = loadPlan(op.entry.planId);
    const item = plan.items.find((i) => i.file === op.from);
    if (item) {
      item.status = "moved";
      item.operationId = op.entry.id;
      item.note = undefined;
      savePlan(plan);
    }
  }
  if (op.backup) fs.rmSync(path.dirname(op.backup), { recursive: true, force: true });
  fs.unlinkSync(operationFile(op.entry.id));
}

/** Caller holds the move lock. Resolve incomplete operations before new moves. */
export function recoverPendingMoves(): void {
  if (!fs.existsSync(operationsDir())) return;
  repairJsonlTail(path.join(tidybotHome(), "history.jsonl"));
  for (const name of fs.readdirSync(operationsDir()).filter((n) => n.endsWith(".json"))) {
    const file = path.join(operationsDir(), name);
    const op = readJson<Operation>(file)!;
    // A staged cross-device copy may have been linked into place immediately
    // before the journal's destination identity was updated.
    if (!op.destination && op.backup && fs.existsSync(op.backup)) op.destination = identity(op.backup);
    if (op.destination && hasSpelling(op.to) && matches(op.to, op.destination) && !hasSpelling(op.from)) {
      finish(op);
      continue;
    }
    if (!hasSpelling(op.from) && op.backup && matches(op.backup, op.source)) fs.linkSync(op.backup, op.from);
    if (hasSpelling(op.from) && matches(op.from, op.source)) {
      // Interrupted before removing the source: roll back only our own copy/link.
      if (op.destination && hasSpelling(op.to) && matches(op.to, op.destination)) fs.unlinkSync(op.to);
      if (op.backup) fs.rmSync(path.dirname(op.backup), { recursive: true, force: true });
      fs.unlinkSync(file);
      continue;
    }
    throw new TidyError(`Cannot safely recover ${op.from} → ${op.to}. Recovery record: ${file}`, "recovery_required");
  }
}

/** Journal first; failures after a completed move leave enough state to recover. */
export function recordedMove(from: string, to: string, entry: MoveRecord): void {
  const op: Operation = { entry, from, to, source: identity(from) };
  const file = operationFile(entry.id);
  writeJson(file, op);
  try {
    moveFile(from, to, (state) => {
      Object.assign(op, state);
      writeJson(file, op);
    });
  } catch (err) {
    // The low-level mover rolls back ordinary errors. Recovery handles the
    // remaining cases (including an interrupted case-only rename).
    recoverPendingMoves();
    throw err;
  }
  try {
    record(entry);
  } catch (err) {
    // If history is unavailable, restore the source when possible. If rollback
    // cannot run safely, retain the journal and report the recovery location.
    try {
      moveFile(to, from);
      fs.unlinkSync(file);
    } catch {
      throw new TidyError(`Move completed but history could not be saved. Recovery record: ${file}`, "recovery_required");
    }
    throw err;
  }
  try {
    finish(op);
  } catch (err) {
    throw new TidyError(`Move recorded but metadata could not be saved (${err instanceof Error ? err.message : String(err)}). Recovery record: ${file}`, "recovery_required");
  }
}

/** Called before CLI commands, including history/undo after a process crash. */
export function recoverMoves(): void {
  if (fs.existsSync(operationsDir()) && fs.readdirSync(operationsDir()).some((n) => n.endsWith(".json"))) {
    withMoveLock(recoverPendingMoves);
  }
}
