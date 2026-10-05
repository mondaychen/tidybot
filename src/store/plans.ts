import fs from "node:fs";
import path from "node:path";
import { TidyError } from "../errors.js";
import { tidybotHome } from "../paths.js";
import { readJson, writeJson } from "./io.js";

export type ItemStatus = "pending" | "invalid" | "skipped" | "moved" | "trashed" | "failed";

export interface PlanItem {
  /** Absolute path of the file to move. */
  file: string;
  /** Smart folder name chosen by the agent (or null if user set a raw path / no match). */
  folder: string | null;
  /** Absolute destination directory. Null when unresolved. */
  destination: string | null;
  /** Delete instead of moving: the file goes to the trash (see `trashDir`). */
  delete?: boolean;
  /** New filename, if the agent or user chose to rename. */
  newName?: string;
  reason?: string;
  confidence?: number;
  /** Agent's reason for filing an image without a summary. */
  summarySkipped?: string;
  status: ItemStatus;
  /** Non-blocking issues, e.g. a name conflict the agent could fix with a rename. */
  warnings?: string[];
  /** Why the item is invalid/failed/skipped. */
  note?: string;
  /** History id once moved. */
  operationId?: string;
}

/** Settings in effect at the latest `propose`, so you can see later why files went where they did. */
export interface PlanContext {
  recordedAt: string;
  rename: string;
  naming: string;
  rules: string[];
  folders: { name: string; path: string; rule: string }[];
}

export interface Plan {
  id: string;
  createdAt: string;
  source: string;
  discarded?: boolean;
  context?: PlanContext;
  items: PlanItem[];
}

/** Full path the item will be moved to, or null if unresolved. */
export function targetPath(item: PlanItem): string | null {
  return item.destination ? path.join(item.destination, item.newName ?? path.basename(item.file)) : null;
}

export type PlanState = "open" | "done" | "discarded";

const plansDir = () => path.join(tidybotHome(), "plans");
const planFile = (id: string) => path.join(plansDir(), `${id}.json`);

export function planState(plan: Plan): PlanState {
  if (plan.discarded) return "discarded";
  return plan.items.some((i) => i.status === "pending") ? "open" : "done";
}

export function newPlanId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let id = `p${stamp}`;
  for (let n = 2; fs.existsSync(planFile(id)); n++) id = `p${stamp}-${n}`;
  return id;
}

export function savePlan(plan: Plan): void {
  writeJson(planFile(plan.id), plan);
}

export function listPlans(): Plan[] {
  if (!fs.existsSync(plansDir())) return [];
  return fs
    .readdirSync(plansDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<Plan>(path.join(plansDir(), f)))
    .filter((p): p is Plan => !!p)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/** Load a plan by id, or the most recent open plan when id is omitted / "latest". */
export function loadPlan(id?: string): Plan {
  if (!id || id === "latest") {
    const open = listPlans().find((p) => planState(p) === "open");
    if (!open) throw new TidyError("No open plan. Create one with `tidybot propose`.", "not_found");
    return open;
  }
  const plan = readJson<Plan>(planFile(id));
  if (!plan) throw new TidyError(`No plan with id "${id}"`, "not_found");
  return plan;
}
