import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractExcerpt, mimeOf } from "../src/extract.js";
import { applyPlan } from "../src/mover.js";
import { propose, retarget, retargetAll, sanitizeName } from "../src/planner.js";
import { preview } from "../src/preview.js";
import { findSimilar, listFiles, scan } from "../src/scan.js";
import { sensitiveByContent, sensitiveByName } from "../src/sensitive.js";
import { setConfigValue } from "../src/store/config.js";
import { addPlace } from "../src/store/places.js";
import { loadPlan } from "../src/store/plans.js";
import { survey } from "../src/survey.js";
import { pdf, sandbox, write } from "./helpers.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
function cli(...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: repo, env: process.env, encoding: "utf8", timeout: 20_000 });
  return { ...r, json: () => JSON.parse(r.stdout) };
}

let root: string;
let dl: string;
let docs: string;
beforeEach(() => {
  root = sandbox();
  dl = path.join(root, "dl");
  docs = path.join(root, "docs");
  fs.mkdirSync(dl, { recursive: true });
  addPlace({ name: "Docs", path: docs });
  addPlace({ name: "Photos", path: path.join(root, "photos") });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PDFs with standard fonts that aren't embedded", () => {
  it("load the font and print no pdf.js warnings", async () => {
    const dingbats = Buffer.from(pdf("hello world").toString("latin1").replace("/Helvetica", "/ZapfDingbats"), "latin1");
    const file = write(path.join(dl, "ding.pdf"), dingbats);
    const logged = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const r = await extractExcerpt(file, 100);
    expect(r.method).toBe("pdf");
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  });
});

describe("sensitive detection", () => {
  it("flags wallet recovery and seed phrases by name", () => {
    for (const n of ["ArcRecoveryPhrase.png", "recovery-phrase.txt", "Seed Phrase.jpg", "metamask_mnemonic.txt", "secret_phrase.pdf"]) {
      expect(sensitiveByName(n), n).toBeTruthy();
    }
    expect(sensitiveByName("phrasebook.pdf")).toBeUndefined();
  });

  it("says how much of a file looks like codes, without quoting any", async () => {
    const codes = ["ab12-cd34", "ef56-gh78", "ij90-kl12", "mn34-op56", "qr78-st90"];
    const text = [...codes, ...Array.from({ length: 20 }, (_, i) => `Slide ${i}: market overview and growth plans`)].join("\n");
    const hit = await sensitiveByContent(text);
    expect(hit).toEqual({ rule: "content.code-list", reason: "list of one-time codes: 5 of 25 lines look like 8-character codes" });
    for (const c of codes) expect(hit?.reason).not.toContain(c);
  });
});

describe("summary todo", () => {
  it("lists identical files once, with the other paths as copies", () => {
    const png = Buffer.from("89504e470d0a1a0a0000", "hex");
    write(path.join(dl, "a.png"), png);
    write(path.join(dl, "a (1).png"), png);
    write(path.join(dl, "b.png"), Buffer.concat([png, Buffer.from("x")]));
    const r = cli("--json", "summary", "todo", dl).json();
    expect(r.count).toBe(2);
    expect(r.files.map((f: { rel: string; copies?: string[] }) => [f.rel, f.copies])).toEqual([
      ["a (1).png", ["a.png"]],
      ["b.png", undefined],
    ]);
  });
});

describe("status", () => {
  it("counts the moves undo can reverse, and names the latest plan", async () => {
    const plan = await propose([{ file: write(path.join(dl, "a.txt"), "a"), place: "Docs" }], { source: dl });
    await applyPlan(plan);
    const r = cli("--json", "status").json();
    expect(r).toMatchObject({ undoableMoves: 1, lastUndoablePlan: plan.id });
    expect(r.activeMoves).toBeUndefined();
    expect(cli("status").stdout).toMatch(/can undo: +1 move\(s\) {2}\(latest plan: tidybot undo --plan p/);
  });
});

describe("scan without -r", () => {
  it("lists the subfolders it left out, and archives extracted next to their folder", async () => {
    write(path.join(dl, "report.pdf"), "x");
    write(path.join(dl, "export.zip"), "zip");
    write(path.join(dl, "export/data.json"), "{}");
    write(path.join(dl, "site.tar.gz"), "tgz");
    write(path.join(dl, "site/index.html"), "<p>");
    write(path.join(dl, "notes/a.txt"), "a");
    write(path.join(dl, ".cache/x"), "x");
    const r = listFiles(dl, { maxFiles: 10 });
    expect(r.skippedDirs).toEqual(["export", "notes", "site"]);
    expect(r.extractedArchives).toEqual([
      { archive: "export.zip", dir: "export" },
      { archive: "site.tar.gz", dir: "site" },
    ]);
    // With -r the folders are scanned, and the archive hint stays.
    const deep = listFiles(dl, { maxFiles: 10, recursive: true });
    expect(deep.skippedDirs).toEqual([]);
    expect(deep.extractedArchives).toHaveLength(2);
  });

  it("reports a place inside the scanned directory as a skipped place", () => {
    addPlace({ name: "Inbox", path: path.join(dl, "inbox") });
    write(path.join(dl, "inbox/a.txt"), "a");
    const r = listFiles(dl, { maxFiles: 10, skipPlaces: [{ name: "Inbox", path: path.join(dl, "inbox"), rule: "" }] });
    expect(r).toMatchObject({ skippedDirs: [], skippedPlaces: ["Inbox"] });
  });
});

describe("similar files", () => {
  const text = "Kaijie Huang. Software engineer with ten years of experience building distributed systems and developer tools.";

  it("groups copies by text, by name and by size, but not identical files", async () => {
    write(path.join(dl, "Resume.txt"), `${text}\n`);
    write(path.join(dl, "Resume (1).txt"), `${text}\r\n`); // same text, other bytes
    write(path.join(dl, "output.csv"), "a,b\n1,2\n");
    write(path.join(dl, "output-2.csv"), "a,b\n3,4\n");
    write(path.join(dl, "chapter-1.csv"), "x\n"); // numbered, but no plain "chapter"
    write(path.join(dl, "chapter-2.csv"), "y\n");
    write(path.join(dl, "Sep 21, Doc 1.bin"), Buffer.alloc(70_000, 1));
    write(path.join(dl, "Sep 21, Doc 2.bin"), Buffer.alloc(70_000, 2));
    write(path.join(dl, "same.dat"), "identical");
    write(path.join(dl, "same copy.dat"), "identical");
    const r = await scan(dl, { maxFiles: 50, excerptChars: 1000 });
    expect(r.similar).toEqual([
      { why: "same text", files: ["Resume (1).txt", "Resume.txt"] },
      { why: "same name", files: ["output-2.csv", "output.csv"] },
      { why: "same size", files: ["Sep 21, Doc 1.bin", "Sep 21, Doc 2.bin"] },
    ]);
    expect(r.duplicates.map((d) => d.files)).toEqual([["same copy.dat", "same.dat"]]);
  });

  it("doesn't group same-named files from different folders without a copy marker", async () => {
    write(path.join(dl, "a/README.md"), "one");
    write(path.join(dl, "b/README.md"), "two");
    write(path.join(dl, "b/README copy.md"), "three");
    const { files } = await scan(dl, { maxFiles: 50, excerptChars: 1000, recursive: true });
    expect(findSimilar(files)).toEqual([{ why: "same name", files: ["a/README.md", "b/README copy.md", "b/README.md"] }]);
    expect(findSimilar(files.filter((f) => f.name === "README.md"))).toEqual([]);
  });

  it("are flagged in the compact scan", () => {
    write(path.join(dl, "x.txt"), "1");
    write(path.join(dl, "x (1).txt"), "2");
    const r = cli("--json", "scan", dl).json();
    expect(r.files.every((f: { similar?: boolean }) => f.similar)).toBe(true);
    expect(cli("scan", dl).stdout).toMatch(/similar \(same name, not identical\): x \(1\)\.txt {2}~ {2}x\.txt/);
  });
});

describe("conflict warnings", () => {
  it("say whether the files are identical", async () => {
    write(path.join(docs, "same.txt"), "content");
    write(path.join(docs, "other.txt"), "old");
    write(path.join(dl, "same.txt"), "content");
    write(path.join(dl, "other.txt"), "new");
    write(path.join(dl, "a/twin.txt"), "t");
    write(path.join(dl, "b/twin.txt"), "t");
    const plan = await propose(
      ["same.txt", "other.txt", "a/twin.txt", "b/twin.txt"].map((file) => ({ file, place: "Docs" })),
      { source: dl },
    );
    expect(plan.items.map((i) => i.warnings?.[0])).toEqual([
      "conflict: same.txt already exists in the destination (identical files: delete one instead of renaming)",
      "conflict: other.txt already exists in the destination (different files: rename one)",
      undefined,
      expect.stringMatching(/^conflict: same target as twin\.txt \(identical files/),
    ]);
  });
});

describe("plan set with several files", () => {
  async function plan3() {
    for (const n of ["a.txt", "b.txt", "c.txt"]) write(path.join(dl, n), n);
    return propose(["a.txt", "b.txt", "c.txt"].map((file) => ({ file, place: null, rename: `${file}-new` })), { source: dl });
  }

  it("moves every file to the place", async () => {
    const plan = await plan3();
    const items = retargetAll(plan, ["a.txt", "b.txt"], { place: "Photos" });
    expect(items.map((i) => i.place)).toEqual(["Photos", "Photos"]);
    expect(loadPlan(plan.id).items.map((i) => i.place)).toEqual(["Photos", "Photos", null]);
  });

  it("changes nothing when one file fails", async () => {
    const plan = await plan3();
    expect(() => retargetAll(plan, ["a.txt", "missing.txt"], { place: "Photos" })).toThrow(/not in plan/);
    expect(loadPlan(plan.id).items.map((i) => i.place)).toEqual([null, null, null]);
    expect(plan.items.map((i) => i.place)).toEqual([null, null, null]);
    expect(() => retargetAll(plan, ["a.txt", "b.txt"], { name: "x" })).toThrow(/one file only/);
  });

  it("takes --place, or a place name after the files", async () => {
    const plan = await plan3();
    expect(cli("--json", "plan", "set", "a.txt", "b.txt", "--place", "Photos").json().items).toHaveLength(2);
    expect(cli("--json", "plan", "set", "c.txt", "Docs").json().items.map((i: { place: string }) => i.place)).toEqual(["Docs"]);
    expect(loadPlan(plan.id).items.map((i) => i.place)).toEqual(["Photos", "Photos", "Docs"]);
  });

  it("reads proposals from stdin with --data -", async () => {
    write(path.join(dl, "d.txt"), "d");
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--json", "propose", "--source", dl, "--data", "-"], {
      cwd: repo,
      env: process.env,
      encoding: "utf8",
      input: JSON.stringify([{ file: "d.txt", place: "Docs" }]),
      timeout: 20_000,
    });
    expect(JSON.parse(r.stdout).plan.items[0]).toMatchObject({ place: "Docs", status: "pending" });
  });
});

describe("extension case", () => {
  it("keeps the extension by default, and lowercases it with extensionCase lower", async () => {
    expect(sanitizeName("shirt", "/x/IMG_1.HEIC")).toBe("shirt.HEIC");
    expect(sanitizeName("shirt", "/x/IMG_1.HEIC", { extensionCase: "lower" })).toBe("shirt.heic");
    expect(sanitizeName("shirt.HEIC", "/x/IMG_1.HEIC", { extensionCase: "lower" })).toBe("shirt.heic");
    setConfigValue("extensionCase", "lower");
    write(path.join(dl, "IMG_2.JPG"), "x");
    const plan = await propose([{ file: "IMG_2.JPG", place: "Photos", rename: "beach", summarySkipped: "test" }], { source: dl });
    expect(plan.items[0]?.newName).toBe("beach.jpg");
    expect(plan.context?.extensionCase).toBe("lower");
    expect(retarget(plan, "IMG_2.JPG", { name: "sea" }).newName).toBe("sea.jpg");
    expect(() => setConfigValue("extensionCase", "upper")).toThrow();
  });
});

describe("survey", () => {
  it("says which limit cut it short", () => {
    write(path.join(root, "tree/a/b/c/file.txt"), "x");
    write(path.join(root, "tree/d/file.txt"), "x");
    expect(survey(path.join(root, "tree"), { depth: 1, samples: 1, maxDirs: 100 })).toMatchObject({ truncated: true, truncatedBy: ["depth"] });
    expect(survey(path.join(root, "tree"), { depth: 5, samples: 1, maxDirs: 2 })).toMatchObject({ truncated: true, truncatedBy: ["maxDirs"] });
    expect(cli("survey", path.join(root, "tree"), "--depth", "1").stdout).toMatch(/truncated: deeper folders not shown, raise --depth \(now 1\)/);
  });

  it("drops query strings from extensions", () => {
    write(path.join(root, "saved/style.css?v=1736221786"), "a{}");
    write(path.join(root, "saved/app.js?ver=2#top"), "x");
    const [row] = survey(path.join(root, "saved"), { depth: 0, samples: 5, maxDirs: 10 }).dirs;
    expect(row?.topExtensions.map((e) => e.ext).sort()).toEqual([".css", ".js"]);
    expect(mimeOf(path.join(root, "saved/style.css?v=1736221786"))).toBe("text/css");
  });
});

/** sips on macOS; ImageMagick elsewhere, if installed. */
function canPreview(): boolean {
  if (process.platform === "darwin") return fs.existsSync("/usr/bin/sips");
  try {
    return execFileSync("magick", ["-version"], { encoding: "utf8" }).includes("ImageMagick");
  } catch {
    return false;
  }
}

describe.runIf(canPreview())("preview", () => {
  /** A 2000×10 red PNG, made without image tools. */
  async function png(file: string) {
    const { deflateSync, crc32 } = await import("node:zlib");
    const [w, h] = [2000, 10];
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from([255, 0, 0]))]);
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
      return Buffer.concat([len, Buffer.from(type), data, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    const body = Buffer.concat([chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array(h).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
    return write(file, Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), body]));
  }

  it("writes a small JPEG of an image and of a PDF's first page, and refuses others", async () => {
    await png(path.join(dl, "wide.png"));
    await png(path.join(dl, "sub/wide.png"));
    await png(path.join(dl, "wallet recovery phrase.png"));
    write(path.join(dl, "page.pdf"), pdf("first page", "second page"));
    write(path.join(dl, "notes.txt"), "text");
    const out = path.join(root, "previews");
    const r = await preview(["wide.png", "sub/wide.png", "page.pdf", "wallet recovery phrase.png", "notes.txt"], { base: dl, out, excerptChars: 100 });
    expect(r.slice(0, 3).map((x) => x.preview && path.basename(x.preview))).toEqual(["wide.png.jpg", "wide.png (2).jpg", "page.pdf.jpg"]);
    for (const x of r.slice(0, 3)) expect(fs.readFileSync(x.preview as string).subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(r[3]?.error).toMatch(/sensitive/);
    expect(r[4]?.error).toMatch(/not an image or PDF/);
    if (process.platform === "darwin") {
      const width = execFileSync("/usr/bin/sips", ["-g", "pixelWidth", r[0]?.preview as string], { encoding: "utf8" });
      expect(width).toMatch(/pixelWidth: 1024/);
    }
  });
});
