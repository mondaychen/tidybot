import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { applyPlan, forgetMove, selectMoves, undoMoves } from "../src/mover.js";
import { propose, retarget, skip } from "../src/planner.js";
import { scan } from "../src/scan.js";
import { addPlace, importPlaces, loadPlaces } from "../src/store/places.js";
import { loadMoves } from "../src/store/history.js";
import { loadPlan, planState } from "../src/store/plans.js";
import { survey } from "../src/survey.js";
import { sandbox, write } from "./helpers.js";

let root: string;
let dl: string;
beforeEach(() => {
  root = sandbox();
  dl = path.join(root, "dl");
  write(path.join(dl, "invoice.txt"), "ComEd bill");
  write(path.join(dl, "roadmap.md"), "Q3 roadmap");
  write(path.join(dl, ".hidden"), "x");
  addPlace({ name: "Bills", path: path.join(root, "docs/bills"), rule: "bills" });
  addPlace({ name: "Work", path: path.join(root, "docs/work"), rule: "work" });
});

describe("places", () => {
  it("rejects duplicate names (case-insensitive) and paths", () => {
    expect(() => addPlace({ name: "bills", path: path.join(root, "other") })).toThrow(/Duplicate/);
    expect(() => addPlace({ name: "Other", path: path.join(root, "docs/bills/") })).toThrow(/share the path/);
  });

  it("imports by merging on name, with dry-run", () => {
    const dry = importPlaces([{ name: "Bills", path: "~/bills", rule: "new" }, { name: "Photos", path: "~/Pictures" }], { dryRun: true });
    expect(dry.added.map((f) => f.name)).toEqual(["Photos"]);
    expect(dry.updated.map((f) => f.name)).toEqual(["Bills"]);
    expect(loadPlaces()).toHaveLength(2);
    importPlaces({ places: [{ name: "Photos", path: "~/Pictures" }] });
    expect(loadPlaces().map((f) => f.name)).toEqual(["Bills", "Work", "Photos"]);
  });

  it("pins relative paths to absolute", () => {
    const f = addPlace({ name: "Rel", path: "some/dir" });
    expect(path.isAbsolute(f.path)).toBe(true);
  });
});

describe("scan & survey", () => {
  it("lists visible files with excerpts", async () => {
    const { files } = await scan(dl, { maxFiles: 10, excerptChars: 100 });
    expect(files.map((f) => f.rel)).toEqual(["invoice.txt", "roadmap.md"]);
    expect(files[0]?.excerpt).toBe("ComEd bill");
  });

  it("caps and filters", async () => {
    expect((await scan(dl, { maxFiles: 1, excerptChars: 0 })).truncated).toBe(true);
    expect((await scan(dl, { maxFiles: 10, excerptChars: 0, match: "*.MD" })).files.map((f) => f.name)).toEqual(["roadmap.md"]);
    expect((await scan(dl, { maxFiles: 10, excerptChars: 0, match: "*.{txt,md}" })).files.map((f) => f.name)).toEqual(["invoice.txt", "roadmap.md"]);
    expect((await scan(dl, { maxFiles: 10, excerptChars: 0, match: "invoice.tx?" })).files.map((f) => f.name)).toEqual(["invoice.txt"]);
  });

  it("summarizes directory trees", () => {
    write(path.join(root, "docs/bills/a.pdf"));
    write(path.join(root, "docs/bills/b.pdf"));
    const s = survey(path.join(root, "docs"), { depth: 2, samples: 1, maxDirs: 10 });
    const bills = s.dirs.find((d) => d.path.endsWith("bills"));
    expect(bills).toMatchObject({ files: 2, topExtensions: [{ ext: ".pdf", count: 2 }], sampleNames: ["a.pdf"] });
    expect(s.dirs[0]?.totalFiles).toBe(2);
  });
});

describe("propose → apply → undo", () => {
  const proposeBoth = () =>
    propose(
      {
        items: [
          { file: "invoice.txt", place: "bills", reason: "utility bill", confidence: 0.9 },
          { file: "roadmap.md", place: "Work" },
          { file: "missing.txt", place: "Work" },
        ],
      },
      { source: dl },
    );

  it("validates proposals into item statuses", async () => {
    const plan = await proposeBoth();
    expect(plan.items.map((i) => i.status)).toEqual(["pending", "pending", "invalid"]);
    expect(plan.items[0]?.place).toBe("Bills");
    const bad = await propose([{ file: "invoice.txt", place: "Nope" }], { source: dl });
    expect(bad.items[0]).toMatchObject({ status: "invalid", note: 'unknown place "Nope"' });
    const none = await propose([{ file: "invoice.txt", place: null }], { source: dl });
    expect(none.items[0]?.status).toBe("skipped");
  });

  it("rejects malformed input", async () => {
    await expect(propose({ items: [{ file: "x" }] }, { source: dl })).rejects.toThrow(/Invalid proposal/);
  });

  it("moves files, records history, and undoes a whole plan", async () => {
    const plan = await proposeBoth();
    expect((await applyPlan(plan, { dryRun: true })).wouldMove).toHaveLength(2);
    expect(fs.existsSync(path.join(dl, "invoice.txt"))).toBe(true);

    const r = await applyPlan(plan);
    expect(r.moved).toHaveLength(2);
    expect(fs.existsSync(path.join(root, "docs/bills/invoice.txt"))).toBe(true);
    expect(planState(loadPlan(plan.id))).toBe("done");
    expect(loadMoves().every((m) => m.planId === plan.id && m.state === "active")).toBe(true);

    const u = undoMoves(selectMoves({ last: true }));
    expect(u.undone).toHaveLength(2);
    expect(fs.existsSync(path.join(dl, "invoice.txt"))).toBe(true);
    expect(loadMoves().every((m) => m.state === "undone")).toBe(true);
  });

  it("never overwrites; can rename on conflict", async () => {
    write(path.join(root, "docs/bills/invoice.txt"), "existing");
    const p1 = await propose([{ file: "invoice.txt", place: "Bills" }], { source: dl });
    expect((await applyPlan(p1)).failed[0]?.error).toMatch(/already exists/);
    expect(fs.readFileSync(path.join(root, "docs/bills/invoice.txt"), "utf8")).toBe("existing");

    const p2 = await propose([{ file: "invoice.txt", place: "Bills" }], { source: dl });
    const r = await applyPlan(p2, { onConflict: "rename" });
    expect(r.moved[0]?.to).toBe(path.join(root, "docs/bills/invoice (1).txt"));
  });

  it("lets the user retarget and skip", async () => {
    const plan = await proposeBoth();
    retarget(plan, "invoice.txt", { path: path.join(root, "custom") });
    skip(plan, "roadmap.md");
    await applyPlan(plan);
    expect(fs.existsSync(path.join(root, "custom/invoice.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dl, "roadmap.md"))).toBe(true);
  });

  it("appends to an existing plan, later proposals win", async () => {
    const plan = await propose([{ file: "invoice.txt", place: "Work" }], { source: dl });
    await propose([{ file: "invoice.txt", place: "Bills" }, { file: "roadmap.md", place: "Work" }], { source: dl, appendTo: loadPlan(plan.id) });
    const merged = loadPlan(plan.id);
    expect(merged.items.map((i) => [path.basename(i.file), i.place])).toEqual([
      ["invoice.txt", "Bills"],
      ["roadmap.md", "Work"],
    ]);
  });

  it("reports failed undo and allows forgetting the entry", async () => {
    const plan = await proposeBoth();
    await applyPlan(plan);
    fs.rmSync(path.join(root, "docs/bills/invoice.txt"));
    const u = undoMoves(selectMoves({ planId: plan.id }));
    expect(u.undone).toHaveLength(1);
    expect(u.failed).toHaveLength(1);
    const failedId = u.failed[0]?.id as string;
    forgetMove(failedId);
    expect(loadMoves().find((m) => m.id === failedId)?.state).toBe("forgotten");
    expect(() => undoMoves(selectMoves({ ids: [failedId] }))).toThrow(/already forgotten/);
  });
});
