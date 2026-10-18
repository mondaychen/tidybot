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
import { findFolder, loadFolders, type SmartFolder } from "./store/folders.js";
import { type Plan, type PlanItem, newPlanId, planState, savePlan, targetPath } from "./store/plans.js";
import { FileIndex, loadSummaries } from "./store/summaries.js";
import { type TrashStatus, trashStatus } from "./trash.js";

/** What an agent sends to `tidybot propose`. */
export const ProposalSchema = z
  .object({
    file: z.string().min(1),
    /** Smart folder name, or null when none fits. Omitted when deleting. */
    folder: z.string().nullable().optional(),
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
  .refine((p) => p.delete || p.skip || p.folder !== undefined, {
    message: "each item needs `folder` (null when none fits), `delete: true`, or `skip: true`",
  })
  .refine((p) => !p.delete || !p.folder, { message: "an item to delete can't also have a folder" })
  .refine((p) => !p.skip || (!p.delete && !p.folder && !p.rename), { message: "an item to skip can't also have a folder, a rename or `delete`" });
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
  folders: SmartFolder[];
  config: Pick<Config, "rename" | "extensionCase">;
  requireImageSummaries: boolean;
  allowRules: ReadonlySet<string>;
  summarized: (file: string) => boolean;
}

function toItem(p: Proposal, ctx: ProposeContext): PlanItem {
  // On case-insensitive filesystems, record the name as stored rather than as typed.
  const file = onDiskPath(resolvePath(p.file, ctx.source));
  const item: PlanItem = { file, folder: p.folder ?? null, destination: null, reason: p.reason, confidence: p.confidence, status: "pending" };
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
  if (p.folder == null) {
    if (!item.newName) return { ...item, status: "skipped", note: "agent found no matching smart folder" };
    item.destination = path.dirname(file); // rename in place
    return item;
  }
  const folder = findFolder(ctx.folders, p.folder);
  if (!folder) return invalid(`unknown smart folder "${p.folder}"`);
  item.folder = folder.name;
  item.destination = resolvePath(folder.path);
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

  const folders = loadFolders();
  // Renames in place and deletions need no smart folder.
  if (folders.length === 0 && proposals.some((p) => typeof p.folder === "string")) {
    throw new TidyError("No smart folders configured. Add some with `tidybot folders add`.");
  }
  if (opts.appendTo && planState(opts.appendTo) === "discarded") throw new TidyError(`Plan ${opts.appendTo.id} was discarded.`);

  const config = { ...loadConfig(), ...opts.config };
  const index = new FileIndex();
  const summaries = await loadSummaries();
  const ctx: ProposeContext = {
    source,
    trash: trashStatus(config),
    folders,
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
    folders,
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

type Target = { folder?: string; path?: string; name?: string | null; delete?: boolean };

/**
 * Human override: point an item at another smart folder or any directory, and/or change its new name,
 * or mark it for deletion. `name: null` keeps the original filename.
 */
export function retarget(plan: Plan, file: string, target: Target): PlanItem {
  return retargetAll(plan, [file], target)[0] as PlanItem;
}

/** `retarget` for several files. All or nothing: the plan is saved only if every file can change. */
export function retargetAll(plan: Plan, files: string[], target: Target): PlanItem[] {
  if (files.length > 1 && target.name) throw new TidyError("A new name applies to one file only.", "invalid_input");
  const ctx = {
    folders: target.folder ? loadFolders() : [],
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

function setTarget(item: PlanItem, target: Target, ctx: { folders: SmartFolder[]; trash?: TrashStatus; config?: Config }): PlanItem {
  if (target.delete) {
    if (target.folder || target.path || target.name) throw new TidyError("A file to delete has no destination or new name.", "invalid_input");
    const trash = ctx.trash as TrashStatus;
    if (!trash.enabled) throw new TidyError(trash.reason, "trash_disabled");
    return Object.assign(item, { delete: true, folder: null, destination: null, newName: undefined, status: "pending", note: "edited by user" });
  }
  if (item.delete && !target.folder && !target.path) throw new TidyError("This file is set to be deleted. Give a smart folder or --path to move it instead.");
  item.delete = undefined;
  if (target.folder) {
    const folder = findFolder(ctx.folders, target.folder);
    if (!folder) throw new TidyError(`No smart folder named "${target.folder}"`, "not_found");
    item.folder = folder.name;
    item.destination = resolvePath(folder.path);
  } else if (target.path) {
    item.folder = null;
    item.destination = resolvePath(target.path);
  } else if (target.name === undefined) {
    throw new TidyError("Give a smart folder name, --path, --name, --keep-name or --delete.");
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
