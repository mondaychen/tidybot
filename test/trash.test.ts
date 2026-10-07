import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identity } from "../src/file-move.js";
import { applyPlan, forgetMove, selectMoves, undoMoves } from "../src/mover.js";
import { propose, retarget } from "../src/planner.js";
import { listFiles } from "../src/scan.js";
import { setConfigValue } from "../src/store/config.js";
import { addFolder } from "../src/store/folders.js";
import { loadMoves } from "../src/store/history.js";
import { writeJson } from "../src/store/io.js";
import { recoverPendingMoves, withMoveLock } from "../src/store/operations.js";
import { loadPlan } from "../src/store/plans.js";
import { trashStatus } from "../src/trash.js";
import { onPlatform, sandbox, write } from "./helpers.js";

/** Stands in for the system Trash, so tests never touch the real one. */
const systemTrash = vi.hoisted(() => ({ dir: "", calls: [] as unknown[][], fail: undefined as Error | undefined, keep: false }));
vi.mock("trash", () => ({
  default: vi.fn(async (paths: string[], options: unknown) => {
    systemTrash.calls.push([paths, options]);
    if (systemTrash.fail) throw systemTrash.fail;
    if (systemTrash.keep) return;
    for (const p of paths) fs.renameSync(p, path.join(systemTrash.dir, path.basename(p)));
  }),
}));

let root: string;
let dl: string;
let bin: string;

beforeEach(() => {
  root = sandbox();
  dl = path.join(root, "dl");
  bin = path.join(root, "bin");
  Object.assign(systemTrash, { dir: path.join(root, "system-trash"), calls: [], fail: undefined, keep: false });
  fs.mkdirSync(systemTrash.dir);
  addFolder({ name: "Docs", path: path.join(root, "docs") });
  write(path.join(dl, "report.pdf"), "report");
  write(path.join(dl, "report copy.pdf"), "report");
  onPlatform("darwin");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const deleteCopy = () => propose([{ file: "report copy.pdf", delete: true, reason: "duplicate of report.pdf" }], { source: dl });

describe("deleting to a trash folder", () => {
  beforeEach(() => {
    setConfigValue("trashDir", bin, "global");
  });

  it("moves the file into the folder, records it, and undoes it", async () => {
    const plan = await deleteCopy();
    expect(plan.items[0]).toMatchObject({ delete: true, folder: null, destination: null, status: "pending" });
    const r = await applyPlan(plan);
    expect(r.trashed).toEqual([{ file: path.join(dl, "report copy.pdf"), to: path.join(bin, "report copy.pdf"), operationId: expect.any(String) }]);
    expect(fs.existsSync(path.join(dl, "report copy.pdf"))).toBe(false);
    expect(loadPlan(plan.id).items[0]?.status).toBe("trashed");
    expect(loadMoves()[0]).toMatchObject({ trash: "folder", to: path.join(bin, "report copy.pdf") });
    expect(systemTrash.calls).toEqual([]);

    expect(undoMoves(selectMoves({ last: true })).undone).toHaveLength(1);
    expect(fs.readFileSync(path.join(dl, "report copy.pdf"), "utf8")).toBe("report");
  });

  it("renames instead of failing when the trash folder already has that name", async () => {
    write(path.join(bin, "report copy.pdf"), "older");
    const r = await applyPlan(await deleteCopy());
    expect(r.trashed[0]?.to).toBe(path.join(bin, "report copy (1).pdf"));
  });

  it("works on Linux once a trash folder is set", async () => {
    onPlatform("linux");
    expect((await deleteCopy()).items[0]?.status).toBe("pending");
  });

  it("is left out of scans, even inside the scanned folder", () => {
    setConfigValue("trashDir", path.join(dl, "Trash"), "global");
    write(path.join(dl, "Trash", "old.pdf"), "old");
    // runScan adds the trash folder to the skipped folders; this mirrors it.
    const r = listFiles(dl, { maxFiles: 10, recursive: true, skipFolders: [{ name: "trash folder", path: path.join(dl, "Trash"), rule: "" }] });
    expect(r.files.map((f) => f.rel)).not.toContain(path.join("Trash", "old.pdf"));
    expect(r.skippedFolders).toEqual(["trash folder"]);
  });
});

describe("deleting to the system Trash", () => {
  it("sends the file without globbing, and can't undo it", async () => {
    const plan = await deleteCopy();
    const r = await applyPlan(plan);
    expect(r.trashed).toEqual([{ file: path.join(dl, "report copy.pdf"), to: null, operationId: expect.any(String) }]);
    expect(systemTrash.calls).toEqual([[[path.join(dl, "report copy.pdf")], { glob: false }]]);
    expect(fs.existsSync(path.join(systemTrash.dir, "report copy.pdf"))).toBe(true);

    const [entry] = loadMoves();
    expect(entry).toMatchObject({ trash: "system", to: null, state: "active" });
    const u = undoMoves(selectMoves({ last: true }));
    expect(u.failed[0]?.error).toMatch(/system Trash: restore it from there/);
    expect(forgetMove(entry!.id).state).toBe("forgotten");
  });

  it("fails the item and keeps the file when the Trash refuses it", async () => {
    systemTrash.fail = new Error("permission denied");
    const r = await applyPlan(await deleteCopy());
    expect(r.failed[0]?.error).toBe("permission denied");
    expect(fs.existsSync(path.join(dl, "report copy.pdf"))).toBe(true);
    expect(loadMoves()).toEqual([]);
    expect(fs.readdirSync(path.join(root, "home", "operations"))).toEqual([]);
  });

  it("fails the item when the file is still there afterwards", async () => {
    systemTrash.keep = true;
    const r = await applyPlan(await deleteCopy());
    expect(r.failed[0]?.error).toMatch(/still in place/);
    expect(loadMoves()).toEqual([]);
  });

  it("recovers an interrupted deletion from its journal", () => {
    const file = path.join(dl, "report copy.pdf");
    const journal = (id: string) => path.join(root, "home", "operations", `${id}.json`);
    const op = (id: string, from: string) => ({ entry: { kind: "trash", id, at: new Date().toISOString(), from }, from, to: "", source: identity(from) });
    // Crashed after the file went to the Trash, before history was written: record it.
    writeJson(journal("m1"), op("m1", file));
    fs.renameSync(file, path.join(systemTrash.dir, "report copy.pdf"));
    withMoveLock(recoverPendingMoves);
    expect(loadMoves()).toMatchObject([{ id: "m1", trash: "system" }]);
    // Crashed before the file was sent: nothing happened.
    const other = path.join(dl, "report.pdf");
    writeJson(journal("m2"), op("m2", other));
    withMoveLock(recoverPendingMoves);
    expect(loadMoves()).toHaveLength(1);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.readdirSync(path.join(root, "home", "operations"))).toEqual([]);
  });
});

describe("recovering a deletion when a look-alike took the name", () => {
  it("records the deletion instead of assuming nothing happened", () => {
    const file = path.join(dl, "report copy.pdf");
    const stamp = new Date("2026-01-02T03:04:05Z");
    fs.utimesSync(file, stamp, stamp);
    writeJson(path.join(root, "home", "operations", "m1.json"), {
      entry: { kind: "trash", id: "m1", at: new Date().toISOString(), from: file }, from: file, to: "", source: identity(file),
    });
    fs.renameSync(file, path.join(systemTrash.dir, "report copy.pdf"));
    write(file, "REPORT"); // Same size and mtime, different file.
    fs.utimesSync(file, stamp, stamp);
    withMoveLock(recoverPendingMoves);
    expect(loadMoves()).toMatchObject([{ id: "m1", trash: "system" }]);
    expect(fs.readFileSync(file, "utf8")).toBe("REPORT");
  });
});

describe("when deleting is unavailable", () => {
  it("is off when the user opts out", async () => {
    setConfigValue("allowDelete", "false", "global");
    expect(trashStatus({ allowDelete: false, trashDir: "" })).toEqual({ enabled: false, reason: expect.stringMatching(/allowDelete=false/) });
    expect((await deleteCopy()).items[0]).toMatchObject({ status: "invalid", note: expect.stringMatching(/allowDelete=false/) });
  });

  it("is off on Linux until a trash folder is set", async () => {
    onPlatform("linux");
    expect((await deleteCopy()).items[0]).toMatchObject({ status: "invalid", note: expect.stringMatching(/config set trashDir/) });
  });

  it("fails pending deletions if it was turned off after proposing", async () => {
    const plan = await deleteCopy();
    setConfigValue("allowDelete", "false", "global");
    const r = await applyPlan(plan);
    expect(r.failed[0]?.error).toMatch(/allowDelete=false/);
    expect(systemTrash.calls).toEqual([]);
  });
});

describe("proposing and editing deletions", () => {
  it("validates delete items", async () => {
    await expect(propose([{ file: "report.pdf", folder: "Docs", delete: true }], { source: dl })).rejects.toThrow(/can't also have a folder/);
    await expect(propose([{ file: "report.pdf" }], { source: dl })).rejects.toThrow(/needs `folder`/);
    const plan = await propose([{ file: "report copy.pdf", delete: true, rename: "x" }], { source: dl });
    expect(plan.items[0]?.warnings).toEqual(["rename ignored: the file is being deleted"]);
  });

  it("lets the user switch an item between moving and deleting", async () => {
    const plan = await propose([{ file: "report copy.pdf", folder: "Docs" }], { source: dl });
    expect(retarget(plan, "report copy.pdf", { delete: true })).toMatchObject({ delete: true, destination: null, status: "pending" });
    expect(() => retarget(plan, "report copy.pdf", { name: "other" })).toThrow(/set to be deleted/);
    expect(retarget(plan, "report copy.pdf", { folder: "Docs" })).toMatchObject({ delete: undefined, folder: "Docs" });
  });

  it("previews moves and deletions separately", async () => {
    const plan = await propose([{ file: "report.pdf", folder: "Docs" }, { file: "report copy.pdf", delete: true }], { source: dl });
    const preview = await applyPlan(plan, { dryRun: true });
    expect(preview.wouldMove?.map((m) => path.basename(m.file))).toEqual(["report.pdf"]);
    expect(preview.wouldTrash?.map((f) => path.basename(f))).toEqual(["report copy.pdf"]);
  });
});
