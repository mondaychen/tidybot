import fs from "node:fs";
import path from "node:path";
import { TidyError } from "./errors.js";
import { onDiskPath } from "./file-move.js";
import { availableName, sameFile } from "./names.js";
import { loadConfig } from "./store/config.js";
import { type MoveEntry, loadMoves, newId, record, trimHistory } from "./store/history.js";
import { type Plan, targetPath } from "./store/plans.js";
import { MoveBatch, recordedMove, recoverPendingMoves, withMoveLock } from "./store/operations.js";
export { moveFile } from "./file-move.js";

export type ConflictPolicy = "fail" | "rename";

export interface ApplyResult {
  moved: { file: string; to: string; operationId: string }[];
  failed: { file: string; error: string }[];
  wouldMove?: { file: string; to: string }[];
}

export function applyPlan(plan: Plan, opts: { dryRun?: boolean; onConflict?: ConflictPolicy } = {}): ApplyResult {
  if (plan.discarded) throw new TidyError(`Plan ${plan.id} was discarded.`, "discarded");
  if (opts.dryRun) {
    // A preview moves nothing, so it needn't wait for (or be blocked by) a running move.
    const pending = plan.items.filter((i) => i.status === "pending" && i.destination);
    return { moved: [], failed: [], wouldMove: pending.map((i) => ({ file: i.file, to: targetPath(i) as string })) };
  }
  return withMoveLock(() => {
    recoverPendingMoves();
    // Recovery may have completed a move whose plan update was interrupted.
    for (const move of loadMoves().filter((m) => m.planId === plan.id)) {
      const item = plan.items.find((i) => i.file === move.from);
      if (item) {
        item.status = "moved";
        item.operationId = move.id;
        item.note = undefined;
      }
    }
    return applyPending(plan, opts.onConflict);
  });
}

function applyPending(plan: Plan, onConflict?: ConflictPolicy): ApplyResult {
  const result: ApplyResult = { moved: [], failed: [] };
  const batch = new MoveBatch(plan);
  try {
    for (const item of plan.items.filter((i) => i.status === "pending" && i.destination)) {
      try {
        if (!fs.existsSync(item.file)) throw new TidyError("file no longer exists");
        // Plans from older versions may spell the name differently from the disk.
        item.file = onDiskPath(item.file);
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
  if (result.moved.length) trimHistory(loadConfig().historyMaxMoves);
  return result;
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
