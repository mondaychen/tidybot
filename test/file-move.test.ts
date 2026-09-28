import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moveFile } from "../src/file-move.js";
import { write } from "./helpers.js";

let root: string;
let from: string;
let to: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tidybot-move-"));
  from = write(path.join(root, "source.txt"), "original contents");
  to = path.join(root, "dest", "target.txt");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function crossDevice(): void {
  const link = fs.linkSync;
  vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
    if (source === from) throw Object.assign(new Error("cross device"), { code: "EXDEV" });
    link(source, destination);
  });
}

describe("exclusive file moves", () => {
  it("copies across devices, preserving modification time and removing staging files", () => {
    const time = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(from, time, time);
    crossDevice();
    moveFile(from, to);
    expect(fs.readFileSync(to, "utf8")).toBe("original contents");
    expect(fs.statSync(to).mtimeMs).toBe(time.getTime());
    expect(fs.existsSync(from)).toBe(false);
    expect(fs.readdirSync(path.dirname(to))).toEqual(["target.txt"]);
  });

  it("rolls back an exclusive copy when metadata cannot be preserved", () => {
    crossDevice();
    vi.spyOn(fs, "utimesSync").mockImplementation(() => { throw new Error("metadata failed"); });
    expect(() => moveFile(from, to)).toThrow(/metadata failed/);
    expect(fs.readFileSync(from, "utf8")).toBe("original contents");
    expect(fs.readdirSync(path.dirname(to))).toEqual([]);
  });

  it("preserves a dangling destination symlink", () => {
    fs.mkdirSync(path.dirname(to));
    fs.symlinkSync("missing.txt", to);
    expect(() => moveFile(from, to)).toThrow(/already exists/);
    expect(fs.readlinkSync(to)).toBe("missing.txt");
    expect(fs.existsSync(from)).toBe(true);
  });

  it("rolls back the destination when source removal fails", () => {
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (file === from) throw new Error("source removal failed");
      unlink(file);
    });
    expect(() => moveFile(from, to)).toThrow(/source removal failed/);
    expect(fs.readFileSync(from, "utf8")).toBe("original contents");
    expect(fs.existsSync(to)).toBe(false);
  });
});
