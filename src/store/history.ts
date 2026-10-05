import { randomBytes } from "node:crypto";
import path from "node:path";
import { tidybotHome } from "../paths.js";
import { appendJsonl, readJsonl, writeJsonl } from "./io.js";

/** Append-only log. State is derived by folding the records. A move into the trash folder has
 * `trash: true`; a file sent to the system Trash has a `trash` record, with no path to undo to. */
export type HistoryRecord =
  | { kind: "move"; id: string; at: string; planId?: string; from: string; to: string; trash?: true }
  | { kind: "trash"; id: string; at: string; planId?: string; from: string }
  | { kind: "undo"; id: string; at: string; target: string }
  | { kind: "forget"; id: string; at: string; target: string };

export type MoveState = "active" | "undone" | "forgotten";

export interface MoveEntry {
  id: string;
  at: string;
  planId?: string;
  from: string;
  /** Null for a file sent to the system Trash. */
  to: string | null;
  /** Deleted: moved to the trash folder, or sent to the system Trash. */
  trash?: "folder" | "system";
  state: MoveState;
  undoneAt?: string;
}

const historyFile = () => path.join(tidybotHome(), "history.jsonl");

export function newId(prefix: string): string {
  return `${prefix}${randomBytes(4).toString("hex")}`;
}

export function record(entry: HistoryRecord): void {
  appendJsonl(historyFile(), entry);
}

export function loadMoves(): MoveEntry[] {
  const moves = new Map<string, MoveEntry>();
  for (const r of readJsonl<HistoryRecord>(historyFile())) {
    if (r.kind === "move") {
      moves.set(r.id, { id: r.id, at: r.at, planId: r.planId, from: r.from, to: r.to, ...(r.trash ? { trash: "folder" as const } : {}), state: "active" });
    } else if (r.kind === "trash") {
      moves.set(r.id, { id: r.id, at: r.at, planId: r.planId, from: r.from, to: null, trash: "system", state: "active" });
    } else {
      const m = moves.get(r.target);
      if (!m) continue;
      m.state = r.kind === "undo" ? "undone" : "forgotten";
      if (r.kind === "undo") m.undoneAt = r.at;
    }
  }
  return [...moves.values()];
}

/**
 * Keep only the newest `max` moves (0 = unlimited), along with the undo/forget records that
 * target them. Older moves can no longer be undone. Returns how many moves were dropped.
 */
export function trimHistory(max: number): number {
  if (max <= 0) return 0;
  const records = readJsonl<HistoryRecord>(historyFile());
  const isMove = (r: HistoryRecord): r is Extract<HistoryRecord, { kind: "move" | "trash" }> => r.kind === "move" || r.kind === "trash";
  const moveIds = records.filter(isMove).map((r) => r.id);
  const dropped = moveIds.length - max;
  if (dropped <= 0) return 0;
  const keep = new Set(moveIds.slice(dropped));
  writeJsonl(
    historyFile(),
    records.filter((r) => keep.has(isMove(r) ? r.id : r.target)),
  );
  return dropped;
}
