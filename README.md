# tidybot

A CLI for sorting a messy directory (like `~/Downloads`) into **smart folders**:
destination directories that each have a natural-language rule. It can also give badly named files
(UUIDs, `scan0001.pdf`, `IMG_1234.jpg`) names based on what's in them, and help you find files later
by content.

tidybot has no model inside it. An AI agent (Claude Code, or any agent that can run shell commands)
does the judging. tidybot gives the agent the facts, caches the agent's file summaries, turns its
decisions into a plan you can review, then does the moves with a full undo history.

```
agent:  tidybot summary todo ~/Downloads        → files that need a summary (images: required)
agent:  (subagents on a cheap model read them)  → tidybot summary save --data '[...]'
agent:  tidybot scan ~/Downloads --json         → compact list: previews/summaries, duplicates, folders, rules
agent:  tidybot inspect <files> --json          → full text for the few files the preview didn't settle
agent:  tidybot propose --data '{...}'          → plan with moves and renames (nothing moved yet)
you:    tidybot plan show / plan set / skip     → review and edit
you:    tidybot apply                           → files move, history recorded
you:    tidybot undo --last                     → changed your mind (original names restored)
anyone: tidybot find lease 2025                 → search by summary and keywords
```

## Install

```bash
pnpm install
pnpm build
pnpm link --global      # puts `tidybot` on your PATH
# or, without building:  pnpm dev -- <command>
```

Requires Node 20+.

## Commands

**Agent-facing**

| Command | What it does |
|---|---|
| `guide [overview\|organize\|summarize\|onboard]` | Instructions for the agent. `overview` (the default) is the entry point: overall workflow and rules. The others cover how to judge, renaming, onboarding and the subagent prompt |
| `scan [dir] [-r] [--older-than 14d] [--offset n] [--full] [--include-hidden] [--include <glob>]` | Compact list of files (type, size, date, summary or short preview, flags: `sensitive`, `duplicate`, `similar`, `needsSummary`, `more`), plus duplicate groups, similar files, smart folders, rules, naming style and rename mode. Skips hidden files, files already in smart folders and, if asked, recent ones. Without `-r`, lists the subfolders it left out (`skippedDirs`). Pages with `nextOffset` |
| `inspect <files...>` | Full excerpt and details for specific files (step 2 after `scan`) |
| `summary todo [dir] [-r]` | Files that still need a summary. Identical copies are listed once |
| `summary save [--data] [--model]` | Stores agent-written summaries: `[{file, summary, keywords[]}]` |
| `summary get <files...>` / `summary list` | Reads summaries back (`list` is for semantic search on the agent side) |
| `propose [--data] [--append] [--allow-unsummarized]` | Saves `{file, folder, rename?, reason, confidence}` choices as a plan, or `{file, delete: true, reason}` to delete a file. Moves nothing. `--data -` reads stdin |
| `preview <files...> [--out dir]` | Writes a small JPEG of an image (HEIC, WebP, …) or of a PDF's first page, for agents whose image tools can't open them. Uses `sips` on macOS, ImageMagick elsewhere |
| `survey <dirs...> [--include-hidden] [--include <glob>]` | Summarizes existing folder trees, for onboarding. Skips hidden folders |
| `folders import [--data] [--dry-run]` | Adds or updates many smart folders at once |

**Human-facing**

| Command | What it does |
|---|---|
| `plan list \| show \| set \| skip \| discard` | Review and edit. `plan set <files...> [--folder f \| --path d \| --delete]`, `plan set <file> --name n` (or `--keep-name`). `plan set <file> <folder>` also works |
| `apply [plan] [--dry-run] [--yes] [--on-conflict rename]` | Runs moves, renames and deletions. Asks for confirmation |
| `history`, `undo <ids> \| --plan \| --last`, `forget <ids>` | Move history and undo |
| `recover [--abandon <ids>]` | Finishes or rolls back interrupted moves (also runs automatically). `--abandon` drops one it can't resolve, after you've checked its files |
| `find <words...>` | Searches files by summary, keywords and name |
| `folders list \| add \| edit \| rm` | Smart folders |
| `rules`, `rules add \| rm`, `rules naming [style]` | General rules and naming style for the agent |
| `config get \| set \| unset` | `source`, `excerptChars`, `previewChars`, `maxFiles`, `olderThan`, `skipOrganized`, `rename` (auto/always/off), `naming`, `extensionCase` (keep/lower), `historyMaxMoves`, `summariesMax` (0 = unlimited), `allowDelete`, `trashDir` |
| `compact` | Applies `historyMaxMoves` / `summariesMax` now and drops superseded summaries (also runs automatically after writes) |
| `init [dir] [--copy-global]` | Creates per-project settings (see below) |
| `status` | Active scope, counts, open plans, moves you can undo |

Global flags: `--json` (or `TIDYBOT_JSON=1`), `-g/--global`, `--project <dir>`.

## Smart rename

When `rename` is `auto` (the default), the agent proposes a new name only when the current one is
unhelpful or when it would collide with a file already at the destination. `propose` flags collisions
as `warnings` so the agent can fix them before you review. Each warning says whether the two files are
identical (then one can be deleted instead) or different. The extension is always kept, and names
are sanitized to a single path segment. `config set extensionCase lower` makes the extension of a
renamed file lowercase (`.HEIC` → `.heic`). Your naming style (`tidybot rules naming "..."`) and general
rules (`tidybot rules add "..."`) are included in every `scan` so the agent follows them.

## Deleting

The agent can propose deleting files, such as the extra copies of a duplicate or files your rules say
to delete. Nothing is deleted until you approve the plan, and nothing is deleted outright:

- By default deleted files go to the **system Trash / Recycle Bin**. Restore them from there; tidybot
  can't undo that.
- `config set trashDir <dir>` sends them to a folder of your choice instead, with an ordinary move that
  `tidybot undo` can reverse. Scans never list that folder.
- On **Linux**, deleting is off until you set `trashDir`.
- `config set allowDelete false` turns deleting off.

## Scanning big folders

`scan` is built to use as little of the agent's context as possible. By default each file gets one
compact line: a cached summary or a 160-character preview, plus flags. The agent calls `inspect` only
for files it can't classify from that. On 336 files, the compact output is about 4× smaller than
`--full`. Big folders page through with `--offset`.

- `--older-than 14d`, or `config set olderThan 14d`, leaves files you're still using out of the plan.
  "Recent" means created *or* modified within the window.
- `duplicates` lists identical files. That includes copies already filed in a smart folder, as long as
  tidybot has seen that copy before (scanned, summarized, or moved after a scan).
- `similar` lists probable copies that aren't identical: the same extracted text, the same name apart
  from ` (1)`, ` copy` or `-2`, or the same type and exact size. The agent checks them; it proposes
  deleting one only if your rules say so or you agree.
- `extractedArchives` lists archives next to the folder they were extracted into (`export.zip` and `export/`).

## Summaries and search

Summaries are cached by **content hash**, so they survive renames and moves, and identical copies
share one summary. Short text files don't need one: their text is cached automatically. Images always
need a summary before they can be proposed, because the excerpt can't say what's in a photo. The one
exception: if the filename already says what the image is, the agent can propose it with a
`summarySkipped` reason, which you'll see in the plan. The agent
is told to delegate summarizing to subagents on a cheap model; see `tidybot guide summarize`.

## Sensitive files

Files that look like they hold credentials are flagged `sensitive` and never excerpted, summarized or
cached. That covers recovery codes, keys, `.env`/`.pem` files, OAuth client secrets, password-manager
emergency kits, and text containing token-like strings. The agent is told to suggest a password manager
for them instead of a folder. `summary save` also rejects summaries that contain secret values.

Every rule has an ID (`tidybot sensitive rules`), and false positives can be allowed:

| Command | Effect | Who |
|---|---|---|
| `sensitive allow <files> --reason "…"` | Waives the **filename** rules for these files. Content is still checked | The agent may do this on its own, for clearly harmless names |
| `sensitive allow <files> --reason "…" --content` | Waives **all** rules for these files | Only with your OK |
| `sensitive allow-rule <id>` / `disallow-rule <id>` | Turns a rule off or on, in the current scope | Only when you ask |
| `sensitive list` / `revoke <file\|hash>` | Reviews or removes exceptions | You |

File exceptions are tied to the file's content hash. If the file changes, it's checked again.
Cached summaries are checked against the current sensitivity rules on every read, including
`find` and `summary list`, so revoking an exception takes effect immediately.

## Per-project settings (advanced)

`tidybot init` in a directory creates `<dir>/.tidybot/` with its own `folders.yaml` and `config.yaml`.
Commands run anywhere under that directory pick it up, the same way git finds its folder.

- The project's smart folders **replace** the global set.
- Project config **overrides** global values key by key, and project `rules` are **added** to the global ones.
- Inside a project, `source` defaults to the project root.
- Plans, history and summaries stay global.
- `--global` ignores the project, and `--project <dir>` picks one explicitly.

## Storage

```
~/.tidybot/                 # global home (override with TIDYBOT_HOME)
  config.yaml               # settings, naming style, rules
  folders.yaml              # smart folders — hand-editable
  plans/<id>.json           # one file per plan
  operations/<id>.json      # recovery journals for moves/undos in progress
  move-locks/              # temporary process locks while moving or recovering
  history.jsonl             # append-only: move / undo / forget
  summaries.jsonl           # append-only: content hash → summary + keywords
  index.json                # path → hash cache (skips rehashing; lets `find` locate files)
  allowlist.json            # per-file sensitive-detection exceptions, keyed by content hash
<project>/.tidybot/         # optional per-project config.yaml + folders.yaml
```

Moves and undo use exclusive destination creation to prevent overwrites, including races with
other writers. On filesystems without hard links (exFAT, FAT, some network shares) they fall back to
rename after checking that the destination is free. Interrupted operations are reconciled at the next
command: a completed move is recorded, or an incomplete move is rolled back. If files have changed and
recovery is ambiguous, tidybot preserves them and reports the recovery journal's path. Until you run
`tidybot recover --abandon <id>`, only moves and undo are blocked. Discarded plans cannot be applied.

## Develop

```bash
pnpm test        # vitest
pnpm typecheck
pnpm dev -- scan ~/Downloads
```

See [DECISIONS.md](./DECISIONS.md) for design choices and open questions.

## History

This repo was `file_organizer` before. That project (2023) was a Python/Flask + LangChain
prototype with a Next.js web UI. It sent file names, types and content to GPT or Claude, and the
model selected the destination folder for each file.

tidybot is a full rewrite of that project as a TypeScript CLI that an AI agent operates. It keeps
the smart-folder idea. The code and the history of `main` are new. The old code is on the
[`legacy`](https://github.com/mondaychen/tidybot/tree/legacy) branch.

## License

[Apache 2.0](./LICENSE)
