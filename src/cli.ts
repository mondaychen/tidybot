#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, Option } from "commander";
import { TidyError } from "./errors.js";
import { GUIDE_TOPICS, readGuide, type GuideTopic } from "./guide.js";
import { type ConflictPolicy, applyPlan, compactHistory, forgetMove, selectMoves, undoMoves } from "./mover.js";
import { emit, fail, isJsonMode, renderMoves, renderPlan, setJsonMode, warn } from "./output.js";
import { PROJECT_DIRNAME, contractHome, projectDir, resolvePath, setScopeOverride, tidybotHome } from "./paths.js";
import { findItem, propose, retargetAll, skip } from "./planner.js";
import { compactEntry, inspect, parseAge, scan } from "./scan.js";
import {
  SCALAR_KEYS,
  type Scope,
  activeScope,
  addRule,
  loadConfig,
  loadRules,
  removeRule,
  setConfigValue,
  setRuleAllowed,
  unsetConfigValue,
} from "./store/config.js";
import { addPlace, findPlace, placesFile, importPlaces, loadPlaces, removePlace, savePlaces, updatePlace } from "./store/places.js";
import { loadMoves } from "./store/history.js";
import { abandonOperation, recoverMoves, recoverPendingMoves, withMoveLock } from "./store/operations.js";
import { parseStructured, writeYaml } from "./store/io.js";
import { type Plan, type PlanItem, listPlans, loadPlan, planState, savePlan } from "./store/plans.js";
import { FileIndex, compactSummaries, findSummaries } from "./store/summaries.js";
import { getSummaries, listSummaries, saveSummaries } from "./summarize.js";
import { defaultPreviewDir, preview } from "./preview.js";
import { survey } from "./survey.js";
import { allowFiles } from "./allow.js";
import { RULES } from "./sensitive.js";
import { type TrashStatus, trashStatus } from "./trash.js";
import { loadAllowances, removeAllowance } from "./store/allowlist.js";

const int = (v: string) => {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new TidyError(`Expected a number, got "${v}"`);
  return n;
};

const describeTrash = (t: TrashStatus) => (!t.enabled ? `off: ${t.reason}` : t.target === "system" ? "to the system Trash / Recycle Bin" : `to ${t.target}`);

/** For repeatable options. */
const collect = (value: string, previous: string[]) => [...previous, value];

const INCLUDE_HELP = "also list hidden files or folders matching this glob: a name, or a path relative to the directory if it has a slash (repeatable)";

/** Structured input from --data, a file path, "-" (or `--data -`) or piped stdin. */
function readInput(opts: { data?: string }, file?: string): unknown {
  if (opts.data === "-") return parseStructured(fs.readFileSync(0, "utf8"));
  if (opts.data) return parseStructured(opts.data);
  if (file && file !== "-") return parseStructured(fs.readFileSync(resolvePath(file), "utf8"));
  if (file === "-" || !process.stdin.isTTY) return parseStructured(fs.readFileSync(0, "utf8"));
  throw new TidyError("No input. Pass --data '<json>', a file path, or pipe JSON/YAML on stdin.", "invalid_input");
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** Scope for writes: --global forces global; otherwise the active project, if any. */
const writeScope = (): Scope => activeScope();
const scopeLabel = () => (projectDir() ? `project ${contractHome(path.dirname(projectDir() as string))}` : "global");

const program = new Command("tidybot")
  .description("Organize files into places (folders with rules). An AI agent proposes, you review, tidybot moves (and undoes).\nAI agents: start with `tidybot guide`.")
  .version("0.2.0")
  .option("--json", "machine-readable JSON output (or set TIDYBOT_JSON=1)")
  .option("-g, --global", "ignore any per-project settings (.tidybot/) and use global ones")
  .option("--project <dir>", "use the per-project settings in <dir>/.tidybot")
  .hook("preAction", (cmd, action) => {
    const o = cmd.optsWithGlobals();
    setJsonMode(!!o.json);
    setScopeOverride({ global: o.global, project: o.project });
    if (action.name() === "recover") return;
    try {
      recoverMoves();
    } catch (err) {
      // Only moves need a clean slate; they check again and refuse to start.
      if (!(err instanceof TidyError && err.code === "recovery_required")) throw err;
      warn(err.message);
    }
  })
  .showHelpAfterError();

// ---------------------------------------------------------------- agent-facing

program
  .command("guide")
  .description("print instructions for an AI agent driving tidybot")
  .addArgument(
    new Command()
      .createArgument("[topic]", GUIDE_TOPICS.join(" | "))
      .choices(GUIDE_TOPICS)
      .default("overview"),
  )
  .action((topic: GuideTopic) => {
    const guide = readGuide(topic);
    emit({ topic, guide }, () => guide);
  });

function addScanOptions(cmd: Command): Command {
  return cmd
    .argument("[dir]", "directory to scan (default: config `source`)")
    .option("-r, --recursive", "include files in subdirectories")
    .option("-m, --match <glob>", "only filenames matching this glob, e.g. '*.pdf' or '*.{jpg,png}'")
    .option("--max-files <n>", "files per page (default: config maxFiles)", int)
    .option("--offset <n>", "skip this many files (use `nextOffset` from the previous page)", int)
    .option("--older-than <age>", "leave recent files alone: only files older than e.g. 14d, 2w, 3m (default: config olderThan)")
    .option("--any-age", "ignore the configured olderThan filter")
    .option("--include-organized", "also scan files already inside places (skipped by default)")
    .option("--include-hidden", "also scan hidden files and folders (dotfiles, and files the OS marks hidden or system)")
    .option("--include <glob>", INCLUDE_HELP, collect, []);
}

async function runScan(dirArg: string | undefined, o: Record<string, unknown>, excerptChars?: number) {
  const config = loadConfig();
  const places = loadPlaces();
  const dir = resolvePath(dirArg ?? config.source);
  const skipOrganized = !o.includeOrganized && config.skipOrganized;
  const olderThan = o.anyAge ? "" : ((o.olderThan as string | undefined) ?? config.olderThan);
  const result = await scan(dir, {
    recursive: !!o.recursive,
    match: o.match as string | undefined,
    maxFiles: (o.maxFiles as number | undefined) ?? config.maxFiles,
    offset: o.offset as number | undefined,
    before: olderThan ? Date.now() - parseAge(olderThan) : undefined,
    excerptChars: excerptChars ?? config.excerptChars,
    allowRules: config.allowRules,
    // Deleted files are out of the way, never something to organize.
    skipPlaces: [...(skipOrganized ? places : []), ...(config.trashDir ? [{ name: "trash folder", path: config.trashDir, rule: "" }] : [])],
    includeHidden: !!o.includeHidden,
    include: o.include as string[],
    noHash: o.content === false,
  });
  return { config, places, dir, olderThan, ...result };
}

addScanOptions(
  program
    .command("scan")
    .description(
      "compact list of files (type, size, date, summary or short preview, flags) plus places and rules — step 1 of classifying; use `inspect` for full excerpts",
    ),
)
  .option("--full", "full entries with long excerpts and absolute paths instead of the compact view")
  .option("--excerpt-chars <n>", "characters of content read per file (default: config excerptChars)", int)
  .option("--no-content", "skip content extraction, hashing and summaries (fast listing)")
  .action(async (dirArg: string | undefined, o) => {
    const r = await runScan(dirArg, o, o.content === false ? 0 : o.excerptChars);
    const dupFiles = new Set(r.duplicates.flatMap((d) => d.files));
    const similarFiles = new Set(r.similar.flatMap((g) => g.files));
    const compact = (f: (typeof r.files)[number]) => compactEntry(f, r.config.previewChars, { duplicate: dupFiles.has(f.rel), similar: similarFiles.has(f.rel) });
    const needs = {
      required: r.files.filter((f) => f.needsSummary === "required").length,
      recommended: r.files.filter((f) => f.needsSummary === "recommended").length,
    };
    const data = {
      source: r.dir,
      scope: scopeLabel(),
      count: r.files.length,
      truncated: r.truncated,
      ...(r.nextOffset !== undefined ? { nextOffset: r.nextOffset } : {}),
      olderThan: r.olderThan || null,
      skippedRecent: r.skippedRecent,
      skippedPlaces: r.skippedPlaces,
      skippedHidden: r.skippedHidden,
      ...(r.skippedDirs.length ? { skippedDirs: r.skippedDirs } : {}),
      ...(r.unreadable.length ? { unreadable: r.unreadable } : {}),
      needsSummary: needs,
      sensitive: r.files.filter((f) => f.sensitive).length,
      duplicates: r.duplicates,
      similar: r.similar,
      ...(r.extractedArchives.length ? { extractedArchives: r.extractedArchives } : {}),
      rename: r.config.rename,
      naming: r.config.naming,
      extensionCase: r.config.extensionCase,
      rules: r.config.rules,
      trash: trashStatus(r.config),
      places: r.places,
      files: o.full ? r.files : r.files.map(compact),
    };
    emit(data, () => {
      const lines = [`${r.files.length} file(s) in ${contractHome(r.dir)}${r.truncated ? ` (more: --offset ${r.nextOffset})` : ""}`];
      if (r.olderThan) lines.push(`older than ${r.olderThan}: ${r.skippedRecent} recent file(s) left alone`);
      if (r.skippedPlaces.length) lines.push(`skipped places: ${r.skippedPlaces.join(", ")}`);
      if (r.skippedHidden) lines.push(`${r.skippedHidden} hidden file(s) or folder(s) left out (--include-hidden, or --include <glob>)`);
      if (r.skippedDirs.length) lines.push(`${r.skippedDirs.length} subfolder(s) not scanned (add -r): ${r.skippedDirs.join(", ")}`);
      if (r.unreadable.length) lines.push(`couldn't read: ${r.unreadable.join(", ")}`);
      for (const f of r.files.map(compact)) {
        const flags = [
          f.sensitive ? `sensitive: ${f.sensitive} (${f.sensitiveRule})` : "",
          f.needsSummary ? `summary ${f.needsSummary}` : "",
          f.duplicate ? "duplicate" : "",
          f.similar ? "similar" : "",
          f.more ? "more" : "",
        ]
          .filter(Boolean)
          .map((x) => `[${x}]`)
          .join(" ");
        lines.push(`  ${f.rel}  ${f.mime ?? ""}  ${f.size}B  ${f.modified}${flags ? `  ${flags}` : ""}`);
        const text = f.summary ?? f.preview;
        if (text) lines.push(`      ${text.replace(/\s+/g, " ")}`);
      }
      for (const d of r.duplicates) lines.push(`duplicate: ${[...d.files, ...d.elsewhere].join("  =  ")}`);
      for (const g of r.similar) lines.push(`similar (${g.why}, not identical): ${g.files.join("  ~  ")}`);
      for (const a of r.extractedArchives) lines.push(`extracted archive: ${a.archive} was extracted into ${a.dir}/; one of them may be redundant`);
      if (needs.required || needs.recommended) lines.push("", `Summaries needed: ${needs.required} required, ${needs.recommended} recommended. See \`tidybot guide summarize\`.`);
      if (r.places.length === 0) lines.push("", "No places yet. See `tidybot guide onboard`.");
      else lines.push("", "Places:", ...r.places.map((f) => `  ${f.name} → ${f.path}${f.rule ? `  (${f.rule})` : ""}`));
      if (r.config.rules.length) lines.push("", "Rules:", ...r.config.rules.map((x) => `  - ${x}`));
      lines.push("", `Rename: ${r.config.rename}${r.config.naming ? `. Naming: ${r.config.naming}` : ""}${r.config.extensionCase === "lower" ? ". Extensions: lowercase" : ""}`);
      lines.push(`Deleting: ${describeTrash(trashStatus(r.config))}`);
      return lines.join("\n");
    });
  });

program
  .command("inspect")
  .description("full details (long excerpt, summary, flags) for specific files — step 2 after a compact scan")
  .argument("<files...>", "paths, relative to --source")
  .option("-s, --source <dir>", "directory the paths are relative to (default: config `source`)")
  .option("--excerpt-chars <n>", "characters of content per file (default: config excerptChars)", int)
  .action(async (files: string[], o) => {
    const config = loadConfig();
    const base = resolvePath(o.source ?? config.source);
    const entries = await inspect(files, base, { excerptChars: o.excerptChars ?? config.excerptChars, allowRules: config.allowRules });
    emit({ source: base, files: entries }, () =>
      entries
        .map((f) => [`${f.rel}  ${f.mime ?? f.ext}  ${f.size}B`, f.sensitive ? `  [sensitive: ${f.sensitive}]` : `  ${(f.summary ?? f.excerpt ?? "(no text)").replace(/\s+/g, " ")}`].join("\n"))
        .join("\n"),
    );
  });

program
  .command("preview")
  .description("write a small JPEG of images (HEIC, WebP, …) or of a PDF's first page, for agents whose image tools can't open them")
  .argument("<files...>", "paths, relative to --source")
  .option("-s, --source <dir>", "directory the paths are relative to (default: config `source`)")
  .option("-o, --out <dir>", "where to write the previews (default: a tidybot-previews folder in the temp directory)")
  .action(async (files: string[], o) => {
    const config = loadConfig();
    const base = resolvePath(o.source ?? config.source);
    const out = o.out ? resolvePath(o.out) : defaultPreviewDir();
    const results = await preview(files, { base, out, excerptChars: config.excerptChars, allowRules: config.allowRules });
    const failed = results.filter((r) => r.error).length;
    emit({ ok: failed === 0, out, previews: results }, () => results.map((r) => (r.preview ? `${r.file} → ${r.preview}` : `✗ ${r.file}: ${r.error}`)).join("\n"));
    if (failed) process.exitCode = 1;
  });

program
  .command("survey")
  .description("summarize existing directory structure so an agent can propose places (onboarding)")
  .argument("<dirs...>", "directories to survey, e.g. ~/Documents")
  .option("-d, --depth <n>", "how many levels deep to descend", int, 3)
  .option("--samples <n>", "sample file names per directory", int, 5)
  .option("--max-dirs <n>", "cap on directories reported per root", int, 200)
  .option("--include-hidden", "also survey hidden files and folders")
  .option("--include <glob>", INCLUDE_HELP, collect, [])
  .action((dirs: string[], o) => {
    const places = loadPlaces();
    const roots = dirs.map((d) =>
      survey(resolvePath(d), { depth: o.depth, samples: o.samples, maxDirs: o.maxDirs, places, includeHidden: o.includeHidden, include: o.include }),
    );
    emit({ roots, places }, () =>
      roots
        .flatMap((r) => [
          `${r.root}${r.truncated ? `  (truncated: ${r.truncatedBy.map((t) => (t === "depth" ? `deeper folders not shown, raise --depth (now ${o.depth})` : `more folders than --max-dirs ${o.maxDirs}`)).join("; ")})` : ""}`,
          ...r.dirs.map((d) => {
            const exts = d.topExtensions.map((e) => `${e.ext}×${e.count}`).join(" ");
            const place = d.place ? `  [place: ${d.place}]` : "";
            return `${"  ".repeat(d.depth + 1)}${path.basename(d.path) || d.path}/  ${d.totalFiles} files  ${exts}${place}`;
          }),
        ])
        .join("\n"),
    );
  });

program
  .command("propose")
  .description("submit an agent's classification (and renames) as a reviewable plan (moves nothing)")
  .argument("[file]", "JSON/YAML file with proposals, or - for stdin")
  .option("--data <json>", "proposals inline, or - for stdin (better for large plans)")
  .option("-s, --source <dir>", "directory that relative file paths refer to (default: config `source`)")
  .option("-a, --append [planId]", "merge into an existing open plan (default: latest open)")
  .option("--allow-unsummarized", "accept images that have no cached summary")
  .action(async (file: string | undefined, o) => {
    const input = readInput(o, file);
    const config = loadConfig();
    const appendTo = o.append ? loadPlan(o.append === true ? undefined : o.append) : undefined;
    const plan = await propose(input, { source: o.source ?? config.source, config, appendTo, allowUnsummarized: o.allowUnsummarized });
    emit({ ok: true, plan }, () => `${renderPlan(plan)}\n\nReview, then run: tidybot apply ${plan.id}`);
  });

// ---------------------------------------------------------------- summaries & search

const summary = program.command("summary").description("cached file summaries (by content hash), written by an agent");

addScanOptions(summary.command("todo").description("files that still need a summary (images: required; long documents: recommended)"))
  .option("--required-only", "only files where a summary is required")
  .action(async (dirArg: string | undefined, o) => {
    const r = await runScan(dirArg, o, 200);
    // A summary belongs to the content, so identical copies are listed once, under the first path.
    const byHash = new Map<string, { file: string; rel: string; mime: string | null; size: number; need?: string; hash?: string; copies?: string[] }>();
    for (const f of r.files.filter((f) => f.needsSummary && (!o.requiredOnly || f.needsSummary === "required"))) {
      const first = f.hash ? byHash.get(f.hash) : undefined;
      if (first) first.copies = [...(first.copies ?? []), f.rel];
      else byHash.set(f.hash ?? f.path, { file: f.path, rel: f.rel, mime: f.mime, size: f.size, need: f.needsSummary, hash: f.hash });
    }
    const todo = [...byHash.values()];
    emit({ source: r.dir, truncated: r.truncated, count: todo.length, files: todo }, () =>
      todo.length
        ? todo.map((t) => `${t.need?.padEnd(11)} ${t.rel}${t.copies ? `  (same content: ${t.copies.join(", ")})` : ""}`).join("\n")
        : "All files have summaries (or don't need one).",
    );
  });

summary
  .command("save")
  .description("store summaries: [{file|hash, summary, keywords[]}]")
  .argument("[file]", "JSON/YAML file, or - for stdin")
  .option("--data <json>", "summaries inline, or - for stdin")
  .option("--model <name>", "model that wrote them (recorded for reference)")
  .option("-s, --source <dir>", "directory that relative file paths refer to (default: cwd)")
  .action(async (file: string | undefined, o) => {
    const saved = await saveSummaries(readInput(o, file), { base: resolvePath(o.source ?? "."), model: o.model, allowRules: loadConfig().allowRules });
    emit({ ok: true, saved }, () => `Saved ${saved.length} summar${saved.length === 1 ? "y" : "ies"}.`);
  });

summary
  .command("get")
  .description("show cached summaries for files")
  .argument("<files...>")
  .action(async (files: string[]) => {
    const rows = await getSummaries(files, process.cwd());
    emit(rows, () =>
      rows
        .map((r) => `${contractHome(r.file)}\n  ${r.summary ? `${r.summary.summary}\n  keywords: ${r.summary.keywords.join(", ")}` : "(no summary)"}`)
        .join("\n"),
    );
  });

summary
  .command("list")
  .description("all cached summaries with current file locations (for semantic search by an agent)")
  .option("--include-missing", "include summaries whose file location is unknown")
  .action(async (o) => {
    const rows = await listSummaries({ includeMissing: o.includeMissing });
    emit(rows, () =>
      rows.length ? rows.map((r) => `${r.paths.map(contractHome).join(", ") || "(location unknown)"}\n  ${r.summary.slice(0, 120)}`).join("\n") : "No summaries yet.",
    );
  });

summary
  .command("prune")
  .description("forget locations of files that no longer exist (summaries are kept)")
  .action(() => {
    const index = new FileIndex();
    const n = index.prune();
    index.save();
    emit({ ok: true, pruned: n }, () => `Pruned ${n} stale location(s).`);
  });

program
  .command("find")
  .description("search files by summary, keywords and name")
  .argument("<words...>")
  .option("-l, --limit <n>", "max results", int, 20)
  .option("--include-missing", "include matches whose file location is unknown")
  .action(async (words: string[], o) => {
    const hits = await findSummaries(words.join(" "), { limit: o.limit, includeMissing: o.includeMissing });
    emit(hits, () =>
      hits.length
        ? hits.map((h) => `${h.paths.map(contractHome).join(", ") || `(moved/unknown: ${h.name})`}\n  ${h.summary.slice(0, 140).replace(/\s+/g, " ")}`).join("\n")
        : "No matches. (Only summarized files are searchable; for fuzzy queries ask your agent to read `tidybot summary list`.)",
    );
  });

// ---------------------------------------------------------------- sensitive-file exceptions

const sensitive = program
  .command("sensitive")
  .description("sensitive-file detection: list rules, and allow false positives (per file or per rule)");

sensitive
  .command("rules")
  .description("detection rules with their ids, and which are turned off")
  .action(() => {
    const off = new Set(loadConfig().allowRules);
    const rows = RULES.map((r) => ({ id: r.id, kind: r.kind, reason: r.reason, allowed: off.has(r.id) }));
    emit(rows, () => rows.map((r) => `${r.allowed ? "off" : "on "}  ${r.id.padEnd(24)} ${r.reason}`).join("\n"));
  });

sensitive
  .command("list", { isDefault: true })
  .description("current exceptions: allowed files and turned-off rules")
  .action(() => {
    const files = Object.values(loadAllowances());
    const index = new FileIndex();
    const rows = files.map((a) => ({ ...a, paths: index.pathsFor(a.hash) }));
    const rules = loadConfig().allowRules;
    emit({ files: rows, rules }, () =>
      [
        rules.length ? `rules turned off: ${rules.join(", ")}` : "rules turned off: none",
        ...(rows.length
          ? rows.map((r) => `${r.name}  [${r.content ? "all rules" : "name rules"}; flagged by ${r.rule ?? "?"}]\n    ${r.reason}  (${r.hash.slice(0, 19)})`)
          : ["allowed files: none"]),
      ].join("\n"),
    );
  });

sensitive
  .command("allow")
  .description(
    "allow flagged files (false positives). Waives filename rules only; files whose content matches a rule need --content, which requires the user's OK",
  )
  .argument("<files...>")
  .requiredOption("--reason <text>", "why this is not a secret (shown in `tidybot sensitive list`)")
  .option("--content", "also waive content rules for this exact file content (ask the user first)")
  .option("-s, --source <dir>", "directory the paths are relative to (default: cwd)")
  .action(async (files: string[], o) => {
    const r = await allowFiles(files, { base: resolvePath(o.source ?? "."), reason: o.reason, content: o.content, allowRules: loadConfig().allowRules });
    emit({ ok: true, ...r }, () =>
      [
        `Allowed ${r.allowed.length} file(s)${o.content ? " (all rules)" : " (filename rules only)"}.`,
        ...r.notFlagged.map((f) => `  ${f}: not flagged, nothing to allow`),
        "Allowances are tied to the file's current content; if it changes it will be checked again.",
      ].join("\n"),
    );
  });

sensitive
  .command("revoke")
  .description("remove file exceptions (by path or hash)")
  .argument("<filesOrHashes...>")
  .action(async (targets: string[]) => {
    const index = new FileIndex();
    const removed = [];
    for (const t of targets) {
      const hash = /^(sha256|quick):/.test(t) ? t : await index.hashOf(resolvePath(t));
      const r = removeAllowance(hash);
      if (!r) throw new TidyError(`No exception for ${t}`, "not_found");
      removed.push(r);
    }
    index.save();
    emit({ ok: true, removed }, () => `Revoked ${removed.length} exception(s).`);
  });

sensitive
  .command("allow-rule")
  .description("turn a detection rule off in the current scope (ask the user first)")
  .argument("<ruleId>", "see `tidybot sensitive rules`")
  .action((id: string) => {
    const list = setRuleAllowed(id, true, writeScope());
    emit({ ok: true, scope: writeScope(), allowRules: list }, () => `Turned off ${id} (${writeScope()}).`);
  });

sensitive
  .command("disallow-rule")
  .description("turn a detection rule back on in the current scope")
  .argument("<ruleId>")
  .action((id: string) => {
    const list = setRuleAllowed(id, false, writeScope());
    emit({ ok: true, scope: writeScope(), allowRules: list }, () => `Turned ${id} back on (${writeScope()}).`);
  });

// ---------------------------------------------------------------- plans

const plan = program.command("plan").description("review and edit proposed moves and deletions");

plan
  .command("list")
  .description("list plans, newest first")
  .option("--all", "include done and discarded plans")
  .action((o) => {
    const plans = listPlans().filter((p) => o.all || planState(p) === "open");
    const rows = plans.map((p) => ({
      id: p.id,
      state: planState(p),
      createdAt: p.createdAt,
      source: p.source,
      pending: p.items.filter((i) => i.status === "pending").length,
      total: p.items.length,
    }));
    emit(rows, () =>
      rows.length
        ? rows.map((r) => `${r.id}  ${r.state.padEnd(9)} ${r.pending}/${r.total} pending  ${contractHome(r.source)}`).join("\n")
        : "No plans. (use --all to include finished ones)",
    );
  });

plan
  .command("show")
  .description("show a plan (default: latest open)")
  .argument("[planId]")
  .action((id?: string) => {
    const p = loadPlan(id);
    emit(p, () => renderPlan(p));
  });

plan
  .command("set")
  .description("change where files go (a place or --path), a file's new name, or mark files for deletion")
  .argument("<files...>", "file paths (relative to the plan source). `plan set <file> <place>` also works")
  .option("--place <name>", "place name")
  .option("--path <dir>", "custom destination directory instead of a place")
  .option("--name <newName>", "rename the file (one file only; extension is kept)")
  .option("--keep-name", "cancel a proposed rename")
  .option("--delete", "delete the files instead (they go to the trash)")
  .option("-p, --plan <id>", "plan id (default: latest open)")
  .action((args: string[], o) => {
    const p = loadPlan(o.plan);
    let files = args;
    let place: string | undefined = o.place;
    // The older form: a place name after the file(s), when it isn't also a file in the plan.
    const last = args.at(-1) as string;
    if (!place && !o.path && !o.delete && args.length > 1 && findPlace(loadPlaces(), last) && !inPlan(p, last)) {
      place = last;
      files = args.slice(0, -1);
    }
    const items = retargetAll(p, files, { place, path: o.path, name: o.keepName ? null : o.name, delete: o.delete });
    const where = (i: PlanItem) => (i.delete ? "trash" : contractHome(path.join(i.destination ?? "", i.newName ?? path.basename(i.file))));
    emit({ ok: true, planId: p.id, items }, () =>
      items.flatMap((i, n) => [`${files[n]} → ${where(i)}`, ...(i.warnings ?? []).map((w) => `  ⚠ ${w}`)]).join("\n"),
    );
  });

/** True if `file` names an item of the plan (pending or done). */
function inPlan(plan: Plan, file: string): boolean {
  try {
    findItem(plan, file);
    return true;
  } catch (err) {
    return !(err instanceof TidyError && err.code === "not_found");
  }
}

plan
  .command("skip")
  .description("leave a file where it is")
  .argument("<files...>")
  .option("-p, --plan <id>", "plan id (default: latest open)")
  .action((files: string[], o) => {
    const p = loadPlan(o.plan);
    const items = files.map((f) => skip(p, f));
    emit({ ok: true, planId: p.id, items }, () => `Skipped ${items.length} file(s).`);
  });

plan
  .command("discard")
  .description("abandon a plan")
  .argument("[planId]")
  .action((id?: string) => {
    const p = loadPlan(id);
    p.discarded = true;
    savePlan(p);
    emit({ ok: true, planId: p.id }, () => `Discarded plan ${p.id}.`);
  });

// ---------------------------------------------------------------- moving

program
  .command("apply")
  .description("move (and rename) or delete the pending files of a plan (default: latest open). Asks for confirmation.")
  .argument("[planId]")
  .option("-n, --dry-run", "show what would move")
  .option("-y, --yes", "don't ask for confirmation (required when not on a TTY)")
  .addOption(
    new Option("--on-conflict <policy>", "if a same-named file exists at the destination").choices(["fail", "rename"]).default("fail"),
  )
  .action(async (id: string | undefined, o) => {
    const p = loadPlan(id);
    const preview = await applyPlan(p, { dryRun: true });
    const moves = preview.wouldMove?.length ?? 0;
    const deletions = preview.wouldTrash?.length ?? 0;
    if (o.dryRun || moves + deletions === 0) {
      emit({ ok: true, dryRun: true, planId: p.id, wouldMove: preview.wouldMove, wouldTrash: preview.wouldTrash }, () =>
        moves + deletions === 0 ? "Nothing pending in this plan." : renderPlan(p),
      );
      return;
    }
    if (!o.yes) {
      if (!process.stdin.isTTY || isJsonMode()) {
        throw new TidyError("Refusing to move or delete files without confirmation. Re-run with --yes once the plan is approved.", "needs_confirmation");
      }
      process.stderr.write(`${renderPlan(p)}\n\n`);
      const what = [moves ? `move ${moves} file(s)` : "", deletions ? `delete ${deletions} file(s) (${describeTrash(trashStatus(loadConfig()))})` : ""]
        .filter(Boolean)
        .join(" and ");
      if (!(await confirm(`${what.charAt(0).toUpperCase()}${what.slice(1)}?`))) {
        process.stderr.write("Aborted.\n");
        return;
      }
    }
    const result = await applyPlan(p, { onConflict: o.onConflict as ConflictPolicy });
    const toSystem = result.trashed.filter((t) => t.to === null).length;
    emit({ ok: result.failed.length === 0, planId: p.id, ...result }, () =>
      [
        `Moved ${result.moved.length} file(s).`,
        result.trashed.length ? `Deleted ${result.trashed.length} file(s)${toSystem ? `; ${toSystem} went to the system Trash, restore those from there` : ""}.` : "",
        ...result.failed.map((f) => `  ✗ ${contractHome(f.file)}: ${f.error}`),
        result.moved.length || result.trashed.length > toSystem ? `Undo with: tidybot undo --plan ${p.id}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    if (result.failed.length) process.exitCode = 1;
  });

program
  .command("history")
  .description("show recorded moves, newest first")
  .option("--all", "include undone and forgotten moves")
  .option("-p, --plan <id>", "only moves from this plan")
  .option("-l, --limit <n>", "max entries", int, 50)
  .action((o) => {
    const moves = loadMoves()
      .filter((m) => (o.all || m.state === "active") && (!o.plan || m.planId === o.plan))
      .reverse()
      .slice(0, o.limit);
    emit(moves, () => renderMoves(moves));
  });

program
  .command("undo")
  .description("move files back to where they came from (and restore their names)")
  .argument("[ids...]", "history entry ids (see `tidybot history`)")
  .option("-p, --plan <id>", "undo every active move of a plan")
  .option("--last", "undo the most recent batch")
  .action((ids: string[], o) => {
    const moves = selectMoves({ ids, planId: o.plan, last: o.last });
    const result = undoMoves(moves);
    emit({ ok: result.failed.length === 0, ...result }, () =>
      [
        moves.length === 0 ? "Nothing to undo." : `Restored ${result.undone.length} file(s).`,
        ...result.failed.map((f) => `  ✗ ${f.id}: ${f.error}  (drop it with: tidybot forget ${f.id})`),
      ].join("\n"),
    );
    if (result.failed.length) process.exitCode = 1;
  });

program
  .command("recover")
  .description("finish or roll back moves that were interrupted (runs automatically before other commands)")
  .option("--abandon <ids...>", "forget interrupted operations recovery can't resolve, after checking their files yourself (files are left as they are)")
  .action((o) => {
    if (o.abandon) {
      const dropped = (o.abandon as string[]).map(abandonOperation);
      emit({ ok: true, abandoned: dropped }, () =>
        dropped.map((d) => `Abandoned ${d.id}: ${contractHome(d.from)} → ${d.to ? contractHome(d.to) : "system Trash"}${d.backup ? `\n  a copy may be held at ${contractHome(d.backup)}` : ""}`).join("\n"),
      );
      return;
    }
    const resolved = withMoveLock(recoverPendingMoves);
    emit({ ok: true, resolved }, () => (resolved ? `Resolved ${resolved} interrupted operation(s).` : "Nothing to recover."));
  });

program
  .command("forget")
  .description("drop a history entry that can no longer be undone")
  .argument("<ids...>")
  .action((ids: string[]) => {
    const entries = ids.map(forgetMove);
    emit({ ok: true, forgotten: entries }, () => `Forgot ${entries.length} entr${entries.length === 1 ? "y" : "ies"}.`);
  });

// ---------------------------------------------------------------- places

const places = program.command("places").description("manage places: destination folders, each with a name, a path and a natural-language rule");

places
  .command("list", { isDefault: true })
  .description("list places")
  .action(() => {
    const list = loadPlaces();
    emit({ scope: scopeLabel(), file: placesFile(), places: list }, () =>
      list.length
        ? [`(${scopeLabel()})`, ...list.map((f) => `${f.name}  ${f.path}${f.rule ? `\n    ${f.rule}` : ""}`)].join("\n")
        : "No places. Add one with `tidybot places add <name> <path> --rule '...'`.",
    );
  });

places
  .command("add")
  .description("add a place")
  .argument("<name>")
  .argument("<path>")
  .option("-r, --rule <text>", "what belongs in this place", "")
  .action((name: string, p: string, o) => {
    const f = addPlace({ name, path: p, rule: o.rule });
    emit({ ok: true, scope: scopeLabel(), place: f }, () => `Added ${f.name} → ${f.path}  (${scopeLabel()})`);
  });

places
  .command("edit")
  .description("change a place's name, path or rule")
  .argument("<name>")
  .option("--name <new>", "new name")
  .option("--path <dir>", "new path")
  .option("-r, --rule <text>", "new rule")
  .action((name: string, o) => {
    const patch = Object.fromEntries(Object.entries({ name: o.name, path: o.path, rule: o.rule }).filter(([, v]) => v !== undefined));
    const f = updatePlace(name, patch);
    emit({ ok: true, place: f }, () => `Updated ${f.name} → ${f.path}`);
  });

places
  .command("rm")
  .description("remove a place (does not touch files on disk)")
  .argument("<name>")
  .action((name: string) => {
    const f = removePlace(name);
    emit({ ok: true, removed: f }, () => `Removed ${f.name}`);
  });

places
  .command("import")
  .description("add/update many places at once from JSON or YAML (e.g. an agent's onboarding proposal)")
  .argument("[file]", "JSON/YAML file, or - for stdin")
  .option("--data <json>", "places inline, or - for stdin")
  .option("--replace", "replace all existing places instead of merging")
  .option("-n, --dry-run", "validate and show the result without saving")
  .action((file: string | undefined, o) => {
    const r = importPlaces(readInput(o, file), { replace: o.replace, dryRun: o.dryRun });
    emit({ ok: true, dryRun: !!o.dryRun, scope: scopeLabel(), ...r }, () =>
      [
        `${o.dryRun ? "Would add" : "Added"} ${r.added.length}, ${o.dryRun ? "would update" : "updated"} ${r.updated.length}. Total: ${r.places.length}.  (${scopeLabel()})`,
        ...r.added.map((f) => `  + ${f.name}  ${f.path}`),
        ...r.updated.map((f) => `  ~ ${f.name}  ${f.path}`),
      ].join("\n"),
    );
  });

// ---------------------------------------------------------------- rules (naming style + general instructions)

const rules = program.command("rules").description("naming style and general instructions for the agent (beyond per-place rules)");

rules
  .command("list", { isDefault: true })
  .description("show naming style, rename mode and rules (global and project)")
  .action(() => {
    const c = loadConfig();
    const scopes = loadRules();
    emit({ rename: c.rename, naming: c.naming, extensionCase: c.extensionCase, rules: c.rules, byScope: scopes }, () =>
      [
        `rename: ${c.rename}`,
        `naming: ${c.naming || "(none — agent uses its default style)"}`,
        `extensions: ${c.extensionCase === "lower" ? "lowercase when renamed" : "kept as they are"}`,
        ...scopes.flatMap((s) => [`${s.scope} rules:`, ...(s.rules.length ? s.rules.map((r, i) => `  ${i + 1}. ${r}`) : ["  (none)"])]),
      ].join("\n"),
    );
  });

rules
  .command("add")
  .description("add a general rule, e.g. \"never move files containing 'draft'\"")
  .argument("<text...>")
  .action((text: string[]) => {
    const list = addRule(text.join(" "), writeScope());
    emit({ ok: true, scope: writeScope(), rules: list }, () => `Added ${writeScope()} rule #${list.length}.`);
  });

rules
  .command("rm")
  .description("remove a rule by its number in `tidybot rules` (current scope)")
  .argument("<n>", "rule number", int)
  .action((n: number) => {
    const removed = removeRule(n, writeScope());
    emit({ ok: true, scope: writeScope(), removed }, () => `Removed: ${removed}`);
  });

rules
  .command("naming")
  .description("show or set the naming style used when renaming files")
  .argument("[style...]", "e.g. \"YYYY-MM-DD first, lowercase, words separated by dashes\"")
  .option("--clear", "remove the naming style")
  .action((style: string[], o) => {
    if (o.clear) unsetConfigValue("naming", writeScope());
    else if (style.length) setConfigValue("naming", style.join(" "), writeScope());
    const naming = loadConfig().naming;
    emit({ naming }, () => naming || "(no naming style set)");
  });

// ---------------------------------------------------------------- config, init & status

const config = program.command("config").description("view or change settings");
config
  .command("get", { isDefault: true })
  .description("show effective settings (global merged with project)")
  .argument("[key]")
  .action((key?: string) => {
    const c = loadConfig();
    if (key && !(key in c)) throw new TidyError(`Unknown config key "${key}"`);
    const value = key ? c[key as keyof typeof c] : c;
    emit(value, () =>
      key
        ? String(value)
        : [`(${scopeLabel()})`, ...Object.entries(c).map(([k, v]) => `${k}: ${Array.isArray(v) ? `${v.length} rule(s)` : v === "" ? '""' : v}`)].join("\n"),
    );
  });
config
  .command("set")
  .description("set a value in the current scope (project if inside one, else global; -g forces global)")
  .argument("<key>", SCALAR_KEYS.join(" | "))
  .argument("<value>")
  .action((key: string, value: string) => {
    const c = setConfigValue(key, value, writeScope());
    emit({ ok: true, scope: writeScope(), config: c }, () => `${key}: ${c[key as keyof typeof c]}  (${writeScope()})`);
  });
config
  .command("unset")
  .description("remove a value from the current scope (falls back to global / default)")
  .argument("<key>", SCALAR_KEYS.join(" | "))
  .action((key: string) => {
    const c = unsetConfigValue(key, writeScope());
    emit({ ok: true, scope: writeScope(), config: c }, () => `${key}: ${c[key as keyof typeof c]}`);
  });

program
  .command("init")
  .description("create per-project settings (.tidybot/) — places and config that apply under this directory")
  .argument("[dir]", "project root", ".")
  .option("--copy-global", "start from a copy of the global places")
  .action((dir: string, o) => {
    const root = resolvePath(dir);
    const target = path.join(root, PROJECT_DIRNAME);
    if (target === tidybotHome()) throw new TidyError("That is the global tidybot home.");
    if (fs.existsSync(target)) throw new TidyError(`${contractHome(target)} already exists.`);
    const initial = o.copyGlobal ? loadPlaces(path.join(tidybotHome(), "places.yaml")) : [];
    savePlaces(initial, path.join(target, "places.yaml"));
    writeYaml(path.join(target, "config.yaml"), {}, "# Project overrides for tidybot. Unset keys fall back to ~/.tidybot/config.yaml.\n# `rules` here are added to the global rules.");
    emit({ ok: true, project: target, places: initial.length }, () =>
      `Created ${contractHome(target)} with ${initial.length} place(s).\nCommands run under ${contractHome(root)} now use these settings (override with --global).`,
    );
  });

program
  .command("compact")
  .description("apply historyMaxMoves and summariesMax now, and drop superseded summary records")
  .action(() => {
    const c = loadConfig();
    const moves = compactHistory(c.historyMaxMoves);
    const summaries = compactSummaries(c.summariesMax);
    emit({ ok: true, droppedMoves: moves, droppedSummaries: summaries }, () => `Dropped ${moves} move(s) and ${summaries} summary record(s).`);
  });

program
  .command("status")
  .description("active scope, where state lives, place count, open plans")
  .action(() => {
    const open = listPlans().filter((p) => planState(p) === "open");
    const c = loadConfig();
    // Applied and not undone. Files sent to the system Trash are restored from there, not by undo.
    const undoable = loadMoves().filter((m) => m.state === "active" && m.to !== null);
    const data = {
      home: tidybotHome(),
      project: projectDir() ?? null,
      config: c,
      places: loadPlaces().length,
      openPlans: open.map((p) => p.id),
      undoableMoves: undoable.length,
      lastUndoablePlan: undoable.findLast((m) => m.planId)?.planId ?? null,
      trash: trashStatus(c),
    };
    emit(data, () =>
      [
        `home:         ${contractHome(data.home)}`,
        `project:      ${data.project ? contractHome(data.project) : "none (global settings)"}`,
        `source:       ${c.source}`,
        `places:       ${data.places}${data.places === 0 ? "  (run `tidybot guide onboard`)" : ""}`,
        `rename:       ${c.rename}${c.naming ? `  naming: ${c.naming}` : ""}`,
        `rules:        ${c.rules.length}`,
        `deleting:     ${describeTrash(data.trash)}`,
        `open plans:   ${data.openPlans.join(", ") || "none"}`,
        `can undo:     ${data.undoableMoves} move(s)${data.lastUndoablePlan ? `  (latest plan: tidybot undo --plan ${data.lastUndoablePlan})` : ""}`,
      ].join("\n"),
    );
  });

program.parseAsync().catch(fail);
