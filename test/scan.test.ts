import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scan } from "../src/scan.js";
import { sandbox } from "./helpers.js";

let root: string;
let dl: string;

beforeEach(() => {
  // Track environment overrides so sandbox() changes are restored after each test.
  vi.stubEnv("TIDYBOT_HOME", undefined);
  vi.stubEnv("TIDYBOT_NO_PROJECT", undefined);
  vi.stubEnv("TIDYBOT_PROJECT", undefined);
  root = sandbox();
  dl = path.join(root, "dl");
  fs.mkdirSync(dl);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
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
});
