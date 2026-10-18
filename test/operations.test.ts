import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPlan, selectMoves, undoMoves } from "../src/mover.js";
import { propose } from "../src/planner.js";
import { scan } from "../src/scan.js";
import { addPlace } from "../src/store/places.js";
import { loadMoves } from "../src/store/history.js";
import { recoverMoves, withMoveLock } from "../src/store/operations.js";
import { loadPlan, type Plan } from "../src/store/plans.js";
import { findSummaries } from "../src/store/summaries.js";
import { caseInsensitiveFs, sandbox, write } from "./helpers.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
let root: string;
let from: string;
let to: string;
let plan: Plan;

beforeEach(async () => {
  root = sandbox();
  from = write(path.join(root, "dl", "report.txt"), "original contents");
  to = path.join(root, "docs", "report.txt");
  addPlace({ name: "Docs", path: path.dirname(to) });
  plan = await propose([{ file: from, place: "Docs" }], { source: path.dirname(from) });
});

afterEach(() => {
  vi.restoreAllMocks();
});

type CrashPoint = "before-unlink" | "after-unlink" | "after-commit" | "after-link" | "after-rename" | "before-metadata";

/** Run apply (or undo) in a child process that exits abruptly at `at`. */
function interrupt(at: CrashPoint, opts: { undo?: boolean; crossDevice?: boolean; noLinks?: boolean } = {}): void {
  const source = opts.undo ? to : from;
  const target = opts.undo ? from : to;
  const script = `
    import fs from "node:fs";
    import { applyPlan, selectMoves, undoMoves } from "./src/mover.ts";
    import { loadPlan } from "./src/store/plans.ts";
    const at = ${JSON.stringify(at)};
    const source = ${JSON.stringify(source)};
    const target = ${JSON.stringify(target)};
    const { linkSync: link, renameSync: rename, unlinkSync: unlink } = fs;
    fs.linkSync = (from, to) => {
      if (${!!opts.crossDevice} && from === source) throw Object.assign(new Error("cross device"), { code: "EXDEV" });
      if (${!!opts.noLinks}) throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" });
      link(from, to);
      if (at === "after-link" && to === target) process.exit(77);
    };
    fs.renameSync = (from, to) => {
      if (at === "before-metadata" && String(to).endsWith("index.json")) process.exit(77);
      rename(from, to);
      if (at === "after-rename" && to === target) process.exit(77);
    };
    fs.unlinkSync = (file) => {
      if (file === source && at === "before-unlink") process.exit(77);
      if (at === "after-commit" && String(file).includes("/operations/") && String(file).endsWith(".json")) process.exit(77);
      unlink(file);
      if (file === source && at === "after-unlink") process.exit(77);
    };
    ${opts.undo ? `undoMoves(selectMoves({planId: ${JSON.stringify(plan.id)}}));` : `await applyPlan(loadPlan(${JSON.stringify(plan.id)}));`}
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: repo, env: process.env, encoding: "utf8", timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(77);
}

function cli(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--json", ...args], {
    cwd: repo, env: process.env, encoding: "utf8", timeout: 10_000,
  });
}

const journals = () => {
  const dir = path.join(root, "home", "operations");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".json")) : [];
};

describe("move journal recovery", () => {
  it("rolls back an interrupted destination link and permits retry", async () => {
    interrupt("before-unlink");
    expect(fs.existsSync(from)).toBe(true);
    expect(fs.existsSync(to)).toBe(true);
    recoverMoves();
    expect(fs.readFileSync(from, "utf8")).toBe("original contents");
    expect(fs.existsSync(to)).toBe(false);
    expect(loadMoves()).toEqual([]);
    expect((await applyPlan(loadPlan(plan.id))).moved).toHaveLength(1);
  });

  it.each([false, true])("recovers a completed move after source removal (crossDevice=%s)", (crossDevice) => {
    interrupt("after-unlink", { crossDevice });
    expect(fs.existsSync(from)).toBe(false);
    // Exercise the real CLI startup recovery rather than calling it explicitly.
    const result = cli("history");
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
    expect((await findSummaries("original", { limit: 10 }))[0]?.paths).toEqual([to]);
    expect(fs.readdirSync(path.join(root, "home", "operations"))).toEqual([]);
  });

  it("recovers an interrupted undo", async () => {
    expect((await applyPlan(plan)).moved).toHaveLength(1);
    interrupt("after-unlink", { undo: true });
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

  it("refuses overlapping moves while another writer holds the lock", async () => {
    await withMoveLock(() => expect(applyPlan(plan)).rejects.toThrow(/Another move/));
    expect(fs.existsSync(from)).toBe(true);
    expect((await applyPlan(plan)).moved).toHaveLength(1);
  });
});

describe("recovery after interruptions at other points", () => {
  it("removes a destination link created just before a crash", async () => {
    interrupt("after-link");
    expect(fs.existsSync(to)).toBe(true);
    recoverMoves();
    expect(fs.readFileSync(from, "utf8")).toBe("original contents");
    expect(fs.existsSync(to)).toBe(false);
    expect(journals()).toEqual([]);
    expect((await applyPlan(loadPlan(plan.id))).moved).toHaveLength(1);
  });

  it("completes a move made by rename on a filesystem without hard links", () => {
    interrupt("after-rename", { noLinks: true });
    expect(fs.existsSync(from)).toBe(false);
    const result = cli("history");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveLength(1);
    expect(journals()).toEqual([]);
    expect(undoMoves(selectMoves({ planId: plan.id })).failed).toEqual([]);
    expect(fs.readFileSync(from, "utf8")).toBe("original contents");
  });

  it("fails a move cleanly when the source is written to mid-move", async () => {
    const link = fs.linkSync;
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      link(source, destination);
      if (source === from) fs.appendFileSync(from, " (still downloading)");
    });
    const result = await applyPlan(plan);
    expect(result.failed[0]?.error).toMatch(/changed during move/);
    expect(fs.existsSync(to)).toBe(false);
    expect(journals()).toEqual([]);
    expect(() => recoverMoves()).not.toThrow();
  });
});

describe("existing files at the destination", () => {
  it("leaves a hard link to the source that is already there", async () => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.linkSync(from, to);
    expect((await applyPlan(plan)).failed[0]?.error).toMatch(/already exists/);
    expect(fs.existsSync(to)).toBe(true);
    expect(journals()).toEqual([]);
  });

  it("never deletes a look-alike copy when the filesystem can't hard-link", async () => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    for (const file of [from, to]) fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
    vi.spyOn(fs, "linkSync").mockImplementation(() => {
      throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" });
    });
    expect((await applyPlan(plan)).failed[0]?.error).toMatch(/already exists/);
    expect(fs.readFileSync(to, "utf8")).toBe("original contents");
    expect(fs.readFileSync(from, "utf8")).toBe("original contents");
    expect(journals()).toEqual([]);
  });
});

describe("file names spelled differently from the disk", () => {
  it.runIf(caseInsensitiveFs())("fails a conflicting move cleanly", async () => {
    write(path.join(root, "docs", "REPORT.txt"), "someone else's report");
    const p = await propose([{ file: "REPORT.txt", place: "Docs" }], { source: path.dirname(from) });
    const result = await applyPlan(p);
    expect(result.failed[0]?.error).toMatch(/already exists/);
    expect(journals()).toEqual([]);
    expect(() => recoverMoves()).not.toThrow();
    expect(fs.readFileSync(from, "utf8")).toBe("original contents");
    expect(fs.readFileSync(path.join(root, "docs", "REPORT.txt"), "utf8")).toBe("someone else's report");
  });

  it.runIf(caseInsensitiveFs())("fails cleanly for a plan written with another spelling", async () => {
    write(path.join(root, "docs", "REPORT.txt"), "someone else's report");
    const p = loadPlan(plan.id);
    p.items[0]!.file = path.join(root, "dl", "REPORT.txt");
    expect((await applyPlan(p)).failed[0]?.error).toMatch(/already exists/);
    expect(journals()).toEqual([]);
    expect(() => recoverMoves()).not.toThrow();
  });

  it.runIf(caseInsensitiveFs())("rolls back a journal whose source is spelled differently", () => {
    const spelled = path.join(root, "dl", "REPORT.txt");
    const st = fs.lstatSync(from);
    write(path.join(root, "home", "operations", "m0000000a.json"), JSON.stringify({
      entry: { kind: "move", id: "m0000000a", at: new Date().toISOString(), planId: plan.id, from: spelled, to },
      from: spelled,
      to,
      source: { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs },
    }));
    expect(() => recoverMoves()).not.toThrow();
    expect(journals()).toEqual([]);
    expect(fs.readFileSync(from, "utf8")).toBe("original contents");
  });
});

describe("stuck recovery", () => {
  it("never deletes the moved file when a look-alike takes the original's name", () => {
    // Same size and modification time as the original, but a different file.
    const stamp = new Date("2026-01-02T03:04:05Z");
    fs.utimesSync(from, stamp, stamp);
    interrupt("after-unlink");
    const lookalike = write(path.join(root, "dl", "other.txt"), "replacement!!!!!!");
    fs.utimesSync(lookalike, stamp, stamp);
    fs.renameSync(lookalike, from);
    expect(() => recoverMoves()).toThrow(/Cannot safely recover/);
    expect(fs.readFileSync(to, "utf8")).toBe("original contents");
    expect(fs.readFileSync(from, "utf8")).toBe("replacement!!!!!!");
  });

  function strand(): string {
    interrupt("after-unlink");
    write(from, "replacement source");
    write(to, "replacement destination");
    return journals()[0]!.replace(/\.json$/, "");
  }

  it("does not block commands that don't move files", () => {
    strand();
    const result = cli("history");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/tidybot recover/);
  });

  it("blocks moves until the journal is abandoned", () => {
    const id = strand();
    const blocked = cli("apply", plan.id, "--yes");
    expect(blocked.status).toBe(1);
    expect(JSON.parse(blocked.stdout).error).toMatchObject({ code: "recovery_required", message: expect.stringContaining(`tidybot recover --abandon ${id}`) });

    const recover = cli("recover");
    expect(recover.status).toBe(1);
    expect(JSON.parse(recover.stdout).error.code).toBe("recovery_required");

    const abandoned = cli("recover", "--abandon", id);
    expect(abandoned.status, abandoned.stderr).toBe(0);
    expect(journals()).toEqual([]);
    // Abandoning only forgets the journal; files stay as the user left them.
    expect(fs.readFileSync(from, "utf8")).toBe("replacement source");
    expect(fs.readFileSync(to, "utf8")).toBe("replacement destination");
    expect(JSON.parse(cli("recover").stdout)).toEqual({ ok: true, resolved: 0 });
  });
});

describe("move lock", () => {
  const locks = () => path.join(root, "home", "move-locks");

  it("ignores files that aren't lock claims", async () => {
    write(path.join(locks(), ".DS_Store"), "Finder metadata");
    write(path.join(locks(), "notes.txt"), "");
    expect((await applyPlan(plan)).moved).toHaveLength(1);
  });

  it.each([
    ["this process", () => process.pid],
    ["another running process", () => process.ppid],
  ])("treats a claim made before %s started as stale", async (_label, pid) => {
    const claim = write(path.join(locks(), `${pid()}-8f3c2e1a-4b5d-4c6e-9f70-1a2b3c4d5e6f.lock`));
    const long = new Date("2000-01-01T00:00:00Z");
    fs.utimesSync(claim, long, long);
    expect((await applyPlan(plan)).moved).toHaveLength(1);
    expect(fs.existsSync(claim)).toBe(false);
  });

  it("names the lock file when another move is running", async () => {
    await withMoveLock(() => expect(applyPlan(plan)).rejects.toThrow(/move-locks/));
  });

  it("lets other commands run while another process is moving", () => {
    withMoveLock(() => {
      const st = fs.lstatSync(from);
      // Another process's in-flight move.
      write(path.join(root, "home", "operations", "m0000000b.json"), JSON.stringify({
        entry: { kind: "move", id: "m0000000b", at: new Date().toISOString(), planId: plan.id, from, to },
        from,
        to,
        source: { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs },
      }));
      const result = cli("history");
      expect(result.status, result.stderr).toBe(0);
      expect(journals()).toEqual(["m0000000b.json"]);
    });
  });
});

describe("batch metadata", () => {
  it("replays a batch interrupted before its metadata was saved", async () => {
    const second = write(path.join(root, "dl", "second.txt"), "second file");
    await scan(path.dirname(from), { maxFiles: 10, excerptChars: 100 });
    plan = await propose([{ file: from, place: "Docs" }, { file: second, place: "Docs" }], { source: path.dirname(from) });
    interrupt("before-metadata");
    expect(journals()).toHaveLength(2);
    recoverMoves();
    expect(loadMoves()).toHaveLength(2);
    expect(loadPlan(plan.id).items.map((i) => i.status)).toEqual(["moved", "moved"]);
    expect((await findSummaries("second", { limit: 5 }))[0]?.paths).toEqual([path.join(root, "docs", "second.txt")]);
    expect(journals()).toEqual([]);
  });

  it("writes the index and plan once per apply, and reads history once", async () => {
    const files = [1, 2, 3, 4, 5].map((n) => write(path.join(root, "dl", `f${n}.txt`), `file ${n}`));
    const p = await propose(files.map((file) => ({ file, place: "Docs" })), { source: path.dirname(from) });
    const rename = fs.renameSync;
    const written: string[] = [];
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      written.push(String(destination));
      rename(source, destination);
    });
    const read = fs.readFileSync;
    let historyReads = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(file).endsWith("history.jsonl")) historyReads++;
      return read(file, options as BufferEncoding);
    }) as typeof fs.readFileSync);

    expect((await applyPlan(p)).moved).toHaveLength(5);
    expect(written.filter((f) => f.endsWith("index.json")).length).toBeLessThanOrEqual(1);
    expect(written.filter((f) => f.endsWith(`${p.id}.json`)).length).toBeLessThanOrEqual(1);
    expect(historyReads).toBeLessThanOrEqual(1);
  });
});
