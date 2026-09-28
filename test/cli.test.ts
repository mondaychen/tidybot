import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { propose } from "../src/planner.js";
import { addFolder } from "../src/store/folders.js";
import { loadMoves } from "../src/store/history.js";
import { loadPlan, savePlan } from "../src/store/plans.js";
import { sandbox, write } from "./helpers.js";

let root: string;
let dl: string;
let docs: string;

beforeEach(() => {
  // Track environment overrides so sandbox() changes are restored after each test.
  vi.stubEnv("TIDYBOT_HOME", undefined);
  vi.stubEnv("TIDYBOT_NO_PROJECT", undefined);
  vi.stubEnv("TIDYBOT_PROJECT", undefined);
  root = sandbox();
  dl = path.join(root, "dl");
  fs.mkdirSync(dl);
  docs = path.join(root, "docs");
  fs.mkdirSync(docs);
  addFolder({ name: "Docs", path: docs });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("discarded plan lifecycle", () => {
  it.each([false, true])("rejects a discarded plan passed explicitly to apply (dryRun=%s)", (dryRun) => {
    const file = write(path.join(dl, "report.txt"), "original contents");
    const plan = propose([{ file, folder: "Docs" }], { source: dl });
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
