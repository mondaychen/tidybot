import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listFiles } from "../src/scan.js";
import { survey } from "../src/survey.js";
import { onPlatform, sandbox, write } from "./helpers.js";

let root: string;
let dl: string;

beforeEach(() => {
  root = sandbox();
  dl = path.join(root, "dl");
  write(path.join(dl, "report.pdf"), "r");
  write(path.join(dl, ".env.example"), "A=1");
  write(path.join(dl, ".config", "app.json"), "{}");
  write(path.join(dl, ".config", ".token-cache"), "x");
  write(path.join(dl, "notes", ".draft.md"), "d");
  write(path.join(dl, "notes", "plan.md"), "p");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const names = (opts: Partial<Parameters<typeof listFiles>[1]>) => listFiles(dl, { maxFiles: 100, ...opts }).files.map((f) => f.rel).sort();

describe("hidden files", () => {
  it("leaves out dotfiles and dot-folders, and counts only what would have been listed", () => {
    const flat = listFiles(dl, { maxFiles: 100 });
    expect(flat.files.map((f) => f.rel)).toEqual(["report.pdf"]);
    expect(flat.skippedHidden).toBe(1); // .env.example; folders aren't listed without -r anyway
    const deep = listFiles(dl, { maxFiles: 100, recursive: true });
    expect(deep.files.map((f) => f.rel).sort()).toEqual(["notes/plan.md", "report.pdf"]);
    expect(deep.skippedHidden).toBe(3); // .config, .env.example, notes/.draft.md
  });

  it("lists everything with includeHidden", () => {
    expect(names({ recursive: true, includeHidden: true })).toEqual([
      ".config/.token-cache",
      ".config/app.json",
      ".env.example",
      "notes/.draft.md",
      "notes/plan.md",
      "report.pdf",
    ]);
  });

  it("lists specific hidden entries matched by name or by relative path", () => {
    expect(names({ recursive: true, include: [".env.*"] })).toEqual([".env.example", "notes/plan.md", "report.pdf"]);
    expect(names({ recursive: true, include: ["notes/.draft.md"] })).toEqual(["notes/.draft.md", "notes/plan.md", "report.pdf"]);
    // A matched hidden folder is walked; hidden entries inside it still need a match of their own.
    expect(names({ recursive: true, include: [".config"] })).toEqual([".config/app.json", "notes/plan.md", "report.pdf"]);
    expect(names({ recursive: true, include: [".config", ".config/.*"] })).toEqual([".config/.token-cache", ".config/app.json", "notes/plan.md", "report.pdf"]);
  });

  it("never lists tidybot's own folders or OS folder metadata", () => {
    write(path.join(dl, ".DS_Store"), "x");
    write(path.join(dl, "desktop.ini"), "x");
    write(path.join(dl, ".tidybot", "config.yaml"), "x");
    write(path.join(dl, ".tidybot-move-abc", "file"), "x");
    const r = listFiles(dl, { maxFiles: 100, recursive: true, includeHidden: true });
    expect(r.files.map((f) => f.rel)).not.toEqual(expect.arrayContaining([expect.stringMatching(/DS_Store|desktop\.ini|\.tidybot/)]));
    expect(listFiles(dl, { maxFiles: 100, include: ["*"] }).files.map((f) => f.rel)).not.toContain(".DS_Store");
  });

  it.runIf(process.platform === "darwin")("leaves out files with the macOS hidden flag", () => {
    write(path.join(dl, "Icon.png"), "i");
    execFileSync("chflags", ["hidden", path.join(dl, "Icon.png")]);
    expect(names({})).toEqual(["report.pdf"]);
    expect(names({ include: ["Icon.png"] })).toEqual(["Icon.png", "report.pdf"]);
  });

  it("leaves out names listed in a Linux .hidden file", () => {
    onPlatform("linux");
    write(path.join(dl, ".hidden"), "report.pdf\nnotes\n");
    write(path.join(dl, "shown.txt"), "s");
    expect(names({ recursive: true })).toEqual(["shown.txt"]);
  });

  it.skipIf(process.platform === "win32")("falls back to dotfiles on Windows when attributes can't be read", () => {
    onPlatform("win32"); // fswin loads as null off Windows
    expect(names({ recursive: true })).toEqual(["notes/plan.md", "report.pdf"]);
  });

  it.skipIf(process.getuid?.() === 0)("reports unreadable subdirectories instead of failing", () => {
    const locked = path.join(dl, "locked");
    write(path.join(locked, "secret.txt"), "s");
    fs.chmodSync(locked, 0);
    try {
      const r = listFiles(dl, { maxFiles: 100, recursive: true });
      expect(r.unreadable).toEqual(["locked"]);
      expect(r.files.map((f) => f.rel).sort()).toEqual(["notes/plan.md", "report.pdf"]);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it("applies to survey", () => {
    const dirs = (opts = {}) => survey(dl, { depth: 2, samples: 5, maxDirs: 10, ...opts }).dirs.map((d) => path.basename(d.path));
    expect(dirs()).toEqual(["dl", "notes"]);
    expect(dirs({ includeHidden: true })).toEqual(["dl", ".config", "notes"]);
    expect(dirs({ include: [".config"] })).toEqual(["dl", ".config", "notes"]);
    expect(survey(dl, { depth: 0, samples: 5, maxDirs: 10 }).dirs[0]?.sampleNames).toEqual(["report.pdf"]);
  });

  it("is controlled by --include-hidden and repeatable --include on the CLI", () => {
    const repo = fileURLToPath(new URL("../", import.meta.url));
    const scan = (...args: string[]) => {
      const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--json", "scan", dl, "-r", "--no-content", ...args], {
        cwd: repo, env: process.env, encoding: "utf8", timeout: 20_000,
      });
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout);
      return { rels: out.files.map((f: { rel: string }) => f.rel).sort(), skippedHidden: out.skippedHidden };
    };
    expect(scan()).toEqual({ rels: ["notes/plan.md", "report.pdf"], skippedHidden: 3 });
    expect(scan("--include", ".env.*", "--include", "notes/.draft.md").rels).toEqual([".env.example", "notes/.draft.md", "notes/plan.md", "report.pdf"]);
    expect(scan("--include-hidden")).toMatchObject({ skippedHidden: 0 });
  });
});
