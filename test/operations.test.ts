import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPlan, selectMoves, undoMoves } from "../src/mover.js";
import { propose } from "../src/planner.js";
import { scan } from "../src/scan.js";
import { addFolder } from "../src/store/folders.js";
import { loadMoves } from "../src/store/history.js";
import { recoverMoves, withMoveLock } from "../src/store/operations.js";
import { loadPlan, type Plan } from "../src/store/plans.js";
import { findSummaries } from "../src/store/summaries.js";
import { sandbox, write } from "./helpers.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
let root: string;
let from: string;
let to: string;
let plan: Plan;

beforeEach(() => {
  vi.stubEnv("TIDYBOT_HOME", undefined);
  vi.stubEnv("TIDYBOT_NO_PROJECT", undefined);
  vi.stubEnv("TIDYBOT_PROJECT", undefined);
  root = sandbox();
  from = write(path.join(root, "dl", "report.txt"), "original contents");
  to = path.join(root, "docs", "report.txt");
  addFolder({ name: "Docs", path: path.dirname(to) });
  plan = propose([{ file: from, folder: "Docs" }], { source: path.dirname(from) });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function interrupt(at: "before-unlink" | "after-unlink" | "after-commit", undo = false, crossDevice = false): void {
  const source = undo ? to : from;
  const script = `
    import fs from "node:fs";
    import { applyPlan, selectMoves, undoMoves } from "./src/mover.ts";
    import { loadPlan } from "./src/store/plans.ts";
    const unlink = fs.unlinkSync;
    const link = fs.linkSync;
    if (${crossDevice}) fs.linkSync = (from, to) => {
      if (from === ${JSON.stringify(source)}) throw Object.assign(new Error("cross device"), {code: "EXDEV"});
      return link(from, to);
    };
    fs.unlinkSync = (file) => {
      if (file === ${JSON.stringify(source)} && ${JSON.stringify(at)} === "before-unlink") process.exit(77);
      if (${JSON.stringify(at)} === "after-commit" && String(file).includes("/operations/") && String(file).endsWith(".json")) process.exit(77);
      unlink(file);
      if (file === ${JSON.stringify(source)} && ${JSON.stringify(at)} === "after-unlink") process.exit(77);
    };
    ${undo ? `undoMoves(selectMoves({planId: ${JSON.stringify(plan.id)}}));` : `applyPlan(loadPlan(${JSON.stringify(plan.id)}));`}
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: repo, env: process.env, encoding: "utf8", timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(77);
}

describe("move journal recovery", () => {
  it("rolls back an interrupted destination link and permits retry", () => {
    interrupt("before-unlink");
    expect(fs.existsSync(from)).toBe(true);
    expect(fs.existsSync(to)).toBe(true);
    recoverMoves();
    expect(fs.readFileSync(from, "utf8")).toBe("original contents");
    expect(fs.existsSync(to)).toBe(false);
    expect(loadMoves()).toEqual([]);
    expect(applyPlan(loadPlan(plan.id)).moved).toHaveLength(1);
  });

  it.each([false, true])("recovers a completed move after source removal (crossDevice=%s)", (crossDevice) => {
    interrupt("after-unlink", false, crossDevice);
    expect(fs.existsSync(from)).toBe(false);
    // Exercise the real CLI startup recovery rather than calling it explicitly.
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--json", "history"], {
      cwd: repo, env: process.env, encoding: "utf8", timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveLength(1);
    expect(loadPlan(plan.id).items[0]?.status).toBe("moved");
    expect(undoMoves(selectMoves({ planId: plan.id })).failed).toEqual([]);
    expect(fs.readFileSync(from, "utf8")).toBe("original contents");
  });

  it("replays an already committed operation without duplicating history or losing its index", async () => {
    await scan(path.dirname(from), { maxFiles: 10, excerptChars: 100 });
    interrupt("after-commit");
    recoverMoves();
    recoverMoves();
    expect(loadMoves()).toHaveLength(1);
    expect(findSummaries("original", { limit: 10 })[0]?.paths).toEqual([to]);
    expect(fs.readdirSync(path.join(root, "home", "operations"))).toEqual([]);
  });

  it("recovers an interrupted undo", () => {
    expect(applyPlan(plan).moved).toHaveLength(1);
    interrupt("after-unlink", true);
    recoverMoves();
    expect(loadMoves()[0]?.state).toBe("undone");
    expect(fs.readFileSync(from, "utf8")).toBe("original contents");
    expect(fs.existsSync(to)).toBe(false);
  });

  it("repairs a torn final history append using the journal", () => {
    interrupt("after-unlink");
    write(path.join(root, "home", "history.jsonl"), '{"kind":"move",');
    recoverMoves();
    expect(loadMoves()).toHaveLength(1);
    expect(undoMoves(selectMoves({ planId: plan.id })).failed).toEqual([]);
  });

  it("preserves unexpected files and the journal when recovery is ambiguous", () => {
    interrupt("after-unlink");
    write(from, "replacement source");
    write(to, "replacement destination");
    expect(() => recoverMoves()).toThrow(/Cannot safely recover/);
    expect(fs.readFileSync(from, "utf8")).toBe("replacement source");
    expect(fs.readFileSync(to, "utf8")).toBe("replacement destination");
    expect(fs.readdirSync(path.join(root, "home", "operations"))).toHaveLength(1);
  });

  it("refuses overlapping moves while another writer holds the lock", () => {
    withMoveLock(() => expect(() => applyPlan(plan)).toThrow(/Another move/));
    expect(fs.existsSync(from)).toBe(true);
    expect(applyPlan(plan).moved).toHaveLength(1);
  });
});
