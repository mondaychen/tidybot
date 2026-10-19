import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { scan } from "../src/scan.js";
import { checkCustomRule, sensitiveByContent } from "../src/sensitive.js";
import { addSecretRule, loadConfig, removeSecretRule } from "../src/store/config.js";
import { findSummaries } from "../src/store/summaries.js";
import { saveSummaries } from "../src/summarize.js";
import { sandbox, write } from "./helpers.js";

const TOKEN = "acme_tok_9fK2mQ7xL4pR8vN3";

describe("custom secret rules", () => {
  it("checks a rule before it can be used", () => {
    expect(checkCustomRule({ name: "acme", prefix: "acme_tok_" })).toBeUndefined();
    expect(checkCustomRule({ name: "acme", regex: String.raw`\bACME-[0-9]{6}\b` })).toBeUndefined();
    const problems: [Parameters<typeof checkCustomRule>[0], RegExp][] = [
      [{ name: "Acme Token", prefix: "acme_" }, /rule name/],
      [{ name: "acme" }, /prefix or a regular expression/],
      [{ name: "acme", prefix: "acme_", regex: "acme" }, /prefix or a regular expression/],
      [{ name: "acme", prefix: "ac" }, /3 to 64/],
      [{ name: "acme", prefix: "acme tok" }, /no spaces/],
      [{ name: "acme", regex: "acme_(" }, /doesn't work/],
      [{ name: "acme", regex: "x*" }, /matches empty text/],
      [{ name: "acme", regex: "a".repeat(301) }, /at most 300/],
    ];
    for (const [rule, problem] of problems) expect(checkCustomRule(rule), JSON.stringify(rule)).toMatch(problem);
  });

  it("finds values by prefix or regex, as secret values", async () => {
    const custom = [
      { name: "acme", prefix: "acme_tok_" },
      { name: "badge", regex: String.raw`\bBADGE-\d{6}\b`, reason: "door badge code" },
    ];
    expect(await sensitiveByContent(`deploy with ${TOKEN}`, { custom, valuesOnly: true })).toEqual({
      rule: "custom.acme",
      reason: "secret value (custom: acme)",
    });
    expect(await sensitiveByContent("my BADGE-123456 for the office", { custom })).toEqual({ rule: "custom.badge", reason: "door badge code" });
    // The prefix alone, a short value, or the prefix inside a longer word is not a value.
    for (const text of ["tokens start with acme_tok_", "acme_tok_abc", `xacme_tok_9fK2mQ7xL4pR8vN3`]) {
      expect(await sensitiveByContent(text, { custom }), text).toBeUndefined();
    }
    // A regex prefix is taken as text, not as a pattern.
    expect(await sensitiveByContent("a.b+c9fK2mQ7xL4", { custom: [{ name: "dots", prefix: "a.b+c" }] })).toBeTruthy();
    expect(await sensitiveByContent("aXbbc9fK2mQ7xL4", { custom: [{ name: "dots", prefix: "a.b+c" }] })).toBeUndefined();
  });
});

describe("custom secret rules in config", () => {
  let root: string;
  let dl: string;

  beforeEach(() => {
    root = sandbox();
    dl = path.join(root, "dl");
    fs.mkdirSync(dl);
  });

  it("flags files, refuses summaries, and hides cached ones that match", async () => {
    write(path.join(dl, "deploy.txt"), `Deploy notes: run it with ${TOKEN} on Fridays`);
    const before = await scan(dl, { maxFiles: 10, excerptChars: 1000 });
    expect(before.files[0]?.excerpt).toContain(TOKEN);
    expect(await findSummaries("deploy", { limit: 10 })).toHaveLength(1);

    addSecretRule({ name: "acme", prefix: "acme_tok_" }, "global");
    expect(await findSummaries("deploy", { limit: 10 })).toEqual([]);
    const after = await scan(dl, { maxFiles: 10, excerptChars: 1000 });
    expect(after.files[0]).toMatchObject({ sensitiveRule: "custom.acme" });
    expect(after.files[0]?.excerpt).toBeUndefined();

    const other = write(path.join(dl, "other.pdf"), "%PDF-");
    await expect(saveSummaries([{ file: other, summary: `Uses ${TOKEN}` }], { base: dl })).rejects.toThrow(/custom\.acme/);

    removeSecretRule("acme", "global");
    expect((await scan(dl, { maxFiles: 10, excerptChars: 1000 })).files[0]?.sensitive).toBeUndefined();
  });

  it("replaces a rule with the same name, and refuses a bad one written by hand", () => {
    addSecretRule({ name: "acme", prefix: "acme_tok_" }, "global");
    addSecretRule({ name: "acme", prefix: "acme_key_", reason: "Acme key" }, "global");
    expect(loadConfig().secretRules).toEqual([{ name: "acme", prefix: "acme_key_", reason: "Acme key" }]);
    expect(() => addSecretRule({ name: "bad", regex: "(" }, "global")).toThrow(/doesn't work/);

    const file = path.join(process.env.TIDYBOT_HOME as string, "config.yaml");
    fs.writeFileSync(file, "secretRules:\n  - name: wide\n    regex: '.*'\n");
    expect(() => loadConfig()).toThrow(/matches empty text/);
  });

  it("adds, lists and removes rules from the command line", () => {
    const repo = fileURLToPath(new URL("../", import.meta.url));
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--json", ...args], { cwd: repo, env: process.env, encoding: "utf8", timeout: 10_000 });
      return { status: r.status, out: JSON.parse(r.stdout) };
    };
    expect(run("sensitive", "add-rule", "acme", "--prefix", "acme_tok_").status).toBe(0);
    expect(run("sensitive", "rules").out).toContainEqual(expect.objectContaining({ id: "custom.acme", prefix: "acme_tok_" }));
    expect(run("sensitive", "add-rule", "Bad Name", "--prefix", "x_y_").status).toBe(1);
    expect(run("sensitive", "rm-rule", "custom.acme").out).toMatchObject({ ok: true, removed: { name: "acme" } });
    expect(run("sensitive", "rm-rule", "acme").status).toBe(1);
  });
});
