import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { applyPlan } from "../src/mover.js";
import { propose } from "../src/planner.js";
import { compactEntry, inspect, listFiles, parseAge, scan } from "../src/scan.js";
import { addFolder } from "../src/store/folders.js";
import { saveSummaries } from "../src/summarize.js";
import { sandbox, write } from "./helpers.js";

let root: string;
let dl: string;
beforeEach(() => {
  root = sandbox();
  dl = path.join(root, "dl");
  addFolder({ name: "Docs", path: path.join(root, "docs") });
  addFolder({ name: "Photos", path: path.join(root, "photos") });
});

function backdate(file: string, days: number): void {
  const t = new Date(Date.now() - days * 86400e3);
  fs.utimesSync(file, t, t);
}

describe("age filter", () => {
  it("parses ages", () => {
    expect(parseAge("14d")).toBe(14 * 86400e3);
    expect(parseAge("2w")).toBe(14 * 86400e3);
    expect(parseAge("12h")).toBe(12 * 3600e3);
    expect(() => parseAge("soon")).toThrow(/Invalid age/);
  });

  it("leaves recent files alone", () => {
    const old = write(path.join(dl, "old.txt"), "x");
    write(path.join(dl, "new.txt"), "x");
    backdate(old, 30);
    const r = listFiles(dl, { maxFiles: 10, before: Date.now() - parseAge("14d") });
    // APFS moves birth time back with mtime; elsewhere birth time may stay "now".
    if (fs.statSync(old).birthtimeMs > Date.now() - 86400e3) return;
    expect(r.files.map((f) => f.name)).toEqual(["old.txt"]);
    expect(r.skippedRecent).toBe(1);
  });
});

describe("paging", () => {
  it("pages with offset and reports nextOffset", () => {
    for (const n of ["a", "b", "c", "d", "e"]) write(path.join(dl, `${n}.txt`), n);
    const p1 = listFiles(dl, { maxFiles: 2 });
    expect(p1.files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
    expect(p1.nextOffset).toBe(2);
    const p3 = listFiles(dl, { maxFiles: 2, offset: 4 });
    expect(p3.files.map((f) => f.name)).toEqual(["e.txt"]);
    expect(p3.truncated).toBe(false);
    expect(p3.nextOffset).toBeUndefined();
  });
});

describe("duplicates", () => {
  it("groups identical files, including copies already filed", async () => {
    write(path.join(dl, "a.pdf"), "same bytes");
    write(path.join(dl, "a (1).pdf"), "same bytes");
    write(path.join(dl, "report.txt"), "filed copy");
    write(path.join(dl, "empty1"), "");
    write(path.join(dl, "empty2"), "");
    // scan + file report.txt once, then a second copy shows up in Downloads
    await scan(dl, { maxFiles: 50, excerptChars: 100 });
    await applyPlan(await propose([{ file: "report.txt", folder: "Docs" }], { source: dl }));
    write(path.join(dl, "report copy.txt"), "filed copy");

    const r = await scan(dl, { maxFiles: 50, excerptChars: 100 });
    const groups = r.duplicates.map((d) => [...d.files].sort());
    expect(groups).toContainEqual(["a (1).pdf", "a.pdf"]);
    const filed = r.duplicates.find((d) => d.files.includes("report copy.txt"));
    expect(filed?.elsewhere[0]).toMatch(/docs\/report\.txt$/);
    expect(r.duplicates.some((d) => d.files.includes("empty1"))).toBe(false);
  });
});

describe("compact scan + inspect", () => {
  it("compact entries are small and point to more", async () => {
    write(path.join(dl, "long.md"), "The quick brown fox. ".repeat(200));
    write(path.join(dl, "short.txt"), "Rent receipt");
    const { files } = await scan(dl, { maxFiles: 10, excerptChars: 1000 });
    const byName = Object.fromEntries(files.map((f) => [f.name, compactEntry(f, 40, false)]));
    expect(byName["long.md"]).toMatchObject({ rel: "long.md", more: true, needsSummary: "recommended" });
    expect(byName["long.md"]?.preview?.length).toBe(41); // 40 + ellipsis
    expect(byName["short.txt"]).toMatchObject({ preview: "Rent receipt" });
    expect(byName["short.txt"]).not.toHaveProperty("more");
    expect(JSON.stringify(byName["long.md"]).length).toBeLessThan(300);

    const [full] = await inspect(["long.md"], dl, { excerptChars: 1000 });
    expect(full?.excerpt?.length).toBe(1000);
    await expect(inspect(["nope.txt"], dl, { excerptChars: 10 })).rejects.toThrow(/not found/);
  });
});

describe("image summary skip", () => {
  it("accepts an unsummarized image with a reason, rejects without one", async () => {
    write(path.join(dl, "Passport Photo IMG 1360.JPG"), Buffer.from([0xff, 0xd8, 9]));
    write(path.join(dl, "IMG_2001.jpg"), Buffer.from([0xff, 0xd8, 8]));
    await scan(dl, { maxFiles: 10, excerptChars: 100 });
    const plan = await propose(
      [
        { file: "Passport Photo IMG 1360.JPG", folder: "Photos", summarySkipped: "name says passport photo" },
        { file: "IMG_2001.jpg", folder: "Photos" },
      ],
      { source: dl },
    );
    expect(plan.items[0]).toMatchObject({ status: "pending", summarySkipped: "name says passport photo" });
    expect(plan.items[1]?.status).toBe("invalid");
    await saveSummaries([{ file: path.join(dl, "IMG_2001.jpg"), summary: "Beach sunset" }], { base: dl });
    expect((await propose([{ file: "IMG_2001.jpg", folder: "Photos" }], { source: dl })).items[0]?.status).toBe("pending");
  });
});
