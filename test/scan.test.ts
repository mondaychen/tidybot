import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scan } from "../src/scan.js";
import { loadSummaries } from "../src/store/summaries.js";
import { sandbox, write } from "./helpers.js";

let root: string;
let dl: string;

beforeEach(() => {
  root = sandbox();
  dl = path.join(root, "dl");
  fs.mkdirSync(dl);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("large-file duplicates", () => {
  function largeFile(name: string, middle: string): string {
    const file = path.join(dl, name);
    const fd = fs.openSync(file, "w");
    try {
      // Sparse fixtures exercise the >64 MiB branch without allocating huge buffers.
      fs.ftruncateSync(fd, 65 * 1024 * 1024);
      fs.writeSync(fd, middle, 32 * 1024 * 1024, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    return file;
  }

  it("does not call files identical when their sampled ends match but their middles differ", async () => {
    largeFile("a.bin", "a");
    largeFile("b.bin", "b");
    const result = await scan(dl, { maxFiles: 10, excerptChars: 100 });
    expect(result.files).toHaveLength(2);
    expect(result.duplicates).toEqual([]);
  });

  it("still identifies genuinely identical large files", async () => {
    largeFile("a.bin", "same");
    largeFile("b.bin", "same");
    const result = await scan(dl, { maxFiles: 10, excerptChars: 100 });
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]?.files.slice().sort()).toEqual(["a.bin", "b.bin"]);
  });

  it("verifies indexed copies outside the scan root as well as local candidates", async () => {
    const filed = largeFile("filed.bin", "same");
    await scan(dl, { maxFiles: 10, excerptChars: 100 });
    const other = path.join(root, "other");
    fs.mkdirSync(other);
    fs.copyFileSync(filed, path.join(other, "same.bin"));
    const different = largeFile("different.bin", "diff");
    fs.renameSync(different, path.join(other, "different.bin"));
    const result = await scan(other, { maxFiles: 10, excerptChars: 100 });
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]?.files).toEqual(["same.bin"]);
    expect(result.duplicates[0]?.elsewhere).toEqual([filed]);
    expect(result.duplicates[0]?.hash).toMatch(/^sha256:/);
  });

  it("reads unchanged candidates in full only once across scans", async () => {
    const a = largeFile("a.bin", "same");
    const b = largeFile("b.bin", "same");
    expect((await scan(dl, { maxFiles: 10, excerptChars: 100 })).duplicates).toHaveLength(1);
    const streams = vi.spyOn(fs, "createReadStream");
    expect((await scan(dl, { maxFiles: 10, excerptChars: 100 })).duplicates).toHaveLength(1);
    expect(streams.mock.calls.filter(([file]) => file === a || file === b)).toEqual([]);

    // An edit invalidates the cached verification.
    fs.appendFileSync(b, "changed");
    expect((await scan(dl, { maxFiles: 10, excerptChars: 100 })).duplicates).toEqual([]);
  });
});

describe("sensitive file scanning", () => {
  it("scan withholds excerpts and never auto-caches secrets", async () => {
    write(path.join(dl, "github-recovery-codes.txt"), "ab12-cd34\nef56-gh78\n");
    write(path.join(dl, "notes.txt"), "AWS key AKIAABCDEFGHIJKLMNOP for staging");
    write(path.join(dl, "ok.txt"), "shopping list");
    const { files } = await scan(dl, { maxFiles: 10, excerptChars: 500 });
    const by = Object.fromEntries(files.map((f) => [f.name, f]));
    expect(by["github-recovery-codes.txt"]).toMatchObject({ sensitive: "recovery codes" });
    expect(by["notes.txt"]).toMatchObject({ sensitive: "AWS access key" });
    for (const n of ["github-recovery-codes.txt", "notes.txt"]) {
      expect(by[n]?.excerpt).toBeUndefined();
      expect(by[n]?.needsSummary).toBeUndefined();
    }
    const cached = JSON.stringify([...loadSummaries().values()]);
    expect(cached).toContain("shopping list");
    expect(cached).not.toContain("AKIA");
    expect(cached).not.toContain("ab12");
  });
});
