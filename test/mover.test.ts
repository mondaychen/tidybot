import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPlan, moveFile, selectMoves, undoMoves } from "../src/mover.js";
import { propose } from "../src/planner.js";
import { scan } from "../src/scan.js";
import { addFolder } from "../src/store/folders.js";
import { loadMoves } from "../src/store/history.js";
import { FileIndex, findSummaries } from "../src/store/summaries.js";
import { getSummaries } from "../src/summarize.js";
import { caseInsensitiveFs, sandbox, write } from "./helpers.js";

let root: string;
let dl: string;
let docs: string;

beforeEach(() => {
  root = sandbox();
  dl = path.join(root, "dl");
  fs.mkdirSync(dl);
  docs = path.join(root, "docs");
  fs.mkdirSync(docs);
  addFolder({ name: "Docs", path: docs });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("move safety", () => {
  it("rolls a completed move back if appending its history record fails", async () => {
    const from = write(path.join(dl, "report.txt"), "original contents");
    const to = path.join(docs, "report.txt");
    const plan = await propose([{ file: from, folder: "Docs" }], { source: dl });
    const open = fs.openSync;
    let failedAfterMove = false;
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      if (file === path.join(root, "home", "history.jsonl") && flags === "a") {
        failedAfterMove = fs.existsSync(to) && !fs.existsSync(from);
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      return open(file, flags, mode);
    });
    expect(applyPlan(plan).failed).toHaveLength(1);
    expect(failedAfterMove).toBe(true);
    expect(fs.readFileSync(from, "utf8")).toBe("original contents");
    expect(fs.existsSync(to)).toBe(false);
    expect(loadMoves()).toEqual([]);
    expect(fs.readdirSync(path.join(root, "home", "operations"))).toEqual([]);
  });

  it("does not leave a moved file without undo history when recording fails", async () => {
    const from = write(path.join(dl, "report.txt"), "original contents");
    const to = path.join(docs, "report.txt");
    const plan = await propose([{ file: from, folder: "Docs" }], { source: dl });
    // A directory at the log path reliably blocks writes, even when run as root.
    const history = path.join(root, "home", "history.jsonl");
    fs.mkdirSync(history);
    try {
      applyPlan(plan);
    } catch (err) {
      // Rejecting the operation before moving is also a safe outcome.
      expect(err).toBeInstanceOf(Error);
    } finally {
      fs.rmdirSync(history);
    }

    // Either the file stayed/was rolled back, or a completed move is undoable.
    if (!fs.existsSync(from)) {
      const moves = loadMoves().filter((m) => m.planId === plan.id && m.state === "active");
      expect(moves).toHaveLength(1);
      expect(undoMoves(moves).failed).toEqual([]);
    }
    expect(fs.readFileSync(from, "utf8")).toBe("original contents");
    expect(fs.existsSync(to)).toBe(false);
  });

  it("preserves both files if another writer creates the destination during a move", () => {
    const from = write(path.join(dl, "report.txt"), "source contents");
    const to = path.join(docs, "report.txt");
    let raced = false;
    const arrive = (destination: fs.PathLike) => {
      if (String(destination) === to && !raced) {
        write(to, "concurrent writer's contents");
        raced = true;
      }
    };
    // Inject at the filesystem mutation boundary, without sleeps or scheduling
    // assumptions. Cover rename and the exclusive link/copy alternatives.
    const rename = fs.renameSync;
    const link = fs.linkSync;
    const copy = fs.copyFileSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      arrive(destination);
      rename(source, destination);
    });
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      arrive(destination);
      link(source, destination);
    });
    vi.spyOn(fs, "copyFileSync").mockImplementation((source, destination, mode) => {
      arrive(destination);
      copy(source, destination, mode);
    });

    let error: unknown;
    try {
      moveFile(from, to);
    } catch (err) {
      error = err;
    }
    expect(raced).toBe(true);
    expect(fs.readFileSync(to, "utf8")).toBe("concurrent writer's contents");
    expect(fs.readFileSync(from, "utf8")).toBe("source contents");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("cache identity after edits", () => {
  it.each(["apply", "undo"] as const)("does not revive a stale hash during %s", async (operation) => {
    const from = write(path.join(dl, "report.txt"), "old data");
    const to = path.join(docs, "report.txt");
    await scan(dl, { maxFiles: 10, excerptChars: 100 });
    const oldHash = new FileIndex().cachedHash(from);
    expect(oldHash).toBeTruthy();
    const plan = await propose([{ file: from, folder: "Docs" }], { source: dl });
    if (operation === "undo") expect(applyPlan(plan).failed).toEqual([]);

    const edited = operation === "apply" ? from : to;
    const oldStat = fs.statSync(edited);
    write(edited, "new data"); // Same size; make the mtime change deterministic.
    const changedAt = new Date(oldStat.mtimeMs + 10_000);
    fs.utimesSync(edited, changedAt, changedAt);
    expect(new FileIndex().cachedHash(edited)).toBeUndefined();
    if (operation === "apply") expect(applyPlan(plan).failed).toEqual([]);
    else expect(undoMoves(selectMoves({ planId: plan.id })).failed).toEqual([]);

    const destination = operation === "apply" ? to : from;
    const [result] = await getSummaries([destination], root);
    expect(result?.hash).not.toBe(oldHash);
    expect(result?.summary?.summary).not.toBe("old data");
    expect(fs.readFileSync(destination, "utf8")).toBe("new data");
  });
});

describe("filename handling", () => {
  it("a long Chinese rename succeeds at apply time", async () => {
    write(path.join(dl, "3f2a.pdf"), "x");
    const plan = await propose([{ file: "3f2a.pdf", folder: "Docs", rename: "年度财务报告".repeat(30) }], { source: dl });
    const r = applyPlan(plan);
    expect(r.failed).toEqual([]);
    expect(r.moved).toHaveLength(1);
    const name = path.basename(r.moved[0]!.to);
    expect(name.startsWith("年度财务报告")).toBe(true);
    expect(name.endsWith(".pdf")).toBe(true);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
    expect(fs.readdirSync(docs)).toEqual([name]);
  });

  it.runIf(caseInsensitiveFs())("renames a file to a case-only variant and undoes it", async () => {
    write(path.join(dl, "report.pdf"), "x");
    const plan = await propose([{ file: "report.pdf", folder: null, rename: "Report" }], { source: dl });
    expect(plan.items[0]?.warnings).toBeUndefined();
    expect(applyPlan(plan).failed).toEqual([]);
    expect(fs.readdirSync(dl)).toEqual(["Report.pdf"]);
    undoMoves(selectMoves({ last: true }));
    expect(fs.readdirSync(dl)).toEqual(["report.pdf"]);
  });
});

describe("cross-device moves", () => {
  it("keep a summarized file findable at its new location", async () => {
    const from = write(path.join(dl, "notes.txt"), "quarterly planning notes");
    fs.utimesSync(from, 1790611498.797949, 1790611498.797949);
    await scan(dl, { maxFiles: 10, excerptChars: 100 });
    expect((await findSummaries("quarterly", { limit: 5 }))[0]?.paths).toEqual([from]);
    const plan = await propose([{ file: from, folder: "Docs" }], { source: dl });
    const link = fs.linkSync;
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      if (source === from) throw Object.assign(new Error("cross device"), { code: "EXDEV" });
      link(source, destination);
    });
    expect(applyPlan(plan).moved).toHaveLength(1);
    expect((await findSummaries("quarterly", { limit: 5 }))[0]?.paths).toEqual([path.join(docs, "notes.txt")]);
  });
});
