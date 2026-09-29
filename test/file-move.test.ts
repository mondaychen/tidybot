import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moveFile } from "../src/file-move.js";
import { caseInsensitiveFs, write } from "./helpers.js";

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

describe("sources that change during a move", () => {
  it("removes its own destination link when the source is written to mid-move", () => {
    const link = fs.linkSync;
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      link(source, destination);
      if (source === from) fs.appendFileSync(from, " and more");
    });
    expect(() => moveFile(from, to)).toThrow(/changed during move/);
    expect(fs.readFileSync(from, "utf8")).toBe("original contents and more");
    expect(fs.readdirSync(path.dirname(to))).toEqual([]);
  });

  it("removes its staged copy when the source is written to during a cross-device copy", () => {
    crossDevice();
    const copy = fs.copyFileSync;
    vi.spyOn(fs, "copyFileSync").mockImplementation((source, destination, mode) => {
      copy(source, destination, mode);
      fs.appendFileSync(from, " and more");
    });
    expect(() => moveFile(from, to)).toThrow(/changed during move/);
    expect(fs.readFileSync(from, "utf8")).toBe("original contents and more");
    expect(fs.readdirSync(path.dirname(to))).toEqual([]);
  });
});

describe("modification time across devices", () => {
  it("keeps sub-millisecond precision", () => {
    fs.utimesSync(from, 1790611498.797949, 1790611498.797949);
    const mtimeMs = fs.statSync(from).mtimeMs;
    crossDevice();
    moveFile(from, to);
    expect(Math.abs(fs.statSync(to).mtimeMs - mtimeMs)).toBeLessThan(0.001);
  });
});

describe("filesystems without hard links (exFAT, FAT, some network shares)", () => {
  /** link(2) fails with ENOTSUP on exFAT/FAT and EPERM under Linux protected_hardlinks. */
  function noHardLinks(code: string, crossDeviceSource?: string): void {
    vi.spyOn(fs, "linkSync").mockImplementation((source) => {
      if (source === crossDeviceSource) throw Object.assign(new Error("cross device"), { code: "EXDEV" });
      throw Object.assign(new Error(`${code}: link not permitted`), { code });
    });
  }

  it.each(["ENOTSUP", "EPERM"])("moves within the filesystem (%s)", (code) => {
    noHardLinks(code);
    moveFile(from, to);
    expect(fs.readFileSync(to, "utf8")).toBe("original contents");
    expect(fs.existsSync(from)).toBe(false);
  });

  it("moves onto it from another device", () => {
    noHardLinks("ENOTSUP", from);
    moveFile(from, to);
    expect(fs.readFileSync(to, "utf8")).toBe("original contents");
    expect(fs.existsSync(from)).toBe(false);
    expect(fs.readdirSync(path.dirname(to))).toEqual(["target.txt"]);
  });

  it("still refuses to replace an existing destination", () => {
    noHardLinks("ENOTSUP");
    write(to, "existing contents");
    expect(() => moveFile(from, to)).toThrow(/already exists/);
    expect(fs.readFileSync(to, "utf8")).toBe("existing contents");
    expect(fs.readFileSync(from, "utf8")).toBe("original contents");
  });

  it.runIf(caseInsensitiveFs())("renames a file to a case-only variant", () => {
    noHardLinks("ENOTSUP");
    moveFile(from, path.join(root, "Source.txt"));
    expect(fs.readdirSync(root)).toEqual(["Source.txt"]);
    expect(fs.readFileSync(path.join(root, "Source.txt"), "utf8")).toBe("original contents");
  });
});
