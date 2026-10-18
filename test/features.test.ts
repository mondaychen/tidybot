import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyPlan, selectMoves, undoMoves } from "../src/mover.js";
import { projectDir } from "../src/paths.js";
import { propose, retarget, sanitizeName } from "../src/planner.js";
import { scan } from "../src/scan.js";
import { addRule, loadConfig, loadRules, removeRule, setConfigValue } from "../src/store/config.js";
import { addPlace, loadPlaces, savePlaces } from "../src/store/places.js";
import { findSummaries } from "../src/store/summaries.js";
import { getSummaries, listSummaries, saveSummaries } from "../src/summarize.js";
import { sandbox, write } from "./helpers.js";

let root: string;
let dl: string;
beforeEach(() => {
  root = sandbox();
  dl = path.join(root, "dl");
  addPlace({ name: "Legal", path: path.join(root, "docs/legal"), rule: "immigration and legal" });
  addPlace({ name: "Photos", path: path.join(root, "docs/photos"), rule: "pictures" });
});

describe("smart rename", () => {
  it("sanitizes names and keeps the extension", () => {
    expect(sanitizeName("2023-05-01 I-485 receipt", "/x/3f2a.pdf")).toBe("2023-05-01 I-485 receipt.pdf");
    expect(sanitizeName("report.PDF", "/x/a.pdf")).toBe("report.PDF");
    expect(sanitizeName('a:b*c?"', "/x/a.txt")).toBe("a-b-c-.txt");
    expect(sanitizeName("  ...hidden", "/x/a.txt")).toBe("hidden.txt");
    expect(sanitizeName("a", "/x/a")).toBeUndefined(); // unchanged
    expect(() => sanitizeName("../evil", "/x/a.txt")).toThrow(/path separators/);
  });

  it("moves with a new name and undo restores the original name", async () => {
    write(path.join(dl, "3f2a9c1e.pdf"), "x");
    const plan = await propose([{ file: "3f2a9c1e.pdf", place: "Legal", rename: "2023-05-01 I-485 receipt notice" }], { source: dl });
    expect(plan.items[0]?.newName).toBe("2023-05-01 I-485 receipt notice.pdf");
    await applyPlan(plan);
    expect(fs.existsSync(path.join(root, "docs/legal/2023-05-01 I-485 receipt notice.pdf"))).toBe(true);
    undoMoves(selectMoves({ last: true }));
    expect(fs.existsSync(path.join(dl, "3f2a9c1e.pdf"))).toBe(true);
  });

  it("renames in place when place is null", async () => {
    write(path.join(dl, "scan0001.txt"), "x");
    const plan = await propose([{ file: "scan0001.txt", place: null, rename: "lease" }], { source: dl });
    expect(plan.items[0]?.status).toBe("pending");
    await applyPlan(plan);
    expect(fs.existsSync(path.join(dl, "lease.txt"))).toBe(true);
  });

  it("warns about conflicts at propose time so the agent can rename", async () => {
    write(path.join(root, "docs/legal/notice.txt"), "existing");
    write(path.join(dl, "notice.txt"), "new");
    write(path.join(dl, "a/x.txt"), "1");
    write(path.join(dl, "b/x.txt"), "2");
    const plan = await propose(
      [
        { file: "notice.txt", place: "Legal" },
        { file: "a/x.txt", place: "Legal" },
        { file: "b/x.txt", place: "Legal" },
      ],
      { source: dl },
    );
    expect(plan.items[0]?.warnings?.[0]).toMatch(/already exists/);
    expect(plan.items[2]?.warnings?.[0]).toMatch(/same target as x.txt/);
    const fixed = retarget(plan, "notice.txt", { name: "notice 2026" });
    expect(fixed.warnings).toBeUndefined();
    expect(fixed.destination).toBe(path.join(root, "docs/legal"));
  });

  it("ignores renames when rename mode is off", async () => {
    setConfigValue("rename", "off");
    write(path.join(dl, "a.txt"), "x");
    const plan = await propose([{ file: "a.txt", place: "Legal", rename: "b" }], { source: dl });
    expect(plan.items[0]?.newName).toBeUndefined();
    expect(plan.items[0]?.warnings?.[0]).toMatch(/rename ignored/);
  });
});

describe("rules & config", () => {
  it("stores naming, rename mode and general rules", () => {
    setConfigValue("naming", "YYYY-MM-DD first, dashes");
    addRule("never move drafts");
    addRule("tax beats bills");
    expect(removeRule(1)).toBe("never move drafts");
    const c = loadConfig();
    expect(c).toMatchObject({ naming: "YYYY-MM-DD first, dashes", rules: ["tax beats bills"], rename: "auto" });
    expect(() => setConfigValue("rename", "sometimes")).toThrow();
    expect(() => setConfigValue("skipOrganized", "maybe")).toThrow();
    expect(setConfigValue("skipOrganized", "no").skipOrganized).toBe(false);
  });
});

describe("per-project settings", () => {
  it("project places replace global ones and config/rules layer on top", () => {
    addRule("global rule");
    setConfigValue("maxFiles", "50");
    const proj = path.join(root, "proj");
    savePlaces([{ name: "Specs", path: path.join(proj, "specs"), rule: "" }], path.join(proj, ".tidybot/places.yaml"));
    vi.stubEnv("TIDYBOT_NO_PROJECT", "");
    vi.stubEnv("TIDYBOT_PROJECT", proj);
    expect(projectDir()).toBe(path.join(proj, ".tidybot"));
    expect(loadPlaces().map((f) => f.name)).toEqual(["Specs"]);
    addRule("project rule");
    setConfigValue("excerptChars", "300");
    expect(loadConfig()).toMatchObject({ source: proj, maxFiles: 50, excerptChars: 300, rules: ["global rule", "project rule"] });
    expect(loadRules().map((s) => s.scope)).toEqual(["global", "project"]);

    vi.stubEnv("TIDYBOT_NO_PROJECT", "1");
    expect(loadConfig().excerptChars).toBe(1000);
    expect(loadPlaces().map((f) => f.name)).toEqual(["Legal", "Photos"]);
  });
});

describe("recursive scan", () => {
  it("skips places below the scan root unless asked", async () => {
    const home = path.join(root, "home-dir");
    addPlace({ name: "Bills", path: path.join(home, "bills") });
    write(path.join(home, "loose.txt"), "x");
    write(path.join(home, "bills/old.txt"), "x");
    write(path.join(home, "misc/new.txt"), "x");
    const places = loadPlaces();
    const r = await scan(home, { recursive: true, maxFiles: 50, excerptChars: 0, skipPlaces: places, noHash: true });
    expect(r.files.map((f) => f.rel).sort()).toEqual(["loose.txt", path.join("misc", "new.txt")]);
    expect(r.skippedPlaces).toEqual(["Bills"]);
    const all = await scan(home, { recursive: true, maxFiles: 50, excerptChars: 0, noHash: true });
    expect(all.files).toHaveLength(3);
    // scanning a place directly still works
    const inside = await scan(path.join(home, "bills"), { recursive: true, maxFiles: 50, excerptChars: 0, skipPlaces: places, noHash: true });
    expect(inside.files).toHaveLength(1);
  });
});

describe("config paths", () => {
  it("pins a relative source and trashDir to the directory they were set in", () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    expect(setConfigValue("source", "dl", "global").source).toBe(path.join(root, "dl"));
    expect(setConfigValue("trashDir", "bin", "global").trashDir).toBe(path.join(root, "bin"));
    expect(setConfigValue("source", "~/Downloads", "global").source).toBe("~/Downloads");
  });
});

describe("summaries", () => {
  it("flags images and long docs, auto-caches short text", async () => {
    write(path.join(dl, "IMG_1234.jpg"), Buffer.from([0xff, 0xd8, 0, 0]));
    write(path.join(dl, "long.txt"), "word ".repeat(500));
    write(path.join(dl, "short.txt"), "Rent receipt March");
    const { files } = await scan(dl, { maxFiles: 10, excerptChars: 100 });
    const by = Object.fromEntries(files.map((f) => [f.name, f]));
    expect(by["IMG_1234.jpg"]?.needsSummary).toBe("required");
    expect(by["long.txt"]?.needsSummary).toBe("recommended");
    expect(by["short.txt"]).toMatchObject({ complete: true, excerpt: "Rent receipt March" });
    expect((await findSummaries("rent", { limit: 5 }))[0]?.name).toBe("short.txt");
    expect(by["short.txt"]?.needsSummary).toBeUndefined();
  });

  it("requires image summaries before proposing, then caches by hash across moves", async () => {
    const img = write(path.join(dl, "IMG_1234.jpg"), Buffer.from([0xff, 0xd8, 1, 2]));
    await scan(dl, { maxFiles: 10, excerptChars: 100 });
    const blocked = await propose([{ file: "IMG_1234.jpg", place: "Photos" }], { source: dl });
    expect(blocked.items[0]).toMatchObject({ status: "invalid" });
    expect(blocked.items[0]?.note).toMatch(/summary/);

    await saveSummaries([{ file: img, summary: "Photo of a Costco receipt dated 2026-03-02", keywords: ["Receipt", "costco"] }], { base: dl, model: "haiku" });
    const plan = await propose([{ file: "IMG_1234.jpg", place: "Photos", rename: "2026-03-02 costco receipt" }], { source: dl });
    expect(plan.items[0]?.status).toBe("pending");
    await applyPlan(plan);

    const hits = await findSummaries("costco receipt", { limit: 5 });
    expect(hits[0]?.paths).toEqual([path.join(root, "docs/photos/2026-03-02 costco receipt.jpg")]);
    expect(hits[0]?.keywords).toEqual(["receipt", "costco"]);
    expect((await listSummaries())[0]?.model).toBe("haiku");

    // same bytes elsewhere → same summary
    const copy = write(path.join(root, "elsewhere/copy.jpg"), Buffer.from([0xff, 0xd8, 1, 2]));
    const [got] = await getSummaries([copy], root);
    expect(got?.summary?.summary).toMatch(/Costco/);
  });

  it("finds by word prefix, ranks keywords first, and segments Chinese", async () => {
    const a = write(path.join(dl, "a.pdf"), "a");
    const b = write(path.join(dl, "b.pdf"), "b");
    const c = write(path.join(dl, "c.pdf"), "c");
    await saveSummaries([
      { file: a, summary: "Mentions an invoice in passing", keywords: ["travel"] },
      { file: b, summary: "Hotel booking", keywords: ["invoice"] },
      { file: c, summary: "公司2025年度财务报告，包括收入和支出", keywords: [] },
    ], { base: dl });
    expect((await findSummaries("invoice", { limit: 5 })).map((h) => h.name)).toEqual(["b.pdf", "a.pdf"]);
    expect((await findSummaries("invo", { limit: 5 })).map((h) => h.name)).toEqual(["b.pdf", "a.pdf"]);
    expect((await findSummaries("财务", { limit: 5 })).map((h) => h.name)).toEqual(["c.pdf"]);
    expect(await findSummaries("unrelated", { limit: 5 })).toEqual([]);
  });

  it("validates summary input", async () => {
    await expect(saveSummaries([{ summary: "x" }], { base: dl })).rejects.toThrow(/file` or `hash/);
    await expect(saveSummaries([{ file: "nope.txt", summary: "x" }], { base: dl })).rejects.toThrow(/not found/);
  });
});
