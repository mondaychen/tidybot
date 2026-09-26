#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, Option } from "commander";
import { TidyError } from "./errors.js";
import { GUIDES, type GuideTopic } from "./guide.js";
import { type ConflictPolicy, applyPlan, forgetMove, selectMoves, undoMoves } from "./mover.js";
import { emit, fail, isJsonMode, renderMoves, renderPlan, setJsonMode } from "./output.js";
import { PROJECT_DIRNAME, contractHome, projectDir, resolvePath, setScopeOverride, tidybotHome } from "./paths.js";
import { propose, retarget, skip } from "./planner.js";
import { scan } from "./scan.js";
import {
  SCALAR_KEYS,
  type Scope,
  activeScope,
  addRule,
  loadConfig,
  loadRules,
  removeRule,
  setConfigValue,
  unsetConfigValue,
} from "./store/config.js";
import { addFolder, foldersFile, importFolders, loadFolders, removeFolder, saveFolders, updateFolder } from "./store/folders.js";
import { loadMoves } from "./store/history.js";
import { parseStructured, writeYaml } from "./store/io.js";
import { listPlans, loadPlan, planState, savePlan } from "./store/plans.js";
import { FileIndex, findSummaries } from "./store/summaries.js";
import { getSummaries, listSummaries, saveSummaries } from "./summarize.js";
import { survey } from "./survey.js";

const int = (v: string) => {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new TidyError(`Expected a number, got "${v}"`);
  return n;
};

/** Structured input from --data, a file path, "-" or piped stdin. */
function readInput(opts: { data?: string }, file?: string): unknown {
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
  .description("Organize files into smart folders. An AI agent proposes, you review, tidybot moves (and undoes).")
  .version("0.2.0")
  .option("--json", "machine-readable JSON output (or set TIDYBOT_JSON=1)")
  .option("-g, --global", "ignore any per-project settings (.tidybot/) and use global ones")
  .option("--project <dir>", "use the per-project settings in <dir>/.tidybot")
  .hook("preAction", (cmd) => {
    const o = cmd.optsWithGlobals();
    setJsonMode(!!o.json);
    setScopeOverride({ global: o.global, project: o.project });
  })
  .showHelpAfterError();

// ---------------------------------------------------------------- agent-facing

program
  .command("guide")
  .description("print instructions for an AI agent driving tidybot")
  .addArgument(
    new Command().createArgument("[topic]", "organize | summarize | onboard").choices(["organize", "summarize", "onboard"]).default("organize"),
  )
  .action((topic: GuideTopic) => emit({ topic, guide: GUIDES[topic] }, () => GUIDES[topic]));

function addScanOptions(cmd: Command): Command {
  return cmd
    .argument("[dir]", "directory to scan (default: config `source`)")
    .option("-r, --recursive", "include files in subdirectories")
    .option("-m, --match <glob>", "only filenames matching this pattern, e.g. '*.pdf'")
    .option("--max-files <n>", "cap on number of files", int)
    .option("--include-organized", "also scan files already inside smart folders (skipped by default)");
}

async function runScan(dirArg: string | undefined, o: Record<string, unknown>, excerptChars?: number) {
  const config = loadConfig();
  const folders = loadFolders();
  const dir = resolvePath(dirArg ?? config.source);
  const skipOrganized = !o.includeOrganized && config.skipOrganized;
  const result = await scan(dir, {
    recursive: !!o.recursive,
    match: o.match as string | undefined,
    maxFiles: (o.maxFiles as number | undefined) ?? config.maxFiles,
    excerptChars: excerptChars ?? config.excerptChars,
    skipFolders: skipOrganized ? folders : [],
    noHash: o.content === false,
  });
  return { config, folders, dir, ...result };
}

addScanOptions(
  program
    .command("scan")
    .description("files with type info, content excerpts and cached summaries, plus smart folders and rules — the context an agent needs"),
)
  .option("--excerpt-chars <n>", "characters of content per file (0 = none)", int)
  .option("--no-content", "skip content extraction, hashing and summaries (fast listing)")
  .action(async (dirArg: string | undefined, o) => {
    const r = await runScan(dirArg, o, o.content === false ? 0 : o.excerptChars);
    const needs = {
      required: r.files.filter((f) => f.needsSummary === "required").length,
      recommended: r.files.filter((f) => f.needsSummary === "recommended").length,
    };
    const data = {
      source: r.dir,
      scope: scopeLabel(),
      truncated: r.truncated,
      skippedFolders: r.skippedFolders,
      needsSummary: needs,
      sensitive: r.files.filter((f) => f.sensitive).length,
      rename: r.config.rename,
      naming: r.config.naming,
      rules: r.config.rules,
      folders: r.folders,
      files: r.files,
    };
    emit(data, () => {
      const lines = [`${r.files.length} file(s) in ${contractHome(r.dir)}${r.truncated ? " (truncated, raise --max-files)" : ""}`];
      if (r.skippedFolders.length) lines.push(`skipped smart folders: ${r.skippedFolders.join(", ")}`);
      for (const f of r.files) {
        const flag = f.sensitive ? `  [sensitive: ${f.sensitive}]` : f.needsSummary ? `  [summary ${f.needsSummary}]` : "";
        lines.push(`  ${f.rel}  ${f.mime ?? f.ext ?? ""}  ${f.size}B${flag}`);
        const text = f.summary ?? f.excerpt;
        if (text) lines.push(`      ${text.slice(0, 100).replace(/\s+/g, " ")}${text.length > 100 ? "…" : ""}`);
      }
      if (needs.required || needs.recommended) lines.push("", `Summaries needed: ${needs.required} required, ${needs.recommended} recommended. See \`tidybot guide summarize\`.`);
      if (r.folders.length === 0) lines.push("", "No smart folders yet. See `tidybot guide onboard`.");
      return lines.join("\n");
    });
  });

program
  .command("survey")
  .description("summarize existing directory structure so an agent can propose smart folders (onboarding)")
  .argument("<dirs...>", "directories to survey, e.g. ~/Documents")
  .option("-d, --depth <n>", "how many levels deep to descend", int, 3)
  .option("--samples <n>", "sample file names per directory", int, 5)
  .option("--max-dirs <n>", "cap on directories reported per root", int, 200)
  .action((dirs: string[], o) => {
    const folders = loadFolders();
    const roots = dirs.map((d) => survey(resolvePath(d), { depth: o.depth, samples: o.samples, maxDirs: o.maxDirs, folders }));
    emit({ roots, folders }, () =>
      roots
        .flatMap((r) => [
          `${r.root}${r.truncated ? "  (truncated)" : ""}`,
          ...r.dirs.map((d) => {
            const exts = d.topExtensions.map((e) => `${e.ext}×${e.count}`).join(" ");
            const smart = d.smartFolder ? `  [smart folder: ${d.smartFolder}]` : "";
            return `${"  ".repeat(d.depth + 1)}${path.basename(d.path) || d.path}/  ${d.totalFiles} files  ${exts}${smart}`;
          }),
        ])
        .join("\n"),
    );
  });

program
  .command("propose")
  .description("submit an agent's classification (and renames) as a reviewable plan (moves nothing)")
  .argument("[file]", "JSON/YAML file with proposals, or - for stdin")
  .option("--data <json>", "proposals inline")
  .option("-s, --source <dir>", "directory that relative file paths refer to (default: config `source`)")
  .option("-a, --append [planId]", "merge into an existing open plan (default: latest open)")
  .option("--allow-unsummarized", "accept images that have no cached summary")
  .action((file: string | undefined, o) => {
    const input = readInput(o, file);
    const config = loadConfig();
    const appendTo = o.append ? loadPlan(o.append === true ? undefined : o.append) : undefined;
    const plan = propose(input, { source: o.source ?? config.source, config, appendTo, allowUnsummarized: o.allowUnsummarized });
    emit({ ok: true, plan }, () => `${renderPlan(plan)}\n\nReview, then run: tidybot apply ${plan.id}`);
  });

// ---------------------------------------------------------------- summaries & search

const summary = program.command("summary").description("cached file summaries (by content hash), written by an agent");

addScanOptions(summary.command("todo").description("files that still need a summary (images: required; long documents: recommended)"))
  .option("--required-only", "only files where a summary is required")
  .action(async (dirArg: string | undefined, o) => {
    const r = await runScan(dirArg, o, 200);
    const todo = r.files
      .filter((f) => f.needsSummary && (!o.requiredOnly || f.needsSummary === "required"))
      .map((f) => ({ file: f.path, rel: f.rel, mime: f.mime, size: f.size, need: f.needsSummary, hash: f.hash }));
    emit({ source: r.dir, truncated: r.truncated, count: todo.length, files: todo }, () =>
      todo.length ? todo.map((t) => `${t.need?.padEnd(11)} ${t.rel}`).join("\n") : "All files have summaries (or don't need one).",
    );
  });

summary
  .command("save")
  .description("store summaries: [{file|hash, summary, keywords[]}]")
  .argument("[file]", "JSON/YAML file, or - for stdin")
  .option("--data <json>", "summaries inline")
  .option("--model <name>", "model that wrote them (recorded for reference)")
  .option("-s, --source <dir>", "directory that relative file paths refer to (default: cwd)")
  .action(async (file: string | undefined, o) => {
    const saved = await saveSummaries(readInput(o, file), { base: resolvePath(o.source ?? "."), model: o.model });
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
  .action((o) => {
    const rows = listSummaries({ includeMissing: o.includeMissing });
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
  .action((words: string[], o) => {
    const hits = findSummaries(words.join(" "), { limit: o.limit, includeMissing: o.includeMissing });
    emit(hits, () =>
      hits.length
        ? hits.map((h) => `${h.paths.map(contractHome).join(", ") || `(moved/unknown: ${h.name})`}\n  ${h.summary.slice(0, 140).replace(/\s+/g, " ")}`).join("\n")
        : "No matches. (Only summarized files are searchable; for fuzzy queries ask your agent to read `tidybot summary list`.)",
    );
  });

// ---------------------------------------------------------------- plans

const plan = program.command("plan").description("review and edit proposed moves");

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
  .description("change where a file goes (smart folder name or --path) and/or its new name")
  .argument("<file>", "file path (relative to the plan source)")
  .argument("[folder]", "smart folder name")
  .option("--path <dir>", "custom destination directory instead of a smart folder")
  .option("--name <newName>", "rename the file (extension is kept)")
  .option("--keep-name", "cancel a proposed rename")
  .option("-p, --plan <id>", "plan id (default: latest open)")
  .action((file: string, folder: string | undefined, o) => {
    const p = loadPlan(o.plan);
    const item = retarget(p, file, { folder, path: o.path, name: o.keepName ? null : o.name });
    emit({ ok: true, planId: p.id, item }, () =>
      [`${file} → ${contractHome(path.join(item.destination ?? "", item.newName ?? path.basename(item.file)))}`, ...(item.warnings ?? []).map((w) => `⚠ ${w}`)].join(
        "\n",
      ),
    );
  });

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
  .description("move (and rename) the pending files of a plan (default: latest open). Asks for confirmation.")
  .argument("[planId]")
  .option("-n, --dry-run", "show what would move")
  .option("-y, --yes", "don't ask for confirmation (required when not on a TTY)")
  .addOption(
    new Option("--on-conflict <policy>", "if a same-named file exists at the destination").choices(["fail", "rename"]).default("fail"),
  )
  .action(async (id: string | undefined, o) => {
    const p = loadPlan(id);
    const preview = applyPlan(p, { dryRun: true });
    const count = preview.wouldMove?.length ?? 0;
    if (o.dryRun || count === 0) {
      emit({ ok: true, dryRun: true, planId: p.id, wouldMove: preview.wouldMove }, () =>
        count === 0 ? "Nothing pending in this plan." : renderPlan(p),
      );
      return;
    }
    if (!o.yes) {
      if (!process.stdin.isTTY || isJsonMode()) {
        throw new TidyError("Refusing to move files without confirmation. Re-run with --yes once the plan is approved.", "needs_confirmation");
      }
      process.stderr.write(`${renderPlan(p)}\n\n`);
      if (!(await confirm(`Move ${count} file(s)?`))) {
        process.stderr.write("Aborted.\n");
        return;
      }
    }
    const result = applyPlan(p, { onConflict: o.onConflict as ConflictPolicy });
    emit({ ok: result.failed.length === 0, planId: p.id, ...result }, () =>
      [
        `Moved ${result.moved.length} file(s).`,
        ...result.failed.map((f) => `  ✗ ${contractHome(f.file)}: ${f.error}`),
        result.moved.length ? `Undo with: tidybot undo --plan ${p.id}` : "",
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
  .command("forget")
  .description("drop a history entry that can no longer be undone")
  .argument("<ids...>")
  .action((ids: string[]) => {
    const entries = ids.map(forgetMove);
    emit({ ok: true, forgotten: entries }, () => `Forgot ${entries.length} entr${entries.length === 1 ? "y" : "ies"}.`);
  });

// ---------------------------------------------------------------- smart folders

const folders = program.command("folders").description("manage smart folders (name + path + natural-language rule)");

folders
  .command("list", { isDefault: true })
  .description("list smart folders")
  .action(() => {
    const list = loadFolders();
    emit({ scope: scopeLabel(), file: foldersFile(), folders: list }, () =>
      list.length
        ? [`(${scopeLabel()})`, ...list.map((f) => `${f.name}  ${f.path}${f.rule ? `\n    ${f.rule}` : ""}`)].join("\n")
        : "No smart folders. Add one with `tidybot folders add <name> <path> --rule '...'`.",
    );
  });

folders
  .command("add")
  .description("add a smart folder")
  .argument("<name>")
  .argument("<path>")
  .option("-r, --rule <text>", "what belongs in this folder", "")
  .action((name: string, p: string, o) => {
    const f = addFolder({ name, path: p, rule: o.rule });
    emit({ ok: true, scope: scopeLabel(), folder: f }, () => `Added ${f.name} → ${f.path}  (${scopeLabel()})`);
  });

folders
  .command("edit")
  .description("change a smart folder's name, path or rule")
  .argument("<name>")
  .option("--name <new>", "new name")
  .option("--path <dir>", "new path")
  .option("-r, --rule <text>", "new rule")
  .action((name: string, o) => {
    const patch = Object.fromEntries(Object.entries({ name: o.name, path: o.path, rule: o.rule }).filter(([, v]) => v !== undefined));
    const f = updateFolder(name, patch);
    emit({ ok: true, folder: f }, () => `Updated ${f.name} → ${f.path}`);
  });

folders
  .command("rm")
  .description("remove a smart folder (does not touch files on disk)")
  .argument("<name>")
  .action((name: string) => {
    const f = removeFolder(name);
    emit({ ok: true, removed: f }, () => `Removed ${f.name}`);
  });

folders
  .command("import")
  .description("add/update many folders at once from JSON or YAML (e.g. an agent's onboarding proposal)")
  .argument("[file]", "JSON/YAML file, or - for stdin")
  .option("--data <json>", "folders inline")
  .option("--replace", "replace all existing folders instead of merging")
  .option("-n, --dry-run", "validate and show the result without saving")
  .action((file: string | undefined, o) => {
    const r = importFolders(readInput(o, file), { replace: o.replace, dryRun: o.dryRun });
    emit({ ok: true, dryRun: !!o.dryRun, scope: scopeLabel(), ...r }, () =>
      [
        `${o.dryRun ? "Would add" : "Added"} ${r.added.length}, ${o.dryRun ? "would update" : "updated"} ${r.updated.length}. Total: ${r.folders.length}.  (${scopeLabel()})`,
        ...r.added.map((f) => `  + ${f.name}  ${f.path}`),
        ...r.updated.map((f) => `  ~ ${f.name}  ${f.path}`),
      ].join("\n"),
    );
  });

// ---------------------------------------------------------------- rules (naming style + general instructions)

const rules = program.command("rules").description("naming style and general instructions for the agent (beyond per-folder rules)");

rules
  .command("list", { isDefault: true })
  .description("show naming style, rename mode and rules (global and project)")
  .action(() => {
    const c = loadConfig();
    const scopes = loadRules();
    emit({ rename: c.rename, naming: c.naming, rules: c.rules, byScope: scopes }, () =>
      [
        `rename: ${c.rename}`,
        `naming: ${c.naming || "(none — agent uses its default style)"}`,
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
  .description("create per-project settings (.tidybot/) — smart folders and config that apply under this directory")
  .argument("[dir]", "project root", ".")
  .option("--copy-global", "start from a copy of the global smart folders")
  .action((dir: string, o) => {
    const root = resolvePath(dir);
    const target = path.join(root, PROJECT_DIRNAME);
    if (target === tidybotHome()) throw new TidyError("That is the global tidybot home.");
    if (fs.existsSync(target)) throw new TidyError(`${contractHome(target)} already exists.`);
    const initial = o.copyGlobal ? loadFolders(path.join(tidybotHome(), "folders.yaml")) : [];
    saveFolders(initial, path.join(target, "folders.yaml"));
    writeYaml(path.join(target, "config.yaml"), {}, "# Project overrides for tidybot. Unset keys fall back to ~/.tidybot/config.yaml.\n# `rules` here are added to the global rules.");
    emit({ ok: true, project: target, folders: initial.length }, () =>
      `Created ${contractHome(target)} with ${initial.length} smart folder(s).\nCommands run under ${contractHome(root)} now use these settings (override with --global).`,
    );
  });

program
  .command("status")
  .description("active scope, where state lives, smart folder count, open plans")
  .action(() => {
    const open = listPlans().filter((p) => planState(p) === "open");
    const c = loadConfig();
    const data = {
      home: tidybotHome(),
      project: projectDir() ?? null,
      config: c,
      folders: loadFolders().length,
      openPlans: open.map((p) => p.id),
      activeMoves: loadMoves().filter((m) => m.state === "active").length,
    };
    emit(data, () =>
      [
        `home:         ${contractHome(data.home)}`,
        `project:      ${data.project ? contractHome(data.project) : "none (global settings)"}`,
        `source:       ${c.source}`,
        `folders:      ${data.folders}${data.folders === 0 ? "  (run `tidybot guide onboard`)" : ""}`,
        `rename:       ${c.rename}${c.naming ? `  naming: ${c.naming}` : ""}`,
        `rules:        ${c.rules.length}`,
        `open plans:   ${data.openPlans.join(", ") || "none"}`,
        `active moves: ${data.activeMoves}`,
      ].join("\n"),
    );
  });

program.parseAsync().catch(fail);
