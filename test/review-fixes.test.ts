import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { extractExcerpt } from "../src/extract.js";
import { applyPlan, selectMoves, undoMoves } from "../src/mover.js";
import { MAX_NAME_BYTES, nameBytes } from "../src/names.js";
import { findItem, propose, sanitizeName } from "../src/planner.js";
import { scan } from "../src/scan.js";
import { sensitiveByContent, sensitiveByName } from "../src/sensitive.js";
import { addFolder } from "../src/store/folders.js";
import { loadSummaries } from "../src/store/summaries.js";
import { listSummaries, saveSummaries } from "../src/summarize.js";
import { pdf, sandbox, write } from "./helpers.js";

let root: string;
let dl: string;
beforeEach(() => {
  root = sandbox();
  dl = path.join(root, "dl");
  addFolder({ name: "Docs", path: path.join(root, "docs") });
});

/** Is the temp filesystem case-insensitive (default APFS/NTFS)? */
function caseInsensitiveFs(): boolean {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tb-case-"));
  fs.writeFileSync(path.join(d, "a"), "");
  const result = fs.existsSync(path.join(d, "A"));
  fs.rmSync(d, { recursive: true });
  return result;
}

describe("secrets are never excerpted or cached", () => {
  it("flags by name", () => {
    for (const n of ["github-recovery-codes.txt", "Carta backup codes.txt", "1Password Emergency Kit.pdf", "client_secret_123.json", "server.pem", "prod.env", "id_ed25519"]) {
      expect(sensitiveByName(n), n).toBeTruthy();
    }
    for (const n of ["invoice.pdf", "roadmap.md", "environment-report.pdf", "economics-talk.pdf"]) {
      expect(sensitiveByName(n), n).toBeUndefined();
    }
  });

  it("flags by content", () => {
    expect(sensitiveByContent('{"installed":{"client_id":"x","client_secret":"GOCSPX-abc"}}')).toBeTruthy();
    expect(sensitiveByContent("token: ghp_" + "a".repeat(36))).toBeTruthy();
    expect(sensitiveByContent("-----BEGIN OPENSSH PRIVATE KEY-----\nabc")).toBeTruthy();
    expect(sensitiveByContent(["1. ab12-cd34", "2. ef56-gh78", "3. ij90-kl12", "4. mn34-op56", "5. qr78-st90"].join("\n"))?.rule).toBe("content.code-list");
    expect(sensitiveByContent("Meeting notes: discuss Q3 roadmap and hiring")).toBeUndefined();
    // a description of a secret is fine in a summary, the secret itself is not
    expect(sensitiveByContent("GitHub recovery codes file", { valuesOnly: true })).toBeUndefined();
  });

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

  it("rejects agent summaries containing secret values", async () => {
    const f = write(path.join(dl, "creds.json"), "{}");
    await expect(saveSummaries([{ file: f, summary: "Google OAuth file, client_secret: GOCSPX-123456" }], { base: dl })).rejects.toThrow(/secret/);
    await saveSummaries([{ file: f, summary: "Google OAuth client credentials for the CLI project" }], { base: dl });
    expect(listSummaries()).toHaveLength(1);
  });
});

describe("bounded reads", () => {
  it("doesn't open known binary types", async () => {
    const r = await extractExcerpt(write(path.join(dl, "big.dmg"), "plain text pretending"), 100);
    expect(r).toMatchObject({ excerpt: "", skipped: "binary type" });
  });

  it("reads only the head of large text files", async () => {
    const f = write(path.join(dl, "huge.log"), "line of log text\n".repeat(200_000)); // ~3.4 MB
    const r = await extractExcerpt(f, 100);
    expect(r.excerpt.length).toBe(100);
    expect(r.complete).toBe(false);
  });

  it("limits PDF parsing to the first pages", async () => {
    const r = await extractExcerpt(write(path.join(dl, "a.pdf"), pdf("Short notice")), 500);
    expect(r).toMatchObject({ method: "pdf", complete: true });
  });
});

describe("filename limits", () => {
  it("counts bytes, not characters, and keeps the extension", () => {
    const chinese = "年度财务报告".repeat(30); // 180 chars, 540 bytes
    const name = sanitizeName(chinese, "/x/a.pdf") as string;
    expect(nameBytes(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(name.endsWith(".pdf")).toBe(true);
    expect(name.startsWith("年度财务报告")).toBe(true);
  });

  it("does not split emoji or accented characters", () => {
    const name = sanitizeName("👨‍👩‍👧".repeat(40) + "é".normalize("NFD").repeat(40), "/x/a.txt") as string;
    expect(nameBytes(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(name.normalize("NFC")).toBe(name);
    expect([...new Intl.Segmenter().segment(name.replace(/\.txt$/, ""))].every((g) => g.segment === "👨‍👩‍👧" || g.segment === "é")).toBe(true);
  });

  it("a long Chinese rename succeeds at apply time", () => {
    write(path.join(dl, "3f2a.pdf"), "x");
    const plan = propose([{ file: "3f2a.pdf", folder: "Docs", rename: "年度财务报告".repeat(30) }], { source: dl });
    const r = applyPlan(plan);
    expect(r.failed).toEqual([]);
  });
});

describe("case-insensitive filesystems", () => {
  it.runIf(caseInsensitiveFs())("renames a file to a case-only variant and undoes it", () => {
    write(path.join(dl, "report.pdf"), "x");
    const plan = propose([{ file: "report.pdf", folder: null, rename: "Report" }], { source: dl });
    expect(plan.items[0]?.warnings).toBeUndefined();
    expect(applyPlan(plan).failed).toEqual([]);
    expect(fs.readdirSync(dl)).toEqual(["Report.pdf"]);
    undoMoves(selectMoves({ last: true }));
    expect(fs.readdirSync(dl)).toEqual(["report.pdf"]);
  });

  it("warns when two targets differ only by case", () => {
    write(path.join(dl, "a/X.pdf"), "1");
    write(path.join(dl, "b/x.pdf"), "2");
    const plan = propose(
      [
        { file: "a/X.pdf", folder: "Docs" },
        { file: "b/x.pdf", folder: "Docs" },
      ],
      { source: dl },
    );
    expect(plan.items[1]?.warnings?.[0]).toMatch(/same target/);
  });

  it.runIf(caseInsensitiveFs())("warns when an existing file differs only by case", () => {
    write(path.join(root, "docs/NOTES.txt"), "existing");
    write(path.join(dl, "notes.txt"), "new");
    const plan = propose([{ file: "notes.txt", folder: "Docs" }], { source: dl });
    expect(plan.items[0]?.warnings?.[0]).toMatch(/already exists/);
  });
});

describe("plan details", () => {
  it("refuses ambiguous short file references", () => {
    write(path.join(dl, "a/x.txt"), "1");
    write(path.join(dl, "b/x.txt"), "2");
    const plan = propose(
      [
        { file: "a/x.txt", folder: "Docs", rename: "one" },
        { file: "b/x.txt", folder: "Docs", rename: "two" },
      ],
      { source: dl },
    );
    expect(() => findItem(plan, "x.txt")).toThrow(/matches 2 files/);
    expect(findItem(plan, "b/x.txt").newName).toBe("two.txt");
  });

  it("records the rules and folders in effect", () => {
    write(path.join(dl, "a.txt"), "1");
    const plan = propose([{ file: "a.txt", folder: "Docs" }], { source: dl });
    expect(plan.context).toMatchObject({ rename: "auto", rules: [], folders: [{ name: "Docs" }] });
  });
});
