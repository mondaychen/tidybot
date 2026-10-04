import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowFiles } from "../src/allow.js";
import { scan } from "../src/scan.js";
import { removeAllowance } from "../src/store/allowlist.js";
import { findSummaries } from "../src/store/summaries.js";
import { getSummaries, listSummaries, saveSummaries } from "../src/summarize.js";
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

describe("sensitive content after revocation", () => {
  const readers = {
    find: (_file: string) => findSummaries("changeme123", { limit: 10 }),
    get: (file: string) => getSummaries([file], dl),
    list: (_file: string) => listSummaries(),
  };

  it.each(Object.entries(readers))("withholds previously cached values from %s", async (_name, read) => {
    const file = write(path.join(dl, "example.txt"), "Example password: changeme123");
    const allowance = await allowFiles([file], { base: dl, reason: "synthetic example", content: true, allowRules: [] });
    const hash = allowance.allowed[0]?.hash;
    expect(hash).toBeTruthy();
    await scan(dl, { maxFiles: 10, excerptChars: 100 });
    expect(JSON.stringify(await read(file))).toContain("changeme123");

    expect(removeAllowance(hash!)).toBeDefined();
    expect(JSON.stringify(await read(file))).not.toContain("changeme123");
    const rescanned = await scan(dl, { maxFiles: 10, excerptChars: 100 });
    expect(rescanned.files[0]?.sensitiveRule).toBe("content.assignment");
    expect(rescanned.files[0]?.excerpt).toBeUndefined();
    expect(JSON.stringify(await read(file))).not.toContain("changeme123");
  });

  it("also filters revoked content when missing files are included", async () => {
    const file = write(path.join(dl, "example.txt"), "Example password: changeme123");
    const { allowed } = await allowFiles([file], { base: dl, reason: "synthetic example", content: true, allowRules: [] });
    await scan(dl, { maxFiles: 10, excerptChars: 100 });
    removeAllowance(allowed[0]!.hash);
    fs.unlinkSync(file);
    expect(await listSummaries({ includeMissing: true })).toEqual([]);
    expect(await findSummaries("changeme123", { limit: 10, includeMissing: true })).toEqual([]);
  });
});

describe("summary validation", () => {
  it("rejects agent summaries containing secret values", async () => {
    const f = write(path.join(dl, "creds.json"), "{}");
    await expect(saveSummaries([{ file: f, summary: "Google OAuth file, client_secret: GOCSPX-123456" }], { base: dl })).rejects.toThrow(/secret/);
    await saveSummaries([{ file: f, summary: "Google OAuth client credentials for the CLI project" }], { base: dl });
    expect(await listSummaries()).toHaveLength(1);
  });

  it("saves nothing from a batch that is rejected", async () => {
    const a = write(path.join(dl, "a.txt"), "alpha");
    const b = write(path.join(dl, "b.txt"), "beta");
    await expect(saveSummaries([
      { file: a, summary: "Notes about the alpha project" },
      { file: b, summary: "password: hunter2345" },
    ], { base: dl })).rejects.toThrow(/secret/);
    expect(await listSummaries({ includeMissing: true })).toEqual([]);
    await expect(saveSummaries([
      { file: a, summary: "Notes about the alpha project" },
      { file: "missing.txt", summary: "Gone" },
    ], { base: dl })).rejects.toThrow(/not found/i);
    expect(await listSummaries({ includeMissing: true })).toEqual([]);
  });
});
