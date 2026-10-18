import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_NAME_BYTES, nameBytes } from "../src/names.js";
import { findItem, propose, sanitizeName } from "../src/planner.js";
import { addPlace, savePlaces } from "../src/store/places.js";
import { caseInsensitiveFs, sandbox, write } from "./helpers.js";

let root: string;
let dl: string;
beforeEach(() => {
  root = sandbox();
  dl = path.join(root, "dl");
  addPlace({ name: "Docs", path: path.join(root, "docs") });
});


describe("without places", () => {
  it("still accepts renames in place and deletions", async () => {
    savePlaces([]);
    write(path.join(dl, "scan0001.pdf"), "a");
    write(path.join(dl, "copy.pdf"), "b");
    const plan = await propose([{ file: "scan0001.pdf", place: null, rename: "lease" }, { file: "copy.pdf", delete: true }], { source: dl });
    expect(plan.items.map((i) => i.status)).toEqual(["pending", "pending"]);
    await expect(propose([{ file: "copy.pdf", place: "Docs" }], { source: dl })).rejects.toThrow(/No places/);
  });
});

describe("skipping on purpose", () => {
  it("leaves the file in place with its own note, and needs no image summary", async () => {
    write(path.join(dl, "taxes-2023/w2.pdf"), "a");
    write(path.join(dl, "taxes-2023/receipt.jpg"), "b");
    write(path.join(dl, "misc.pdf"), "c");
    const plan = await propose(
      [
        { file: "taxes-2023/w2.pdf", skip: true, reason: "already grouped by the user" },
        { file: "taxes-2023/receipt.jpg", skip: true },
        { file: "misc.pdf", place: null },
      ],
      { source: dl },
    );
    expect(plan.items.map((i) => [i.status, i.note])).toEqual([
      ["skipped", "left in place by agent"],
      ["skipped", "left in place by agent"],
      ["skipped", "agent found no matching place"],
    ]);
    expect(plan.items[0]).toMatchObject({ place: null, destination: null, reason: "already grouped by the user" });
  });

  it("rejects a skip combined with a move, rename or delete", async () => {
    write(path.join(dl, "a.pdf"), "a");
    for (const extra of [{ place: "Docs" }, { rename: "b" }, { delete: true }]) {
      await expect(propose([{ file: "a.pdf", skip: true, ...extra }], { source: dl })).rejects.toThrow(/can't also have/);
    }
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
});

describe("case-insensitive conflict warnings", () => {
  it("warns when two targets differ only by case", async () => {
    write(path.join(dl, "a/X.pdf"), "1");
    write(path.join(dl, "b/x.pdf"), "2");
    const plan = await propose(
      [
        { file: "a/X.pdf", place: "Docs" },
        { file: "b/x.pdf", place: "Docs" },
      ],
      { source: dl },
    );
    expect(plan.items[1]?.warnings?.[0]).toMatch(/same target/);
  });

  it.runIf(caseInsensitiveFs())("records the file name as spelled on disk", async () => {
    write(path.join(dl, "report.pdf"), "x");
    const plan = await propose([{ file: "REPORT.pdf", place: "Docs" }], { source: dl });
    expect(plan.items[0]?.file).toBe(path.join(dl, "report.pdf"));
  });

  it.runIf(caseInsensitiveFs())("warns when an existing file differs only by case", async () => {
    write(path.join(root, "docs/NOTES.txt"), "existing");
    write(path.join(dl, "notes.txt"), "new");
    const plan = await propose([{ file: "notes.txt", place: "Docs" }], { source: dl });
    expect(plan.items[0]?.warnings?.[0]).toMatch(/already exists/);
  });
});

describe("plan details", () => {
  it("refuses ambiguous short file references", async () => {
    write(path.join(dl, "a/x.txt"), "1");
    write(path.join(dl, "b/x.txt"), "2");
    const plan = await propose(
      [
        { file: "a/x.txt", place: "Docs", rename: "one" },
        { file: "b/x.txt", place: "Docs", rename: "two" },
      ],
      { source: dl },
    );
    expect(() => findItem(plan, "x.txt")).toThrow(/matches 2 files/);
    expect(findItem(plan, "b/x.txt").newName).toBe("two.txt");
  });

  it("records the rules and places in effect", async () => {
    write(path.join(dl, "a.txt"), "1");
    const plan = await propose([{ file: "a.txt", place: "Docs" }], { source: dl });
    expect(plan.context).toMatchObject({ rename: "auto", rules: [], places: [{ name: "Docs" }] });
  });
});
