import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { applyPlan, selectMoves, undoMoves } from "../src/mover.js";
import { tidybotHome } from "../src/paths.js";
import { propose } from "../src/planner.js";
import { setConfigValue } from "../src/store/config.js";
import { addPlace } from "../src/store/places.js";
import { loadMoves, trimHistory } from "../src/store/history.js";
import { compactSummaries, loadSummaries } from "../src/store/summaries.js";
import { saveSummaries } from "../src/summarize.js";
import { sandbox, write } from "./helpers.js";

let root: string;
let dl: string;
const lines = (name: string) => fs.readFileSync(path.join(tidybotHome(), name), "utf8").trim().split("\n");

beforeEach(() => {
  root = sandbox();
  dl = path.join(root, "dl");
  addPlace({ name: "Docs", path: path.join(root, "docs"), rule: "" });
});

async function moveFiles(names: string[]) {
  for (const n of names) write(path.join(dl, n), n);
  await applyPlan(await propose(names.map((file) => ({ file, place: "Docs" })), { source: dl }));
}

describe("history retention", () => {
  it("is unlimited by default", async () => {
    await moveFiles(["a.txt", "b.txt", "c.txt"]);
    expect(loadMoves()).toHaveLength(3);
  });

  it("keeps the newest moves and their undo records after apply", async () => {
    await moveFiles(["a.txt"]);
    undoMoves(selectMoves({ last: true }));
    setConfigValue("historyMaxMoves", "2", "global");
    await moveFiles(["b.txt", "c.txt"]);
    expect(loadMoves().map((m) => path.basename(m.from))).toEqual(["b.txt", "c.txt"]);
    expect(lines("history.jsonl")).toHaveLength(2); // a's move and undo are both gone
  });

  it("keeps undo/forget records for moves that survive", async () => {
    await moveFiles(["a.txt", "b.txt"]);
    undoMoves(selectMoves({ ids: [loadMoves()[1]!.id] }));
    expect(trimHistory(1)).toBe(1);
    const [m] = loadMoves();
    expect(path.basename(m!.from)).toBe("b.txt");
    expect(m!.state).toBe("undone");
  });
});

describe("summary retention", () => {
  it("drops superseded records on save", async () => {
    write(path.join(dl, "a.pdf"), "x");
    await saveSummaries([{ file: "a.pdf", summary: "first" }], { base: dl });
    await saveSummaries([{ file: "a.pdf", summary: "second" }], { base: dl });
    expect(lines("summaries.jsonl")).toHaveLength(1);
    expect([...(await loadSummaries()).values()][0]?.summary).toBe("second");
  });

  it("keeps the most recently written summaries when capped", async () => {
    for (const n of ["a", "b", "c"]) write(path.join(dl, `${n}.pdf`), n);
    await saveSummaries(
      ["a", "b", "c"].map((n) => ({ file: `${n}.pdf`, summary: n })),
      { base: dl },
    );
    await saveSummaries([{ file: "a.pdf", summary: "a again" }], { base: dl }); // a is now the newest
    expect(compactSummaries(2)).toBe(1);
    expect([...(await loadSummaries()).values()].map((s) => s.summary)).toEqual(["c", "a again"]);
  });

  it("enforces summariesMax on save", async () => {
    setConfigValue("summariesMax", "1", "global");
    for (const n of ["a", "b"]) write(path.join(dl, `${n}.pdf`), n);
    await saveSummaries([{ file: "a.pdf", summary: "a" }, { file: "b.pdf", summary: "b" }], { base: dl });
    expect([...(await loadSummaries()).values()].map((s) => s.summary)).toEqual(["b"]);
  });
});
