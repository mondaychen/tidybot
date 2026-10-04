import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPlan } from "../src/mover.js";
import { propose } from "../src/planner.js";
import { addFolder } from "../src/store/folders.js";
import { loadMoves } from "../src/store/history.js";
import { withMoveLock } from "../src/store/operations.js";
import { loadPlan, savePlan } from "../src/store/plans.js";
import { sandbox, write } from "./helpers.js";

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

describe("discarded plan lifecycle", () => {
  it.each([false, true])("rejects a discarded plan passed explicitly to apply (dryRun=%s)", async (dryRun) => {
    const file = write(path.join(dl, "report.txt"), "original contents");
    const plan = await propose([{ file, folder: "Docs" }], { source: dl });
    plan.discarded = true;
    savePlan(plan);
    const repo = fileURLToPath(new URL("../", import.meta.url));
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "src/cli.ts", "--json", "apply", plan.id,
      ...(dryRun ? ["--dry-run"] : ["--yes"]),
    ], { cwd: repo, env: process.env, encoding: "utf8", timeout: 10_000 });

    expect(result.error).toBeUndefined();
    expect.soft(result.status).toBe(1);
    expect.soft(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/discard/i) } });
    expect.soft(fs.existsSync(file)).toBe(true);
    expect.soft(fs.existsSync(path.join(docs, "report.txt"))).toBe(false);
    expect.soft(loadMoves()).toEqual([]);
    expect(loadPlan(plan.id).items[0]?.status).toBe("pending");
  });
});

describe("history rewrites", () => {
  it.each(["compact", "forget"])("%s waits for a running move instead of racing its history append", async (command) => {
    const file = write(path.join(dl, "report.txt"), "original contents");
    const { moved } = applyPlan(await propose([{ file, folder: "Docs" }], { source: dl }));
    const repo = fileURLToPath(new URL("../", import.meta.url));
    const args = command === "forget" ? ["forget", moved[0]!.operationId] : ["compact"];
    withMoveLock(() => {
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--json", ...args], {
        cwd: repo, env: process.env, encoding: "utf8", timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe("busy");
    });
    expect(loadMoves()[0]?.state).toBe("active");
  });
});
