import path from "node:path";
import { TidyError } from "./errors.js";
import { contractHome } from "./paths.js";
import type { MoveEntry } from "./store/history.js";
import { type Plan, type PlanItem, planState } from "./store/plans.js";

let jsonMode = process.env.TIDYBOT_JSON === "1";
export const setJsonMode = (on: boolean) => {
  jsonMode = jsonMode || on;
};
export const isJsonMode = () => jsonMode;

/** Print `data` as JSON in --json mode, otherwise the human rendering. */
export function emit(data: unknown, human: () => string): void {
  if (jsonMode) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else process.stdout.write(`${human()}\n`);
}

export function fail(err: unknown): never {
  const known = err instanceof TidyError;
  const message = err instanceof Error ? err.message : String(err);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code: known ? err.code : "internal", message } }, null, 2)}\n`);
  } else {
    process.stderr.write(`error: ${message}\n`);
    if (!known && err instanceof Error && process.env.TIDYBOT_DEBUG) process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
}

const STATUS_MARK: Record<PlanItem["status"], string> = {
  pending: "·",
  moved: "✓",
  skipped: "-",
  invalid: "!",
  failed: "✗",
};

export function renderPlan(plan: Plan): string {
  const counts = plan.items.reduce<Record<string, number>>((acc, i) => {
    acc[i.status] = (acc[i.status] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  const lines = [`Plan ${plan.id} [${planState(plan)}]  source: ${contractHome(plan.source)}  (${summary})`, ""];
  for (const i of plan.items) {
    const rel = path.relative(plan.source, i.file);
    const inPlace = i.destination === path.dirname(i.file) && i.folder === null;
    const dest = !i.destination
      ? (i.folder ?? "—")
      : inPlace
        ? "(rename in place)"
        : `${i.folder ?? "(custom)"}  ${contractHome(i.destination)}`;
    const rename = i.newName ? `  as "${i.newName}"` : "";
    const extra = [
      i.confidence !== undefined ? `${Math.round(i.confidence * 100)}%` : "",
      i.reason ?? "",
      i.note ? `[${i.note}]` : "",
      ...(i.warnings ?? []).map((w) => `⚠ ${w}`),
    ]
      .filter(Boolean)
      .join("  ");
    lines.push(`${STATUS_MARK[i.status]} ${i.status.padEnd(7)} ${rel}  →  ${dest}${rename}${extra ? `\n            ${extra}` : ""}`);
  }
  return lines.join("\n");
}

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [604800, "week"],
  ];
  let [div, name] = units[0] as [number, string];
  for (const u of units) if (s >= u[0]) [div, name] = u;
  const n = Math.floor(s / div);
  return `${n} ${name}${n === 1 ? "" : "s"} ago`;
}

export function renderMoves(moves: MoveEntry[]): string {
  if (moves.length === 0) return "No moves recorded.";
  return moves
    .map((m) => {
      const state = m.state === "active" ? "" : `  (${m.state})`;
      return `${m.id}  ${relativeTime(m.at).padEnd(14)} ${contractHome(m.from)}  →  ${contractHome(path.dirname(m.to))}${state}`;
    })
    .join("\n");
}
