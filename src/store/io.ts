import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
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

export function appendJsonl(file: string, record: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/** Parse JSON or YAML text (YAML is a superset of JSON, but JSON errors are clearer). */
export function parseStructured(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  return YAML.parse(trimmed);
}
