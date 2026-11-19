import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { implement } from "@orpc/server";
import { TidyError } from "../errors.js";
import { applyPlan, compactHistory, forgetMove, selectMoves, undoMoves } from "../mover.js";
import { projectDir, tidybotHome } from "../paths.js";
import { retargetAll, skip } from "../planner.js";
import { RULES } from "../sensitive.js";
import { loadAllowances, removeAllowance } from "../store/allowlist.js";
import {
  SCALAR_KEYS as CONFIG_KEYS,
  activeScope,
  addRule,
  addSecretRule,
  loadConfig,
  loadGlobalConfig,
  loadRules,
  removeRule,
  removeSecretRule,
  sensitiveScopes,
  setConfigValue,
  setRuleAllowed,
  unsetConfigValue,
} from "../store/config.js";
import { type MoveEntry, loadMoves } from "../store/history.js";
import { abandonOperation, interruptedOperations, pendingOperations, recoverPendingMoves, withMoveLock } from "../store/operations.js";
import { addPlace, loadPlaces, placesFile, removePlace, updatePlace } from "../store/places.js";
import { type Plan as StoredPlan, listPlans, loadPlan, planState, savePlan } from "../store/plans.js";
import { FileIndex, compactSummaries, findSummaries } from "../store/summaries.js";
import { trashStatus } from "../trash.js";
import { type Plan, type PlanCounts, type PlanItem, type PlanSummary, SCALAR_KEYS, type TrashStatus, type UndoState, contract } from "./contract.js";

// The contract keeps its own copy of the settable keys, because it can't import server code.
// These two lines fail to compile when the lists differ.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const keysMatch: Same<(typeof SCALAR_KEYS)[number], (typeof CONFIG_KEYS)[number]> = true;
void keysMatch;

// package.json sits at the package root, two levels up from both src/ui/ and dist/ui/.
const { version } = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

/** History entries by id, to see what undo can do for a plan's moved files. */
type Moves = ReadonlyMap<string, MoveEntry>;
const movesById = (): Moves => new Map(loadMoves().map((m) => [m.id, m]));

function undoState(item: StoredPlan["items"][number], moves: Moves): UndoState | undefined {
  if (item.status !== "moved" && item.status !== "trashed") return undefined;
  const move = item.operationId ? moves.get(item.operationId) : undefined;
  // No entry: history was compacted, so the move can no longer be undone.
  if (!move || move.state === "forgotten") return "forgotten";
  if (move.state === "undone") return "putBack";
  return move.to === null ? "systemTrash" : "available";
}

/** Same test as the web page uses to put a file under "Needs your attention". */
const conflicts = (item: PlanItem) => (item.warnings ?? []).some((w) => w.startsWith("conflict:"));

function countItems(items: PlanItem[]): PlanCounts {
  const c: PlanCounts = { total: items.length, toMove: 0, toDelete: 0, attention: 0, left: 0, moved: 0, deleted: 0, putBack: 0, inSystemTrash: 0, canUndo: 0, canUndoDeleted: 0 };
  for (const item of items) {
    if (item.status === "invalid" || item.status === "failed" || (item.status === "pending" && conflicts(item))) c.attention++;
    else if (item.status === "pending") item.delete ? c.toDelete++ : c.toMove++;
    else if (item.status === "skipped") c.left++;
    else if (item.undo === "putBack") c.putBack++;
    else if (item.status === "moved") c.moved++;
    else c.deleted++;
    if (item.undo === "systemTrash") c.inSystemTrash++;
    if (item.undo === "available") {
      c.canUndo++;
      if (item.status === "trashed") c.canUndoDeleted++;
    }
  }
  return c;
}

/** The time of the plan's last move, or null if nothing was applied. */
function appliedAt(items: StoredPlan["items"], moves: Moves): string | null {
  let last: string | null = null;
  for (const i of items) {
    const at = i.operationId ? moves.get(i.operationId)?.at : undefined;
    if (at && (!last || at > last)) last = at;
  }
  return last;
}

/** A plan as the page shows it: each item with what undo can do, and the counts every view uses. */
function toPlan(p: StoredPlan, moves: Moves = movesById()): Plan {
  const items = p.items.map((i) => {
    const undo = undoState(i, moves);
    return undo ? { ...i, undo } : i;
  });
  return { ...p, items, state: planState(p), counts: countItems(items), appliedAt: appliedAt(p.items, moves) };
}

function toSummary(p: StoredPlan, moves: Moves): PlanSummary {
  const { id, state, createdAt, appliedAt, source, counts } = toPlan(p, moves);
  return { id, state, createdAt, appliedAt, source, counts };
}

const summaries = (filter: (p: StoredPlan) => boolean): PlanSummary[] => {
  const moves = movesById();
  return listPlans()
    .filter(filter)
    .map((p) => toSummary(p, moves));
};

/** Changes when anything that the preview shows changes: the stored plan, and where deleted files
 * go. So `apply` can tell that the preview is out of date. */
const revisionOf = (p: StoredPlan, trash: TrashStatus) =>
  createHash("sha256")
    .update(JSON.stringify([p.discarded ?? false, p.items, trash]))
    .digest("hex")
    .slice(0, 16);

const api = implement(contract);

/** Every procedure in the contract, implemented with the functions the CLI uses. */
export const router = api.router({
  status: api.status.handler(() => {
    const config = loadConfig();
    const project = projectDir();
    // Applied and not undone. Files sent to the system Trash are restored from there, not by undo.
    const undoable = loadMoves().filter((m) => m.state === "active" && m.to !== null);
    return {
      version,
      home: tidybotHome(),
      userHome: os.homedir(),
      // The folder that holds .tidybot/, as the CLI shows it.
      project: project ? path.dirname(project) : null,
      scope: activeScope(),
      source: config.source,
      places: loadPlaces().length,
      rules: config.rules.length,
      rename: config.rename,
      naming: config.naming,
      trash: trashStatus(config),
      openPlans: summaries((p) => planState(p) === "open"),
      undoableMoves: undoable.length,
      lastUndoablePlan: undoable.findLast((m) => m.planId)?.planId ?? null,
      interrupted: interruptedOperations(),
    };
  }),

  plans: {
    list: api.plans.list.handler(({ input }) => summaries((p) => input.all || planState(p) === "open")),
    get: api.plans.get.handler(({ input }) => toPlan(loadPlan(input.id))),
    retarget: api.plans.retarget.handler(({ input }) => {
      const plan = loadPlan(input.planId);
      retargetAll(plan, input.files, input.target);
      return toPlan(plan);
    }),
    skip: api.plans.skip.handler(({ input }) => {
      const plan = loadPlan(input.planId);
      for (const f of input.files) skip(plan, f);
      return toPlan(plan);
    }),
    discard: api.plans.discard.handler(({ input }) => {
      const plan = loadPlan(input.planId);
      plan.discarded = true;
      savePlan(plan);
      return toPlan(plan);
    }),
    preview: api.plans.preview.handler(async ({ input }) => {
      const preview = await applyPlan(loadPlan(input.planId), { dryRun: true });
      const trash = trashStatus(loadConfig());
      return { wouldMove: preview.wouldMove ?? [], wouldTrash: preview.wouldTrash ?? [], trash, revision: revisionOf(loadPlan(input.planId), trash) };
    }),
    apply: api.plans.apply.handler(async ({ input }) => {
      const plan = loadPlan(input.planId);
      // The agent can change the plan, or the trash setting, through the CLI while the user looks at the preview.
      if (input.revision !== undefined && input.revision !== revisionOf(plan, trashStatus(loadConfig()))) {
        throw new TidyError("The plan or the trash setting changed after you checked it. Check it again, then apply it.", "plan_changed");
      }
      const { moved, trashed, failed } = await applyPlan(plan, { onConflict: input.onConflict });
      return { result: { moved, trashed, failed }, plan: toPlan(plan) };
    }),
  },

  history: {
    list: api.history.list.handler(({ input }) =>
      loadMoves()
        .filter((m) => (input.all || m.state === "active") && (!input.planId || m.planId === input.planId))
        .reverse()
        .slice(0, input.limit ?? 200),
    ),
    undo: api.history.undo.handler(({ input }) => {
      const moves = selectMoves(input);
      // "Put back" for a plan or the last batch leaves out files in the system Trash: undo can't
      // reach them, and the page says so. A file asked for by id still gets its error.
      return undoMoves(input.ids?.length ? moves : moves.filter((m) => m.to !== null));
    }),
    forget: api.history.forget.handler(({ input }) => input.ids.map(forgetMove)),
  },

  recover: {
    // The server does not run recovery before this call (see server.ts), so the count is of this run.
    run: api.recover.run.handler(() => {
      const before = pendingOperations().length;
      try {
        withMoveLock(recoverPendingMoves);
      } catch (err) {
        // Some are still stuck: the answer lists them.
        if (!(err instanceof TidyError && err.code === "recovery_required")) throw err;
      }
      const interrupted = pendingOperations();
      return { resolved: before - interrupted.length, interrupted };
    }),
    abandon: api.recover.abandon.handler(({ input }) => input.ids.map(abandonOperation)),
  },

  find: api.find.handler(({ input }) => findSummaries(input.query, { limit: input.limit ?? 20, includeMissing: input.includeMissing })),

  places: {
    list: api.places.list.handler(() => ({ scope: activeScope(), file: placesFile(), places: loadPlaces() })),
    add: api.places.add.handler(({ input }) => addPlace(input)),
    update: api.places.update.handler(({ input }) => updatePlace(input.name, input.patch)),
    remove: api.places.remove.handler(({ input }) => removePlace(input.name)),
  },

  rules: {
    list: api.rules.list.handler(() => ({ byScope: loadRules() })),
    add: api.rules.add.handler(({ input }) => addRule(input.text, input.scope)),
    remove: api.rules.remove.handler(({ input }) => removeRule(input.position, input.scope)),
  },

  config: {
    get: api.config.get.handler(() => ({ config: loadConfig(), global: loadGlobalConfig(), scope: activeScope(), keys: [...SCALAR_KEYS] })),
    set: api.config.set.handler(({ input }) => setConfigValue(input.key, input.value, input.scope)),
    unset: api.config.unset.handler(({ input }) => unsetConfigValue(input.key, input.scope)),
  },

  sensitive: {
    get: api.sensitive.get.handler(() => {
      const config = loadConfig();
      const { allowedIn, secretRuleScope } = sensitiveScopes();
      const index = new FileIndex();
      return {
        rules: [
          ...RULES.map((r) => ({ id: r.id, kind: r.kind, reason: r.reason, allowed: allowedIn.has(r.id), allowedIn: allowedIn.get(r.id) ?? [] })),
          ...config.secretRules.map((r) => ({
            id: `custom.${r.name}`,
            kind: "content" as const,
            reason: r.reason || `secret value (custom: ${r.name})`,
            allowed: false,
            allowedIn: [],
            custom: { ...(r.prefix ? { prefix: r.prefix } : { regex: r.regex }), scope: secretRuleScope.get(r.name) ?? activeScope() },
          })),
        ],
        files: Object.values(loadAllowances()).map((a) => ({ ...a, paths: index.pathsFor(a.hash) })),
      };
    }),
    setRule: api.sensitive.setRule.handler(({ input }) => setRuleAllowed(input.id, input.allowed, input.scope)),
    addCustomRule: api.sensitive.addCustomRule.handler(({ input }) => addSecretRule(input.rule, input.scope)),
    removeCustomRule: api.sensitive.removeCustomRule.handler(({ input }) => removeSecretRule(input.name.replace(/^custom\./, ""), input.scope)),
    revoke: api.sensitive.revoke.handler(({ input }) => {
      const index = new FileIndex();
      return input.hashes.map((hash) => {
        const removed = removeAllowance(hash);
        if (!removed) throw new TidyError(`No exception for ${hash}`, "not_found");
        return { ...removed, paths: index.pathsFor(hash) };
      });
    }),
  },

  maintenance: {
    compact: api.maintenance.compact.handler(() => {
      const config = loadConfig();
      return { droppedMoves: compactHistory(config.historyMaxMoves), droppedSummaries: compactSummaries(config.summariesMax) };
    }),
    prune: api.maintenance.prune.handler(() => {
      const index = new FileIndex();
      const pruned = index.prune();
      index.save();
      return { pruned };
    }),
  },
});
