import fs from "node:fs";
import path from "node:path";
import { TidyError } from "./errors.js";
import { availableName, sameFile } from "./names.js";
import { loadConfig } from "./store/config.js";
import { type MoveEntry, loadMoves, newId, record, trimHistory } from "./store/history.js";
import { type Plan, savePlan, targetPath } from "./store/plans.js";
import { FileIndex } from "./store/summaries.js";

export type ConflictPolicy = "fail" | "rename";

/**
 * Move without ever overwriting. Handles case-only renames on case-insensitive filesystems
 * (where `to` "exists" because it is `from`), and falls back to copy+delete across filesystems,
 * keeping the modified time.
 */
export function moveFile(from: string, to: string): void {
  if (fs.existsSync(to)) {
    if (!sameFile(from, to)) throw new TidyError(`destination already exists: ${to}`, "conflict");
    if (path.basename(from) === path.basename(to) && path.dirname(from) === path.dirname(to)) return;
    // Case/normalization-only rename: go through a temporary name so every filesystem notices.
    const tmp = path.join(path.dirname(to), `.tidybot-${process.pid}-${Date.now()}.tmp`);
    fs.renameSync(from, tmp);
    fs.renameSync(tmp, to);
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    const st = fs.statSync(from);
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.utimesSync(to, st.atime, st.mtime);
    fs.unlinkSync(from);
  }
}

export interface ApplyResult {
  moved: { file: string; to: string; operationId: string }[];
  failed: { file: string; error: string }[];
  wouldMove?: { file: string; to: string }[];
}

export function applyPlan(plan: Plan, opts: { dryRun?: boolean; onConflict?: ConflictPolicy } = {}): ApplyResult {
  const result: ApplyResult = { moved: [], failed: [] };
  const pending = plan.items.filter((i) => i.status === "pending" && i.destination);
  if (opts.dryRun) {
    result.wouldMove = pending.map((i) => ({ file: i.file, to: targetPath(i) as string }));
    return result;
  }
  const index = new FileIndex();
  for (const item of pending) {
    let to = targetPath(item) as string;
    try {
      if (!fs.existsSync(item.file)) throw new TidyError("file no longer exists");
      if (path.resolve(item.file) === path.resolve(to)) throw new TidyError("file is already in its destination");
      if (fs.existsSync(to) && !sameFile(item.file, to) && opts.onConflict === "rename") to = availableName(to);
      moveFile(item.file, to);
      index.moved(item.file, to);
      const operationId = newId("m");
      record({ kind: "move", id: operationId, at: new Date().toISOString(), planId: plan.id, from: item.file, to });
      item.status = "moved";
      item.operationId = operationId;
      item.note = undefined;
      result.moved.push({ file: item.file, to, operationId });
    } catch (err) {
      item.status = "failed";
      item.note = err instanceof Error ? err.message : String(err);
      result.failed.push({ file: item.file, error: item.note });
    }
    savePlan(plan); // persist after each file so a crash never loses track of a move
  }
  index.save();
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
  const result: UndoResult = { undone: [], failed: [] };
  const index = new FileIndex();
  // Reverse order so chained moves unwind correctly.
  for (const m of [...moves].reverse()) {
    try {
      if (!fs.existsSync(m.to)) throw new TidyError(`file is no longer at ${m.to}`);
      moveFile(m.to, m.from);
      index.moved(m.to, m.from);
      record({ kind: "undo", id: newId("u"), at: new Date().toISOString(), target: m.id });
      result.undone.push({ id: m.id, from: m.to, to: m.from });
    } catch (err) {
      result.failed.push({ id: m.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  index.save();
  if (result.undone.length) trimHistory(loadConfig().historyMaxMoves);
  return result;
}

/** Drop a history entry that can't be undone (e.g. the file was deleted), so it stops showing as active. */
export function forgetMove(id: string): MoveEntry {
  const m = loadMoves().find((x) => x.id === id);
  if (!m) throw new TidyError(`No history entry "${id}"`, "not_found");
  if (m.state !== "active") throw new TidyError(`History entry ${id} is already ${m.state}`);
  record({ kind: "forget", id: newId("f"), at: new Date().toISOString(), target: id });
  trimHistory(loadConfig().historyMaxMoves);
  return { ...m, state: "forgotten" };
}
