import fs from "node:fs";
import os from "node:os";
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
  loadRules,
  removeRule,
  removeSecretRule,
  setConfigValue,
  setRuleAllowed,
  unsetConfigValue,
} from "../store/config.js";
import { loadMoves } from "../store/history.js";
import { abandonOperation, pendingOperations, recoverPendingMoves, withMoveLock } from "../store/operations.js";
import { addPlace, loadPlaces, placesFile, removePlace, updatePlace } from "../store/places.js";
import { type Plan as StoredPlan, listPlans, loadPlan, planState, savePlan } from "../store/plans.js";
import { FileIndex, compactSummaries, findSummaries } from "../store/summaries.js";
import { trashStatus } from "../trash.js";
import { type Plan, type PlanSummary, SCALAR_KEYS, contract } from "./contract.js";

// The contract keeps its own copy of the settable keys, because it can't import server code.
// These two lines fail to compile when the lists differ.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const keysMatch: Same<(typeof SCALAR_KEYS)[number], (typeof CONFIG_KEYS)[number]> = true;
void keysMatch;

// package.json sits at the package root, two levels up from both src/ui/ and dist/ui/.
const { version } = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

const toPlan = (p: StoredPlan): Plan => ({ ...p, state: planState(p) });

const toSummary = (p: StoredPlan): PlanSummary => ({
  id: p.id,
  state: planState(p),
  createdAt: p.createdAt,
  source: p.source,
  pending: p.items.filter((i) => i.status === "pending").length,
  total: p.items.length,
});

const api = implement(contract);

/** Every procedure in the contract, implemented with the functions the CLI uses. */
export const router = api.router({
  status: api.status.handler(() => {
    const config = loadConfig();
    // Applied and not undone. Files sent to the system Trash are restored from there, not by undo.
    const undoable = loadMoves().filter((m) => m.state === "active" && m.to !== null);
    return {
      version,
      home: tidybotHome(),
      userHome: os.homedir(),
      project: projectDir() ?? null,
      scope: activeScope(),
      source: config.source,
      places: loadPlaces().length,
      rules: config.rules.length,
      rename: config.rename,
      naming: config.naming,
      trash: trashStatus(config),
      openPlans: listPlans().filter((p) => planState(p) === "open").map(toSummary),
      undoableMoves: undoable.length,
      lastUndoablePlan: undoable.findLast((m) => m.planId)?.planId ?? null,
      interrupted: pendingOperations(),
    };
  }),

  plans: {
    list: api.plans.list.handler(({ input }) => listPlans().filter((p) => input.all || planState(p) === "open").map(toSummary)),
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
      return { wouldMove: preview.wouldMove ?? [], wouldTrash: preview.wouldTrash ?? [], trash: trashStatus(loadConfig()) };
    }),
    apply: api.plans.apply.handler(async ({ input }) => {
      const plan = loadPlan(input.planId);
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
    undo: api.history.undo.handler(({ input }) => undoMoves(selectMoves(input))),
    forget: api.history.forget.handler(({ input }) => input.ids.map(forgetMove)),
  },

  recover: {
    run: api.recover.run.handler(() => ({ resolved: withMoveLock(recoverPendingMoves), interrupted: pendingOperations() })),
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
    get: api.config.get.handler(() => ({ config: loadConfig(), scope: activeScope(), keys: [...SCALAR_KEYS] })),
    set: api.config.set.handler(({ input }) => setConfigValue(input.key, input.value, input.scope)),
    unset: api.config.unset.handler(({ input }) => unsetConfigValue(input.key, input.scope)),
  },

  sensitive: {
    get: api.sensitive.get.handler(() => {
      const config = loadConfig();
      const off = new Set(config.allowRules);
      const index = new FileIndex();
      return {
        rules: [
          ...RULES.map((r) => ({ id: r.id, kind: r.kind, reason: r.reason, allowed: off.has(r.id) })),
          ...config.secretRules.map((r) => ({
            id: `custom.${r.name}`,
            kind: "content" as const,
            reason: r.reason || `secret value (custom: ${r.name})`,
            allowed: false,
            custom: r.prefix ? { prefix: r.prefix } : { regex: r.regex },
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
