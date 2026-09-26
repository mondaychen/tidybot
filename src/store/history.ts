import { randomBytes } from "node:crypto";
import path from "node:path";
import { tidybotHome } from "../paths.js";
import { appendJsonl, readJsonl } from "./io.js";

/** Append-only log. State is derived by folding the records. */
export type HistoryRecord =
  | { kind: "move"; id: string; at: string; planId?: string; from: string; to: string }
  | { kind: "undo"; id: string; at: string; target: string }
  | { kind: "forget"; id: string; at: string; target: string };

export type MoveState = "active" | "undone" | "forgotten";

export interface MoveEntry {
  id: string;
  at: string;
  planId?: string;
  from: string;
  to: string;
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
      moves.set(r.id, { id: r.id, at: r.at, planId: r.planId, from: r.from, to: r.to, state: "active" });
    } else {
      const m = moves.get(r.target);
      if (!m) continue;
      m.state = r.kind === "undo" ? "undone" : "forgotten";
      if (r.kind === "undo") m.undoneAt = r.at;
    }
  }
  return [...moves.values()];
}
