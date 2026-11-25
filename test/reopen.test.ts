import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TidyError } from "../src/errors.js";
import { applyPlan, forgetMove, selectMoves, undoMoves } from "../src/mover.js";
import { SAME_FILE_WARNING, propose, reopenPlan } from "../src/planner.js";
import { setConfigValue } from "../src/store/config.js";
import { addPlace, removePlace, updatePlace } from "../src/store/places.js";
import { type Plan, loadPlan, planState, savePlan } from "../src/store/plans.js";
import { onPlatform, sandbox, write } from "./helpers.js";

/** Stands in for the system Trash, so tests never touch the real one. */
const systemTrash = vi.hoisted(() => ({ dir: "" }));
vi.mock("trash", () => ({
  default: vi.fn(async (paths: string[]) => {
    for (const p of paths) fs.renameSync(p, path.join(systemTrash.dir, path.basename(p)));
  }),
}));

let root: string;
let dl: string;
beforeEach(() => {
  root = sandbox();
  dl = path.join(root, "dl");
  write(path.join(dl, "bill.txt"), "electric bill");
  write(path.join(dl, "notes.md"), "meeting notes");
  write(path.join(dl, "keep.txt"), "keep me");
  addPlace({ name: "Bills", path: path.join(root, "bills"), rule: "bills" });
  addPlace({ name: "Work", path: path.join(root, "work"), rule: "work" });
});

const at = (name: string) => path.join(dl, name);
const itemOf = (plan: Plan, name: string) => plan.items.find((i) => i.file === at(name));

async function applied(): Promise<Plan> {
  const plan = await propose(
    [
      { file: "bill.txt", place: "Bills", reason: "a bill", confidence: 0.9 },
      { file: "notes.md", place: "Work", rename: "2025 meeting" },
      { file: "keep.txt", skip: true },
    ],
    { source: dl },
  );
  await applyPlan(plan);
  return loadPlan(plan.id);
}

/** The error code that `fn` throws. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof TidyError) return err.code ?? "";
    throw err;
  }
  throw new Error("expected an error");
}

describe("plan reopen", () => {
  it("copies an undone plan into a new open plan, and leaves the old plan as it was", async () => {
    const old = await applied();
    undoMoves(selectMoves({ planId: old.id }));
    const before = fs.readFileSync(path.join(process.env.TIDYBOT_HOME as string, "plans", `${old.id}.json`), "utf8");

    const { plan, left } = reopenPlan(old);
    expect(left).toEqual([]);
    expect(plan.id).not.toBe(old.id);
    expect(plan).toMatchObject({ source: dl, reopenedFrom: old.id, context: old.context });
    expect(planState(plan)).toBe("open");
    expect(itemOf(plan, "bill.txt")).toEqual({
      file: at("bill.txt"),
      place: "Bills",
      destination: path.join(root, "bills"),
      reason: "a bill",
      confidence: 0.9,
      status: "pending",
    });
    expect(itemOf(plan, "notes.md")).toMatchObject({ newName: "2025 meeting.md", status: "pending" });
    expect(itemOf(plan, "keep.txt")).toMatchObject({ status: "skipped", note: "left in place by agent" });
    expect(fs.readFileSync(path.join(process.env.TIDYBOT_HOME as string, "plans", `${old.id}.json`), "utf8")).toBe(before);

    // The new plan applies like any other.
    const result = await applyPlan(plan);
    expect(result.failed).toEqual([]);
    expect(fs.existsSync(path.join(root, "work", "2025 meeting.md"))).toBe(true);
  });

  it("leaves out files that are not back, and says where they are", async () => {
    onPlatform("darwin");
    systemTrash.dir = path.join(root, "system-trash");
    fs.mkdirSync(systemTrash.dir);
    write(at("copy.txt"), "electric bill");
    write(at("gone.txt"), "x");
    const plan = await propose(
      [
        { file: "bill.txt", place: "Bills" },
        { file: "notes.md", place: "Work" },
        { file: "copy.txt", delete: true },
        { file: "gone.txt", place: "Work" },
      ],
      { source: dl },
    );
    await applyPlan(plan);
    const old = loadPlan(plan.id);
    const billMove = itemOf(old, "bill.txt")?.operationId as string;
    undoMoves(selectMoves({ ids: [billMove] }));
    // gone.txt is put back, then deleted by the user.
    undoMoves(selectMoves({ ids: [itemOf(old, "gone.txt")?.operationId as string] }));
    fs.rmSync(at("gone.txt"));

    const { plan: reopened, left } = reopenPlan(old);
    expect(reopened.items.map((i) => path.basename(i.file))).toEqual(["bill.txt"]);
    expect(left).toEqual([
      { file: at("notes.md"), reason: "stillMoved", at: path.join(root, "work", "notes.md"), undoId: itemOf(old, "notes.md")?.operationId },
      { file: at("copy.txt"), reason: "systemTrash" },
      { file: at("gone.txt"), reason: "missing" },
    ]);
  });

  it("knows where a file is after its history entry was dropped", async () => {
    const old = await applied();
    forgetMove(itemOf(old, "bill.txt")?.operationId as string);
    undoMoves(selectMoves({ planId: old.id }));
    const { left } = reopenPlan(old);
    expect(left).toContainEqual({ file: at("bill.txt"), reason: "stillMoved", at: path.join(root, "bills", "bill.txt") });
  });

  it("warns when a file is back but tidybot didn't put it back", async () => {
    const old = await applied();
    // The user moves the file back by hand, so the history still shows the move.
    fs.renameSync(path.join(root, "bills", "bill.txt"), at("bill.txt"));
    const { plan } = reopenPlan(old);
    expect(itemOf(plan, "bill.txt")).toMatchObject({ status: "pending", warnings: [SAME_FILE_WARNING] });
  });

  it("resolves destinations from the current places", async () => {
    const old = await applied();
    undoMoves(selectMoves({ planId: old.id }));
    updatePlace("Bills", { path: path.join(root, "paperwork") });
    removePlace("Work");
    const { plan } = reopenPlan(old);
    expect(itemOf(plan, "bill.txt")).toMatchObject({ status: "pending", destination: path.join(root, "paperwork") });
    expect(itemOf(plan, "notes.md")).toMatchObject({ status: "invalid", note: 'place "Work" no longer exists' });
  });

  it("checks name conflicts again", async () => {
    const old = await applied();
    undoMoves(selectMoves({ planId: old.id }));
    write(path.join(root, "bills", "bill.txt"), "another bill");
    const { plan } = reopenPlan(old);
    expect(itemOf(plan, "bill.txt")?.warnings?.[0]).toMatch(/^conflict: bill.txt already exists/);
  });

  it("puts back deleted files to delete again, while deleting is on", async () => {
    setConfigValue("trashDir", path.join(root, "bin"), "global");
    write(at("copy.txt"), "electric bill");
    const plan = await propose([{ file: "copy.txt", delete: true }], { source: dl });
    await applyPlan(plan);
    undoMoves(selectMoves({ planId: plan.id }));
    const first = reopenPlan(loadPlan(plan.id)).plan;
    expect(itemOf(first, "copy.txt")).toMatchObject({ delete: true, status: "pending" });
    first.discarded = true;
    savePlan(first);

    setConfigValue("allowDelete", "false", "global");
    const again = reopenPlan(loadPlan(plan.id));
    expect(itemOf(again.plan, "copy.txt")).toMatchObject({ status: "invalid", note: expect.stringMatching(/allowDelete=false/) });
  });

  it("reopens a discarded plan", async () => {
    const plan = await propose([{ file: "bill.txt", place: "Bills" }], { source: dl });
    plan.discarded = true;
    savePlan(plan);
    expect(itemOf(reopenPlan(plan).plan, "bill.txt")).toMatchObject({ status: "pending" });
  });

  it("refuses an open plan, a plan with an open copy, and a plan with nothing to reopen", async () => {
    const open = await propose([{ file: "bill.txt", place: "Bills" }], { source: dl });
    expect(codeOf(() => reopenPlan(open))).toBe("invalid_input");

    const old = await applied();
    expect(() => reopenPlan(old)).toThrow(/2 still moved .*tidybot undo --plan/);
    expect(codeOf(() => reopenPlan(old))).toBe("nothing_to_reopen");

    undoMoves(selectMoves({ planId: old.id }));
    const first = reopenPlan(old).plan;
    expect(codeOf(() => reopenPlan(old))).toBe("already_reopened");
    first.discarded = true;
    savePlan(first);
    expect(reopenPlan(old).plan.id).not.toBe(first.id);
  });
});
