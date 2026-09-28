import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function readYaml<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  return YAML.parse(fs.readFileSync(file, "utf8")) as T;
}

export function writeYaml(file: string, data: unknown, header?: string): void {
  const body = YAML.stringify(data, { lineWidth: 0 });
  writeAtomic(file, header ? `${header}\n${body}` : body);
}

export function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function writeJson(file: string, data: unknown): void {
  writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

/** Replace a JSONL file's contents (atomically). */
export function writeJsonl(file: string, records: unknown[]): void {
  writeAtomic(file, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

export function appendJsonl(file: string, record: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "a", 0o600);
  const originalSize = fs.fstatSync(fd).size;
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } catch (err) {
    // A failed append must not poison all later reads with a partial JSON line.
    fs.ftruncateSync(fd, originalSize);
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

/** Recover a process-interrupted append. Only the unterminated final record may
 * be repaired; corruption in any earlier record still raises an error on read.
 * Call only while holding the writer's lock, with a journal available to replay. */
export function repairJsonlTail(file: string): void {
  if (!fs.existsSync(file)) return;
  const data = fs.readFileSync(file);
  if (!data.length || data.at(-1) === 10) return;
  const start = data.lastIndexOf(10) + 1;
  let complete = false;
  try { JSON.parse(data.subarray(start).toString("utf8")); complete = true; } catch { /* interrupted JSON */ }
  const fd = fs.openSync(file, "r+");
  try {
    if (complete) fs.writeSync(fd, "\n", data.length);
    else fs.ftruncateSync(fd, start);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Parse JSON or YAML text (YAML is a superset of JSON, but JSON errors are clearer). */
export function parseStructured(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  return YAML.parse(trimmed);
}
