/**
 * End-to-end checks against the generated Downloads fixture (see README.md). The fixture's
 * manifest is the ground truth; tidybot runs as a CLI, as an agent would drive it.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface Item {
  path: string;
  kind: "file" | "dir" | "symlink";
  category: string | null;
  sensitive: "secret" | "pii" | null;
  tags: string[];
  duplicate_of: string | null;
  sha256?: string;
}
interface Manifest {
  summary: { categories: string[]; duplicate_groups: string[][]; recent_within_14_days: string[]; hidden_files: string[] };
  items: Item[];
}
interface ScanFile {
  rel: string;
  mime: string | null;
  excerpt?: string;
  summary?: string;
  sensitive?: string;
  needsSummary?: "required" | "recommended";
}
interface ScanResult {
  files: ScanFile[];
  duplicates: { files: string[]; elsewhere: string[] }[];
}

const repo = fileURLToPath(new URL("../../", import.meta.url));
let root: string;
let fixture: string;
let manifest: Manifest;

/** Run the CLI with its own state directory; returns parsed --json output. */
function tidybot(home: string, args: string[], input?: string) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--json", ...args], {
    cwd: repo,
    env: { ...process.env, TIDYBOT_HOME: home, TIDYBOT_NO_PROJECT: "1" },
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tidybot ${args.join(" ")} exited ${result.status}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

const home = (name: string) => path.join(root, `home-${name}`);
const files = () => manifest.items.filter((i) => i.kind === "file");
const topLevel = () => files().filter((i) => !i.path.includes("/"));
const isImage = (f: ScanFile) => !!f.mime?.startsWith("image/");
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const groups = (g: string[][]) => g.map((x) => [...x].sort()).sort((a, b) => a.join().localeCompare(b.join()));

function listTree(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tidybot-e2e-"));
  fixture = path.join(root, "Downloads");
  const manifestPath = path.join(root, "manifest.json");
  const real = process.env.TIDYBOT_E2E_REAL_FROM;
  const built = spawnSync("python3", [
    "test/e2e/make_downloads_test.py", fixture, "--manifest", manifestPath, ...(real ? ["--real-from", real] : []),
  ], { cwd: repo, encoding: "utf8" });
  if (built.error || built.status !== 0) {
    throw new Error(
      `Building the fixture failed. It needs: pip install reportlab pillow python-docx openpyxl python-pptx\n${built.stderr ?? built.error}`,
    );
  }
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("scan", () => {
  let listing: ScanResult;
  let full: ScanResult;
  let byRel: Map<string, ScanFile>;

  beforeAll(() => {
    listing = tidybot(home("scan"), ["scan", fixture, "--no-content", "--any-age", "--max-files", "1000"]);
    full = tidybot(home("scan"), ["scan", fixture, "-r", "--full", "--any-age", "--include-organized", "--max-files", "1000"]);
    byRel = new Map(full.files.map((f) => [f.rel, f]));
  });

  it("lists every top-level file, and no hidden files, directories or symlinks", () => {
    expect(listing.files.map((f) => f.rel).sort()).toEqual(topLevel().map((i) => i.path).sort());
  });

  it("lists nested files in a recursive scan", () => {
    expect(full.files.map((f) => f.rel)).toEqual(expect.arrayContaining(files().map((i) => i.path)));
  });

  it.runIf(process.platform === "darwin")("leaves exactly the recent files alone with --older-than 14d", () => {
    // Relies on macOS moving a file's creation time back with its mtime (see README.md).
    const old = tidybot(home("scan"), ["scan", fixture, "--no-content", "--older-than", "14d", "--max-files", "1000"]) as ScanResult;
    const skipped = listing.files.map((f) => f.rel).filter((rel) => !old.files.some((f) => f.rel === rel));
    expect(skipped.sort()).toEqual([...manifest.summary.recent_within_14_days].sort());
  });

  it("reports exactly the byte-identical groups, including large sampled-hash files", () => {
    expect(full.duplicates.every((d) => d.elsewhere.length === 0)).toBe(true);
    expect(groups(full.duplicates.map((d) => d.files))).toEqual(groups(manifest.summary.duplicate_groups));
  });

  describe("secrets", () => {
    const secrets = () => files().filter((i) => i.sensitive === "secret");

    it("flags every secret, or asks for an image to be viewed", () => {
      for (const item of secrets()) {
        const f = byRel.get(item.path);
        expect(f, item.path).toBeDefined();
        if (f?.sensitive) continue;
        expect(isImage(f!), `${item.path} is neither flagged nor an image`).toBe(true);
        expect(f).toMatchObject({ needsSummary: "required" });
        expect(f?.excerpt).toBeUndefined();
      }
    });

    it("never shows or caches secret values", () => {
      const summaries = path.join(home("scan"), "summaries.jsonl");
      const haystack = JSON.stringify([listing, full]) + (fs.existsSync(summaries) ? fs.readFileSync(summaries, "utf8") : "");
      for (const item of secrets()) {
        const bytes = fs.readFileSync(path.join(fixture, item.path));
        if (bytes.includes(0) || isImage(byRel.get(item.path)!)) continue; // binary containers: flagged above
        const values = bytes
          .toString("utf8")
          .split(/[\s,:="'/]+/)
          .filter((t) => t.length >= 8 && /\d/.test(t) && !item.path.includes(t));
        expect(values.length, `${item.path} should contain secret-looking values`).toBeGreaterThan(0);
        expect(values.filter((v) => haystack.includes(v)), item.path).toEqual([]);
      }
    });
  });

  describe("content", () => {
    // Secrets are covered above. PII stays in: tidybot doesn't treat it as sensitive.
    const tagged = (tag: string) => files().filter((i) => i.tags.includes(tag) && i.sensitive !== "secret");

    it("gives badly named documents enough text to classify", () => {
      for (const item of tagged("needs-content")) {
        const f = byRel.get(item.path);
        expect(f?.excerpt || f?.summary, item.path).toBeTruthy();
      }
    });

    it("reads CJK text, including PDFs in non-embedded fonts", () => {
      expect(tagged("cjk-content").length).toBeGreaterThan(0);
      for (const item of tagged("cjk-content")) expect(byRel.get(item.path)?.excerpt, item.path).toMatch(/\p{Script=Han}/u);
    });

    it("asks for a summary of anything only viewing can classify", () => {
      for (const item of tagged("needs-vision")) {
        const f = byRel.get(item.path)!;
        if (f.sensitive) continue; // Flagged by name: withheld, not summarized.
        expect(f.needsSummary, item.path).toBe(isImage(f) ? "required" : "recommended");
      }
    });
  });
});

describe("apply and undo", () => {
  const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");

  it("files everything by category, then puts every byte back", () => {
    const state = home("move");
    const organized = path.join(root, "Organized");
    for (const c of manifest.summary.categories) tidybot(state, ["folders", "add", c, path.join(organized, slug(c))]);

    // Top-level files plus the nested folder, whose names collide with top-level ones
    // (exactly, and by case only), so conflicts must be renamed.
    const items = files().filter((i) => i.category && (!i.path.includes("/") || i.path.startsWith("old downloads/")));
    const proposal = { source: fixture, items: items.map((i) => ({ file: i.path, folder: i.category })) };
    const { plan } = tidybot(state, ["propose", "-", "--allow-unsummarized"], JSON.stringify(proposal));
    expect(plan.items.filter((i: { status: string }) => i.status !== "pending")).toEqual([]);

    const applied = tidybot(state, ["apply", plan.id, "--yes", "--on-conflict", "rename"]);
    expect(applied.failed).toEqual([]);
    expect(applied.moved).toHaveLength(items.length);
    const key = (file: string) => file.normalize("NFC");
    const byFile = new Map(items.map((i) => [key(path.join(fixture, i.path)), i]));
    for (const m of applied.moved as { file: string; to: string }[]) {
      const item = byFile.get(key(m.file));
      expect(item, m.file).toBeDefined();
      expect(fs.existsSync(m.file), m.file).toBe(false);
      expect(sha256(m.to), m.to).toBe(item?.sha256);
    }
    expect(applied.moved.some((m: { to: string }) => / \(1\)\.pdf$/.test(m.to))).toBe(true);

    const undone = tidybot(state, ["undo", "--last"]);
    expect(undone.failed).toEqual([]);
    expect(undone.undone).toHaveLength(items.length);
    for (const item of items) expect(sha256(path.join(fixture, item.path)), item.path).toBe(item.sha256);
    expect(listTree(organized)).toEqual([]);
    expect(listTree(path.join(state, "operations"))).toEqual([]);
  });
});
