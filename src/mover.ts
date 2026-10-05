import fs from "node:fs";
import path from "node:path";
import { TidyError } from "./errors.js";
import { onDiskPath } from "./file-move.js";
import { availableName, sameFile } from "./names.js";
import { loadConfig } from "./store/config.js";
import { type MoveEntry, loadMoves, newId, record, trimHistory } from "./store/history.js";
import { type Plan, targetPath } from "./store/plans.js";
import { MoveBatch, recordedMove, recordedTrash, recoverPendingMoves, withMoveLock } from "./store/operations.js";
import { isWithin } from "./paths.js";
import { moveToSystemTrash, type TrashTarget, trashTarget } from "./trash.js";
export { moveFile } from "./file-move.js";

export type ConflictPolicy = "fail" | "rename";

export interface ApplyResult {
  moved: { file: string; to: string; operationId: string }[];
  /** Deleted files. `to` is where they are in the trash folder, or null for the system Trash. */
  trashed: { file: string; to: string | null; operationId: string }[];
  failed: { file: string; error: string }[];
  wouldMove?: { file: string; to: string }[];
  wouldTrash?: string[];
}

const pendingItems = (plan: Plan) => plan.items.filter((i) => i.status === "pending" && (i.destination || i.delete));

export async function applyPlan(plan: Plan, opts: { dryRun?: boolean; onConflict?: ConflictPolicy } = {}): Promise<ApplyResult> {
  if (plan.discarded) throw new TidyError(`Plan ${plan.id} was discarded.`, "discarded");
  if (opts.dryRun) {
    // A preview moves nothing, so it needn't wait for (or be blocked by) a running move.
    const pending = pendingItems(plan);
    return {
      moved: [],
      trashed: [],
      failed: [],
      wouldMove: pending.filter((i) => !i.delete).map((i) => ({ file: i.file, to: targetPath(i) as string })),
      wouldTrash: pending.filter((i) => i.delete).map((i) => i.file),
    };
  }
  return withMoveLock(async () => {
    recoverPendingMoves();
    // Recovery may have completed a move whose plan update was interrupted.
    for (const move of loadMoves().filter((m) => m.planId === plan.id)) {
      const item = plan.items.find((i) => i.file === move.from);
      if (item) {
        item.status = move.trash ? "trashed" : "moved";
        item.operationId = move.id;
        item.note = undefined;
      }
    }
    return applyPending(plan, opts.onConflict);
  });
}

async function applyPending(plan: Plan, onConflict?: ConflictPolicy): Promise<ApplyResult> {
  const result: ApplyResult = { moved: [], trashed: [], failed: [] };
  const batch = new MoveBatch(plan);
  const config = loadConfig();
  try {
    for (const item of pendingItems(plan)) {
      try {
        if (!fs.existsSync(item.file)) throw new TidyError("file no longer exists");
        // Plans from older versions may spell the name differently from the disk.
        item.file = onDiskPath(item.file);
        if (item.delete) {
          const trashed = await trashItem(item.file, plan.id, trashTarget(config), batch);
          item.status = "trashed";
          item.operationId = trashed.operationId;
          item.note = undefined;
          result.trashed.push(trashed);
          continue;
        }
        let to = targetPath(item) as string;
        if (path.resolve(item.file) === path.resolve(to)) throw new TidyError("file is already in its destination");
        if (fs.existsSync(to) && !sameFile(item.file, to) && onConflict === "rename") to = availableName(to);
        const operationId = newId("m");
        recordedMove(item.file, to, { kind: "move", id: operationId, at: new Date().toISOString(), planId: plan.id, from: item.file, to }, batch);
        item.status = "moved";
        item.operationId = operationId;
        item.note = undefined;
        result.moved.push({ file: item.file, to, operationId });
      } catch (err) {
        item.status = "failed";
        item.note = err instanceof Error ? err.message : String(err);
        if (err instanceof TidyError && err.code === "recovery_required") throw err; // Resolve this operation before starting another move.
        result.failed.push({ file: item.file, error: item.note });
      }
    }
  } finally {
    batch.save(); // Saves the plan too. The journals cover anything before this.
  }
  if (result.moved.length || result.trashed.length) trimHistory(config.historyMaxMoves);
  return result;
}

/** Delete one file: a journaled move into the trash folder (undoable), or the system Trash. */
async function trashItem(file: string, planId: string, target: TrashTarget, batch: MoveBatch): Promise<ApplyResult["trashed"][number]> {
  const operationId = newId("m");
  const at = new Date().toISOString();
  if (target.kind === "system") {
    await recordedTrash(file, { kind: "trash", id: operationId, at, planId, from: file }, batch, moveToSystemTrash);
    return { file, to: null, operationId };
  }
  if (isWithin(file, target.dir)) throw new TidyError("file is already in the trash folder");
  // The trash folder is tidybot's, so a name clash there never fails a deletion.
  const wanted = path.join(target.dir, path.basename(file));
  const to = fs.existsSync(wanted) ? availableName(wanted) : wanted;
  recordedMove(file, to, { kind: "move", id: operationId, at, planId, from: file, to, trash: true }, batch);
  return { file, to, operationId };
}

export interface UndoResult {
  undone: { id: string; from: string; to: string }[];
  failed: { id: string; error: string }[];
}

/** Resolve undo targets: explicit ids, all moves of a plan, or the most recent batch. */
export function selectMoves(sel: { ids?: string[]; planId?: string; last?: boolean }): MoveEntry[] {
  const active = loadMoves().filter((m) => m.state === "active");
  if (sel.ids?.length) {
    const all = loadMoves();
    return sel.ids.map((id) => {
      const m = all.find((x) => x.id === id);
      if (!m) throw new TidyError(`No history entry "${id}"`, "not_found");
      if (m.state !== "active") throw new TidyError(`History entry ${id} is already ${m.state}`);
      return m;
    });
  }
  if (sel.planId) return active.filter((m) => m.planId === sel.planId);
  if (sel.last) {
    const latest = active.at(-1);
    if (!latest) return [];
    return latest.planId ? active.filter((m) => m.planId === latest.planId) : [latest];
  }
  throw new TidyError("Specify history ids, --plan <id>, or --last.");
}

export function undoMoves(moves: MoveEntry[]): UndoResult {
  return withMoveLock(() => {
    recoverPendingMoves();
    return undoSelected(moves);
  });
}

function undoSelected(moves: MoveEntry[]): UndoResult {
  const result: UndoResult = { undone: [], failed: [] };
  const batch = new MoveBatch();
  try {
    // Reverse order so chained moves unwind correctly.
    for (const m of [...moves].reverse()) {
      try {
        if (m.to === null) {
          throw new TidyError(`${path.basename(m.from)} was moved to the system Trash: restore it from there (Finder: Put Back; Recycle Bin: Restore)`);
        }
        if (!fs.existsSync(m.to)) throw new TidyError(`file is no longer at ${m.to}`);
        recordedMove(m.to, m.from, { kind: "undo", id: newId("u"), at: new Date().toISOString(), target: m.id }, batch);
        result.undone.push({ id: m.id, from: m.to, to: m.from });
      } catch (err) {
        if (err instanceof TidyError && err.code === "recovery_required") throw err;
        result.failed.push({ id: m.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    batch.save();
  }
  if (result.undone.length) trimHistory(loadConfig().historyMaxMoves);
  return result;
}

/** Drop a history entry that can't be undone (e.g. the file was deleted), so it stops showing as active. */
export function forgetMove(id: string): MoveEntry {
  // History is rewritten below; a concurrent move's append must not be lost.
  return withMoveLock(() => {
    const m = loadMoves().find((x) => x.id === id);
    if (!m) throw new TidyError(`No history entry "${id}"`, "not_found");
    if (m.state !== "active") throw new TidyError(`History entry ${id} is already ${m.state}`);
    record({ kind: "forget", id: newId("f"), at: new Date().toISOString(), target: id });
    trimHistory(loadConfig().historyMaxMoves);
    return { ...m, state: "forgotten" };
  });
}

/** Apply `historyMaxMoves` now. Rewrites history, so it waits for no move to be running. */
export function compactHistory(max: number): number {
  return withMoveLock(() => trimHistory(max));
}
