import { oc, type } from "@orpc/contract";
import { z } from "zod";

/**
 * The contract between the tidybot UI server (src/ui/router.ts) and the web frontend (web/).
 * This file is the only code the two share, and it imports only zod and @orpc/contract: never
 * server code. The server implements it with `implement(contract)`; the frontend's client is typed
 * from it. Inputs are zod schemas, checked on the server. Outputs are plain types (`type<T>()`),
 * checked by the compiler against what the handlers return.
 */

export type Scope = "global" | "project";

// ---------------------------------------------------------------- data

export type TrashStatus = { enabled: true; target: string } | { enabled: false; reason: string };

export type ItemStatus = "pending" | "invalid" | "skipped" | "moved" | "trashed" | "failed";
export type PlanState = "open" | "done" | "discarded";

export interface PlanItem {
  /** Absolute path; also the item's id in calls that change a plan. */
  file: string;
  place: string | null;
  destination: string | null;
  delete?: boolean;
  newName?: string;
  reason?: string;
  confidence?: number;
  summarySkipped?: string;
  status: ItemStatus;
  warnings?: string[];
  note?: string;
  operationId?: string;
}

export interface PlaceInfo {
  name: string;
  path: string;
  rule: string;
}

export interface PlanContext {
  recordedAt: string;
  rename: string;
  naming: string;
  extensionCase?: string;
  rules: string[];
  places: PlaceInfo[];
}

export interface Plan {
  id: string;
  createdAt: string;
  source: string;
  discarded?: boolean;
  context?: PlanContext;
  items: PlanItem[];
  state: PlanState;
}

export interface PlanSummary {
  id: string;
  state: PlanState;
  createdAt: string;
  source: string;
  pending: number;
  total: number;
}

export interface Move {
  id: string;
  at: string;
  planId?: string;
  from: string;
  /** Null for a file sent to the system Trash. */
  to: string | null;
  trash?: "folder" | "system";
  state: "active" | "undone" | "forgotten";
  undoneAt?: string;
}

/** A move or undo that was interrupted and that recovery could not finish. */
export interface InterruptedOperation {
  id: string;
  from: string;
  /** "" for a file sent to the system Trash. */
  to: string;
  backup?: string;
}

export type RenameMode = "auto" | "always" | "off";
export type ExtensionCase = "keep" | "lower";
export type PersonalKind = "ssn" | "passport" | "id-card" | "card" | "iban" | "birthday" | "email";

export interface Config {
  source: string;
  excerptChars: number;
  maxFiles: number;
  previewChars: number;
  olderThan: string;
  skipOrganized: boolean;
  rename: RenameMode;
  naming: string;
  extensionCase: ExtensionCase;
  historyMaxMoves: number;
  summariesMax: number;
  rules: string[];
  allowRules: string[];
  secretRules: CustomRule[];
  allowDelete: boolean;
  trashDir: string;
  maskPersonal: PersonalKind[];
}

export interface Status {
  version: string;
  home: string;
  /** The user's home directory, to show paths as `~/…`. */
  userHome: string;
  project: string | null;
  /** Where writes go when no scope is given. */
  scope: Scope;
  source: string;
  places: number;
  rules: number;
  rename: RenameMode;
  naming: string;
  trash: TrashStatus;
  openPlans: PlanSummary[];
  undoableMoves: number;
  lastUndoablePlan: string | null;
  interrupted: InterruptedOperation[];
}

export interface ApplyResult {
  moved: { file: string; to: string; operationId: string }[];
  trashed: { file: string; to: string | null; operationId: string }[];
  failed: { file: string; error: string }[];
}

export interface ApplyPreview {
  wouldMove: { file: string; to: string }[];
  wouldTrash: string[];
  trash: TrashStatus;
}

export interface UndoResult {
  undone: { id: string; from: string; to: string }[];
  failed: { id: string; error: string }[];
}

export interface FindHit {
  hash: string;
  score: number;
  summary: string;
  keywords: string[];
  name: string;
  paths: string[];
}

export interface SensitiveRule {
  id: string;
  kind: "name" | "content";
  reason: string;
  /** Turned off (in either scope). */
  allowed: boolean;
  /** Set for the user's own rules. */
  custom?: { prefix?: string; regex?: string };
}

export interface FileAllowance {
  hash: string;
  name: string;
  reason: string;
  content: boolean;
  rule?: string;
  at: string;
  /** Where files with this content are known to be. */
  paths: string[];
}

// ---------------------------------------------------------------- inputs

const scope = z.enum(["global", "project"]);
/** Plan ids name files in plans/, so no path characters. */
const planId = z.string().regex(/^[\w-]+$/, "not a plan id");
const files = z.array(z.string().min(1)).min(1);
const ids = z.array(z.string().min(1)).min(1);

export const SCALAR_KEYS = [
  "source",
  "excerptChars",
  "maxFiles",
  "previewChars",
  "olderThan",
  "skipOrganized",
  "rename",
  "naming",
  "extensionCase",
  "historyMaxMoves",
  "summariesMax",
  "allowDelete",
  "trashDir",
  "maskPersonal",
] as const;
/** Settings changed with `config.set` (the others have their own procedures). */
export type ScalarKey = (typeof SCALAR_KEYS)[number];

const CustomRuleSchema = z.object({ name: z.string(), prefix: z.string().optional(), regex: z.string().optional(), reason: z.string().optional() });
export type CustomRule = z.infer<typeof CustomRuleSchema>;

/** What to change on plan items. Give a place, a path or `delete`, and/or a name (null keeps the
 * original name; one file only). */
const PlanTargetSchema = z.object({
  place: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  name: z.string().min(1).nullable().optional(),
  delete: z.boolean().optional(),
});
export type PlanTarget = z.infer<typeof PlanTargetSchema>;

const PlaceSchema = z.object({ name: z.string(), path: z.string(), rule: z.string() });

// ---------------------------------------------------------------- procedures

export const contract = {
  status: oc.output(type<Status>()),

  plans: {
    list: oc.input(z.object({ all: z.boolean().optional() })).output(type<PlanSummary[]>()),
    get: oc.input(z.object({ id: planId })).output(type<Plan>()),
    retarget: oc.input(z.object({ planId, files, target: PlanTargetSchema })).output(type<Plan>()),
    skip: oc.input(z.object({ planId, files })).output(type<Plan>()),
    discard: oc.input(z.object({ planId })).output(type<Plan>()),
    preview: oc.input(z.object({ planId })).output(type<ApplyPreview>()),
    apply: oc.input(z.object({ planId, onConflict: z.enum(["fail", "rename"]) })).output(type<{ result: ApplyResult; plan: Plan }>()),
  },

  history: {
    list: oc
      .input(z.object({ all: z.boolean().optional(), planId: z.string().min(1).optional(), limit: z.number().int().min(1).optional() }))
      .output(type<Move[]>()),
    /** Give ids, a plan id, or `last` (the most recent batch). */
    undo: oc
      .input(
        z
          .object({ ids: ids.optional(), planId: z.string().min(1).optional(), last: z.boolean().optional() })
          .refine((s) => [s.ids, s.planId, s.last].filter(Boolean).length === 1, { message: "give one of ids, planId or last" }),
      )
      .output(type<UndoResult>()),
    forget: oc.input(z.object({ ids })).output(type<Move[]>()),
  },

  recover: {
    run: oc.output(type<{ resolved: number; interrupted: InterruptedOperation[] }>()),
    abandon: oc.input(z.object({ ids })).output(type<InterruptedOperation[]>()),
  },

  find: oc
    .input(z.object({ query: z.string().trim().min(1), limit: z.number().int().min(1).optional(), includeMissing: z.boolean().optional() }))
    .output(type<FindHit[]>()),

  places: {
    list: oc.output(type<{ scope: Scope; file: string; places: PlaceInfo[] }>()),
    add: oc.input(PlaceSchema).output(type<PlaceInfo>()),
    update: oc.input(z.object({ name: z.string().min(1), patch: PlaceSchema.partial() })).output(type<PlaceInfo>()),
    remove: oc.input(z.object({ name: z.string().min(1) })).output(type<PlaceInfo>()),
  },

  rules: {
    list: oc.output(type<{ byScope: { scope: Scope; rules: string[] }[] }>()),
    add: oc.input(z.object({ text: z.string(), scope })).output(type<string[]>()),
    /** `position` is 1-based within the scope's list. */
    remove: oc.input(z.object({ position: z.number().int().min(1), scope })).output(type<string>()),
  },

  config: {
    get: oc.output(type<{ config: Config; scope: Scope; keys: ScalarKey[] }>()),
    set: oc.input(z.object({ key: z.enum(SCALAR_KEYS), value: z.string(), scope })).output(type<Config>()),
    unset: oc.input(z.object({ key: z.enum(SCALAR_KEYS), scope })).output(type<Config>()),
  },

  sensitive: {
    get: oc.output(type<{ rules: SensitiveRule[]; files: FileAllowance[] }>()),
    setRule: oc.input(z.object({ id: z.string().min(1), allowed: z.boolean(), scope })).output(type<string[]>()),
    addCustomRule: oc.input(z.object({ rule: CustomRuleSchema, scope })).output(type<CustomRule[]>()),
    removeCustomRule: oc.input(z.object({ name: z.string().min(1), scope })).output(type<CustomRule>()),
    revoke: oc.input(z.object({ hashes: ids })).output(type<FileAllowance[]>()),
  },

  maintenance: {
    compact: oc.output(type<{ droppedMoves: number; droppedSummaries: number }>()),
    prune: oc.output(type<{ pruned: number }>()),
  },
};
