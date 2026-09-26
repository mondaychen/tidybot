import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { allowFiles } from "../src/allow.js";
import { scan } from "../src/scan.js";
import { RULES } from "../src/sensitive.js";
import { removeAllowance } from "../src/store/allowlist.js";
import { loadConfig, setConfigValue, setRuleAllowed } from "../src/store/config.js";
import { FileIndex } from "../src/store/summaries.js";
import { saveSummaries } from "../src/summarize.js";
import { sandbox, write } from "./helpers.js";

let dl: string;
beforeEach(() => {
  dl = path.join(sandbox(), "dl");
});

const scanOne = async (name: string) => {
  const { files } = await scan(dl, { maxFiles: 50, excerptChars: 500, allowRules: loadConfig().allowRules });
  return files.find((f) => f.name === name);
};
const allow = (files: string[], reason: string, content = false) => allowFiles(files, { base: dl, reason, content, allowRules: loadConfig().allowRules });

describe("rule ids", () => {
  it("are unique", () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
  });
});

describe("per-file allow", () => {
  it("unlocks a harmless file flagged by name, until its content changes", async () => {
    const f = write(path.join(dl, "design-tokens.json"), '{"color":"#fff"}');
    expect(await scanOne("design-tokens.json")).toMatchObject({ sensitiveRule: "name.tokens" });

    const r = await allow(["design-tokens.json"], "design system color tokens");
    expect(r.allowed[0]).toMatchObject({ rule: "name.tokens", content: false });
    const after = await scanOne("design-tokens.json");
    expect(after?.sensitive).toBeUndefined();
    expect(after?.excerpt).toContain("#fff");

    fs.writeFileSync(f, '{"color":"#000"}');
    expect(await scanOne("design-tokens.json")).toMatchObject({ sensitiveRule: "name.tokens" });
  });

  it("still checks content when only filename rules are waived", async () => {
    write(path.join(dl, "tokens.txt"), "harmless");
    await allow(["tokens.txt"], "notes about tokens");
    // same allowance, but now the file gets a real key (new hash → allowance no longer applies anyway)
    write(path.join(dl, "api-tokens.txt"), "prod key AKIAABCDEFGHIJKLMNOP");
    await expect(allow(["api-tokens.txt"], "looks fine")).rejects.toThrow(/content\.aws-key.*--content/s);
  });

  it("refuses content matches without --content, allows them with it", async () => {
    write(path.join(dl, "config-docs.md"), "Example: password: changeme123 in the sample config");
    expect(await scanOne("config-docs.md")).toMatchObject({ sensitiveRule: "content.assignment" });
    await expect(allow(["config-docs.md"], "docs example")).rejects.toThrow(/--content/);
    await allow(["config-docs.md"], "sample value in docs; user confirmed", true);
    expect((await scanOne("config-docs.md"))?.excerpt).toContain("changeme123");
    // summary vetting respects the content allowance
    await saveSummaries([{ file: path.join(dl, "config-docs.md"), summary: "Docs showing password: changeme123 as a sample" }], { base: dl });
  });

  it("is all-or-nothing and reports files that weren't flagged", async () => {
    write(path.join(dl, "plain.txt"), "hello");
    write(path.join(dl, "secret-santa.xlsx"), "not a real xlsx");
    write(path.join(dl, "env-report.txt"), "token ghp_" + "a".repeat(36));
    await expect(allow(["secret-santa.xlsx", "env-report.txt"], "x")).rejects.toThrow();
    expect((await scanOne("secret-santa.xlsx"))?.sensitive).toBeTruthy(); // nothing saved
    const r = await allow(["plain.txt", "secret-santa.xlsx"], "gift exchange sheet");
    expect(r.notFlagged).toEqual(["plain.txt"]);
    expect(r.allowed.map((a) => a.name)).toEqual(["secret-santa.xlsx"]);
  });

  it("can be revoked", async () => {
    const f = write(path.join(dl, "tokens.txt"), "harmless");
    await allow(["tokens.txt"], "x");
    const hash = new FileIndex().cachedHash(f) as string;
    expect(removeAllowance(hash)?.name).toBe("tokens.txt");
    expect((await scanOne("tokens.txt"))?.sensitive).toBeTruthy();
  });
});

describe("rule-wide allow", () => {
  it("turns a rule off and back on", async () => {
    write(path.join(dl, "design-tokens.json"), "{}");
    setRuleAllowed("name.tokens", true);
    expect((await scanOne("design-tokens.json"))?.sensitive).toBeUndefined();
    setRuleAllowed("name.tokens", false);
    expect((await scanOne("design-tokens.json"))?.sensitiveRule).toBe("name.tokens");
    expect(() => setRuleAllowed("name.nope", true)).toThrow(/Unknown rule/);
  });

  it("other rules keep working when one is off", async () => {
    setRuleAllowed("name.tokens", true);
    write(path.join(dl, "api-tokens.txt"), "key AKIAABCDEFGHIJKLMNOP");
    expect((await scanOne("api-tokens.txt"))?.sensitiveRule).toBe("content.aws-key");
  });

  it("is not settable via config set", () => {
    expect(() => setConfigValue("allowRules", "name.tokens")).toThrow(/Unknown config key/);
  });
});
