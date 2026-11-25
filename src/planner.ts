import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { TidyError } from "./errors.js";
import { mimeOf } from "./extract.js";
import { sameContent } from "./hash.js";
import { onDiskPath } from "./file-move.js";
import { fitName, pathKey, sameFile } from "./names.js";
import { resolvePath } from "./paths.js";
import { isImage } from "./scan.js";
import { sensitiveByName } from "./sensitive.js";
import { type Config, loadConfig } from "./store/config.js";
import { type MoveEntry, loadMoves } from "./store/history.js";
import { findPlace, loadPlaces, type Place } from "./store/places.js";
import { type Plan, type PlanItem, listPlans, newPlanId, planState, savePlan, targetPath } from "./store/plans.js";
import { FileIndex, loadSummaries } from "./store/summaries.js";
import { type TrashStatus, trashStatus } from "./trash.js";

/** What an agent sends to `tidybot propose`. */
export const ProposalSchema = z
  .object({
    file: z.string().min(1),
    /** Place name, or null when none fits. Omitted when deleting. */
    place: z.string().nullable().optional(),
    /** Delete the file instead: it goes to the trash. */
    delete: z.boolean().optional(),
    /** Leave the file where it is on purpose (user's rules, or it already looks organized). */
    skip: z.boolean().optional(),
    /** New filename (no directories). Extension is kept if omitted. */
    rename: z.string().nullish(),
    /** Why an image can be filed without a summary (e.g. its name is already descriptive). */
    summarySkipped: z.string().trim().min(1).optional(),
    reason: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .refine((p) => p.delete || p.skip || p.place !== undefined, {
    message: "each item needs `place` (null when none fits), `delete: true`, or `skip: true`",
  })
  .refine((p) => !p.delete || !p.place, { message: "an item to delete can't also have a place" })
  .refine((p) => !p.skip || (!p.delete && !p.place && !p.rename), { message: "an item to skip can't also have a place, a rename or `delete`" });
export const ProposeInputSchema = z.union([
  z.array(ProposalSchema),
  z.object({ source: z.string().optional(), items: z.array(ProposalSchema) }),
]);
export type Proposal = z.infer<typeof ProposalSchema>;

/**
 * Make an agent-proposed name safe: single path segment, no reserved characters, NFC-normalized,
 * at most 255 bytes, original extension preserved (lowercased with `extensionCase: lower`).
 * Returns undefined if unchanged or nothing is left.
 */
export function sanitizeName(proposed: string, original: string, config?: Pick<Config, "extensionCase">): string | undefined {
  if (/[/\\\0]/.test(proposed)) throw new TidyError(`New name "${proposed}" must not contain path separators.`, "invalid_input");
  const ext = path.extname(original);
  let stem = proposed
    .normalize("NFC")
    .replace(/[<>:"|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  if (ext && path.extname(stem).toLowerCase() === ext.toLowerCase()) stem = stem.slice(0, -ext.length);
  const typed = ext && path.extname(proposed).toLowerCase() === ext.toLowerCase() ? path.extname(proposed) : ext;
  const kept = config?.extensionCase === "lower" ? typed.toLowerCase() : typed;
  if (!stem) return undefined;
  const name = fitName(stem, kept);
  return name === path.basename(original).normalize("NFC") ? undefined : name;
}

interface ProposeContext {
  source: string;
  trash: TrashStatus;
  places: Place[];
  config: Pick<Config, "rename" | "extensionCase">;
  requireImageSummaries: boolean;
  allowRules: ReadonlySet<string>;
  summarized: (file: string) => boolean;
}

function toItem(p: Proposal, ctx: ProposeContext): PlanItem {
  // On case-insensitive filesystems, record the name as stored rather than as typed.
  const file = onDiskPath(resolvePath(p.file, ctx.source));
  const item: PlanItem = { file, place: p.place ?? null, destination: null, reason: p.reason, confidence: p.confidence, status: "pending" };
  const invalid = (note: string): PlanItem => ({ ...item, status: "invalid", note });

  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return invalid("file not found");
  // Nothing happens to a skipped file, so it needs no summary.
  if (p.skip) return { ...item, status: "skipped", note: "left in place by agent" };
  if (ctx.requireImageSummaries && isImage(mimeOf(file)) && !sensitiveByName(file, ctx.allowRules) && !ctx.summarized(file)) {
    if (!p.summarySkipped) {
      return invalid('image has no summary yet; summarize it (tidybot guide summarize) or give "summarySkipped": "<reason>" if the name says enough');
    }
    item.summarySkipped = p.summarySkipped;
  }
  if (p.delete) {
    if (!ctx.trash.enabled) return invalid(ctx.trash.reason);
    return { ...item, delete: true, ...(p.rename ? { warnings: ["rename ignored: the file is being deleted"] } : {}) };
  }
  if (p.rename) {
    if (ctx.config.rename === "off") item.warnings = ["rename ignored: renaming is off (config rename=off)"];
    else {
      try {
        item.newName = sanitizeName(p.rename, file, ctx.config);
      } catch (err) {
        return invalid((err as Error).message);
      }
    }
  }
  if (p.place == null) {
    if (!item.newName) return { ...item, status: "skipped", note: "agent found no matching place" };
    item.destination = path.dirname(file); // rename in place
    return item;
  }
  const place = findPlace(ctx.places, p.place);
  if (!place) return invalid(`unknown place "${p.place}"`);
  item.place = place.name;
  item.destination = resolvePath(place.path);
  if (targetPath(item) === file) return { ...item, status: "skipped", note: "already in place" };
  return item;
}

/** Warn about targets that already exist or that two items share, so the agent can rename. */
export function refreshWarnings(plan: Plan): void {
  const seen = new Map<string, PlanItem>();
  for (const item of plan.items) {
    item.warnings = item.warnings?.filter((w) => !w.startsWith("conflict:"));
    if (item.status !== "pending") continue;
    const target = targetPath(item);
    if (!target) continue;
    const add = (w: string) => {
      item.warnings = [...(item.warnings ?? []), w];
    };
    // Identical files need no new name: one of them can be deleted instead.
    const compare = (other: string) =>
      sameContent(item.file, other) ? "identical files: delete one instead of renaming" : "different files: rename one";
    // exists() is case-insensitive on macOS; a hit on the item's own file is a case-only rename, not a conflict.
    if (fs.existsSync(target) && !sameFile(target, item.file)) add(`conflict: ${path.basename(target)} already exists in the destination (${compare(target)})`);
    const key = pathKey(target);
    const other = seen.get(key);
    if (other) add(`conflict: same target as ${path.basename(other.file)} (${compare(other.file)}; names that differ only by case or accents collide on macOS)`);
    seen.set(key, item);
    if (item.warnings?.length === 0) item.warnings = undefined;
  }
}

/** Create a new plan, or merge into an existing open plan (later proposals win per file). */
export async function propose(
  input: unknown,
  opts: { source: string; config?: Partial<Config>; appendTo?: Plan; allowUnsummarized?: boolean },
): Promise<Plan> {
  const parsed = ProposeInputSchema.safeParse(input);
  if (!parsed.success) throw new TidyError(`Invalid proposal: ${z.prettifyError(parsed.error)}`, "invalid_input");
  const data = parsed.data;
  const proposals = Array.isArray(data) ? data : data.items;
  const source = resolvePath(opts.appendTo?.source ?? (Array.isArray(data) ? undefined : data.source) ?? opts.source);
  if (proposals.length === 0) throw new TidyError("Proposal has no items.", "invalid_input");

  const places = loadPlaces();
  // Renames in place and deletions need no place.
  if (places.length === 0 && proposals.some((p) => typeof p.place === "string")) {
    throw new TidyError("No places configured. Add some with `tidybot places add`.");
  }
  if (opts.appendTo && planState(opts.appendTo) === "discarded") throw new TidyError(`Plan ${opts.appendTo.id} was discarded.`);

  const config = { ...loadConfig(), ...opts.config };
  const index = new FileIndex();
  const summaries = await loadSummaries();
  const ctx: ProposeContext = {
    source,
    trash: trashStatus(config),
    places,
    config,
    requireImageSummaries: !opts.allowUnsummarized,
    allowRules: new Set(config.allowRules),
    summarized: (file) => {
      const hash = index.cachedHash(file);
      return !!hash && summaries.has(hash);
    },
  };

  const plan: Plan = opts.appendTo ?? { id: newPlanId(), createdAt: new Date().toISOString(), source, items: [] };
  for (const p of proposals) {
    const item = toItem(p, ctx);
    const idx = plan.items.findIndex((i) => i.file === item.file);
    if (idx < 0) plan.items.push(item);
    else if (isDone(plan.items[idx])) continue; // never rewrite history
    else plan.items[idx] = item;
  }
  refreshWarnings(plan);
  plan.context = {
    recordedAt: new Date().toISOString(),
    rename: config.rename,
    naming: config.naming,
    extensionCase: config.extensionCase,
    rules: config.rules,
    places,
  };
  savePlan(plan);
  return plan;
}

const isDone = (item: PlanItem | undefined) => item?.status === "moved" || item?.status === "trashed";

export function findItem(plan: Plan, file: string): PlanItem {
  const abs = resolvePath(file, plan.source);
  let item = plan.items.find((i) => i.file === abs);
  if (!item) {
    const bySuffix = plan.items.filter((i) => i.file.endsWith(`${path.sep}${file}`));
    if (bySuffix.length > 1) {
      const options = bySuffix.map((i) => path.relative(plan.source, i.file)).join(", ");
      throw new TidyError(`"${file}" matches ${bySuffix.length} files in plan ${plan.id}: ${options}. Use the full relative path.`, "ambiguous");
    }
    item = bySuffix[0];
  }
  if (!item) throw new TidyError(`File "${file}" is not in plan ${plan.id}`, "not_found");
  if (isDone(item)) throw new TidyError(`"${file}" was already ${item.status}; use \`tidybot undo\` instead.`);
  return item;
}

type Target = { place?: string; path?: string; name?: string | null; delete?: boolean };

/**
 * Human override: point an item at another place or any directory, and/or change its new name,
 * or mark it for deletion. `name: null` keeps the original filename.
 */
export function retarget(plan: Plan, file: string, target: Target): PlanItem {
  return retargetAll(plan, [file], target)[0] as PlanItem;
}

/** `retarget` for several files. All or nothing: the plan is saved only if every file can change. */
export function retargetAll(plan: Plan, files: string[], target: Target): PlanItem[] {
  if (files.length > 1 && target.name) throw new TidyError("A new name applies to one file only.", "invalid_input");
  const ctx = {
    places: target.place ? loadPlaces() : [],
    trash: target.delete ? trashStatus(loadConfig()) : undefined,
    config: target.name ? loadConfig() : undefined,
  };
  // Work on a copy, so a file that fails leaves the plan as it was.
  const draft: Plan = structuredClone(plan);
  for (const f of files) setTarget(findItem(draft, f), target, ctx);
  plan.items = draft.items;
  refreshWarnings(plan);
  savePlan(plan);
  return files.map((f) => findItem(plan, f));
}

function setTarget(item: PlanItem, target: Target, ctx: { places: Place[]; trash?: TrashStatus; config?: Config }): PlanItem {
  if (target.delete) {
    if (target.place || target.path || target.name) throw new TidyError("A file to delete has no destination or new name.", "invalid_input");
    const trash = ctx.trash as TrashStatus;
    if (!trash.enabled) throw new TidyError(trash.reason, "trash_disabled");
    return Object.assign(item, { delete: true, place: null, destination: null, newName: undefined, status: "pending", note: "edited by user" });
  }
  if (item.delete && !target.place && !target.path) throw new TidyError("This file is set to be deleted. Give a place or --path to move it instead.");
  item.delete = undefined;
  if (target.place) {
    const place = findPlace(ctx.places, target.place);
    if (!place) throw new TidyError(`No place named "${target.place}"`, "not_found");
    item.place = place.name;
    item.destination = resolvePath(place.path);
  } else if (target.path) {
    item.place = null;
    item.destination = resolvePath(target.path);
  } else if (target.name === undefined) {
    throw new TidyError("Give a place name, --path, --name, --keep-name or --delete.");
  }
  if (target.name === null) item.newName = undefined;
  else if (target.name !== undefined) item.newName = sanitizeName(target.name, item.file, ctx.config);
  if (!item.destination) item.destination = path.dirname(item.file); // rename-only on a previously unresolved item
  item.status = "pending";
  item.note = "edited by user";
  return item;
}

export function skip(plan: Plan, file: string): PlanItem {
  const item = findItem(plan, file);
  item.status = "skipped";
  item.note = "skipped by user";
  refreshWarnings(plan);
  savePlan(plan);
  return item;
}

/**
 * A file of a reopened plan that is not back where it was, so the new plan leaves it out.
 * `stillMoved`: it is at `at`. `undoId` is the history entry that puts it back; without one, undo
 * can't reach it (the entry was dropped). `systemTrash`: it is in the system Trash. `missing`: not found.
 */
export interface LeftOut {
  file: string;
  reason: "stillMoved" | "systemTrash" | "missing";
  at?: string;
  undoId?: string;
}

export const SAME_FILE_WARNING = "tidybot didn't put this file back: make sure it is the same file before you apply";

const isFile = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

/** The open plan that `reopenPlan` made from `planId`, if there is one. */
export function openReopenOf(planId: string, plans: Plan[] = listPlans()): Plan | undefined {
  return plans.find((p) => p.reopenedFrom === planId && planState(p) === "open");
}

/**
 * Copy an applied or discarded plan into a new open plan, so its files can be moved again after an
 * undo. The old plan doesn't change: it stays the record of what was applied (DECISIONS.md #11).
 * Only files that are at their original path now come into the new plan. The others are returned
 * as `left`, with where they are. Destinations are resolved again from the current places.
 */
export function reopenPlan(old: Plan): { plan: Plan; left: LeftOut[] } {
  if (planState(old) === "open") throw new TidyError(`Plan ${old.id} is still open. Change it with \`tidybot plan set\`, or apply it.`, "invalid_input");
  const existing = openReopenOf(old.id);
  if (existing) throw new TidyError(`Plan ${old.id} was already reopened as ${existing.id}, which is still open. Use that plan, or discard it first.`, "already_reopened");

  const places = loadPlaces();
  const trash = trashStatus(loadConfig());
  const moves = loadMoves();
  // The newest move of a path, by any plan: it says where the file went last.
  const lastMove = (file: string): MoveEntry | undefined => moves.findLast((m) => m.from === file);

  const items: PlanItem[] = [];
  const left: LeftOut[] = [];
  for (const item of old.items) {
    const applied = item.status === "moved" || item.status === "trashed";
    if (!isFile(item.file)) {
      left.push(whereIs(item, applied, lastMove(item.file)));
      continue;
    }
    const next: PlanItem = {
      file: item.file,
      place: item.place,
      destination: item.destination,
      ...(item.delete ? { delete: true } : {}),
      ...(item.newName ? { newName: item.newName } : {}),
      ...(item.reason !== undefined ? { reason: item.reason } : {}),
      ...(item.confidence !== undefined ? { confidence: item.confidence } : {}),
      ...(item.summarySkipped ? { summarySkipped: item.summarySkipped } : {}),
      status: "pending",
    };
    const warnings = (item.warnings ?? []).filter((w) => !w.startsWith("conflict:"));
    if (warnings.length) next.warnings = warnings;
    // Decisions that didn't move the file stay as they were. The user can change them in the new plan.
    if (item.status === "skipped" || item.status === "invalid") {
      items.push({ ...next, status: item.status, note: item.note });
      continue;
    }
    if (item.note === "edited by user") next.note = item.note;
    // A file that tidybot put back is the same file. Any other file at that path may not be.
    if (applied && lastMove(item.file)?.state !== "undone") next.warnings = [...(next.warnings ?? []), SAME_FILE_WARNING];
    items.push(resolveAgain(next, places, trash));
  }

  if (!items.some((i) => i.status === "pending" || i.status === "invalid")) {
    throw new TidyError(`Nothing to reopen in plan ${old.id}: ${describeLeftOut(left, old.id)}.`, "nothing_to_reopen");
  }
  const plan: Plan = {
    id: newPlanId(),
    createdAt: new Date().toISOString(),
    source: old.source,
    reopenedFrom: old.id,
    ...(old.context ? { context: old.context } : {}),
    items,
  };
  refreshWarnings(plan);
  savePlan(plan);
  return { plan, left };
}

/** Point a reopened item at its place's current folder, and check that it can still be applied. */
function resolveAgain(item: PlanItem, places: Place[], trash: TrashStatus): PlanItem {
  if (item.delete) return trash.enabled ? item : { ...item, status: "invalid", note: trash.reason };
  if (item.place) {
    const place = findPlace(places, item.place);
    if (!place) return { ...item, status: "invalid", note: `place "${item.place}" no longer exists` };
    item.place = place.name;
    item.destination = resolvePath(place.path);
  }
  if (!item.destination) return { ...item, status: "invalid", note: "no destination" };
  if (targetPath(item) === item.file) return { ...item, status: "skipped", note: "already in place" };
  return item;
}

function whereIs(item: PlanItem, applied: boolean, move: MoveEntry | undefined): LeftOut {
  const { file } = item;
  if (move?.to === null && move.state !== "undone") return { file, reason: "systemTrash" };
  if (move?.to && isFile(move.to)) {
    if (move.state === "active") return { file, reason: "stillMoved", at: move.to, undoId: move.id };
    if (move.state === "forgotten") return { file, reason: "stillMoved", at: move.to };
  }
  // The history entry was dropped (historyMaxMoves): look where the plan sent the file.
  const target = applied && !item.delete ? targetPath(item) : null;
  if (!move && target && isFile(target)) return { file, reason: "stillMoved", at: target };
  return { file, reason: "missing" };
}

/** "2 still moved (put them back first: tidybot undo --plan p1) and 1 not found" */
export function describeLeftOut(left: LeftOut[], planId: string): string {
  const n = (reason: LeftOut["reason"]) => left.filter((l) => l.reason === reason).length;
  const parts = [
    n("stillMoved") ? `${n("stillMoved")} still moved (put them back first: tidybot undo --plan ${planId})` : "",
    n("systemTrash") ? `${n("systemTrash")} in the system Trash (restore them first)` : "",
    n("missing") ? `${n("missing")} not found` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "the plan has no files to move or delete";
}
