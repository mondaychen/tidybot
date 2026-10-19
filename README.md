# tidybot

A CLI for sorting a messy directory (like `~/Downloads`) into **places**:
destination directories that each have a natural-language rule. It can also give badly named files
(UUIDs, `scan0001.pdf`, `IMG_1234.jpg`) names based on what's in them, and help you find files later
by content.

tidybot has no model inside it. An AI agent (Claude Code, or any agent that can run shell commands)
does the judging. tidybot gives the agent the facts, caches the agent's file summaries, turns its
decisions into a plan you can review, then does the moves with a full undo history.

```
agent:  tidybot summary todo ~/Downloads        → files that need a summary (images: required)
agent:  (subagents on a cheap model read them)  → tidybot summary save --data '[...]'
agent:  tidybot scan ~/Downloads --json         → compact list: previews/summaries, duplicates, places, rules
agent:  tidybot inspect <files> --json          → full text for the few files the preview didn't settle
agent:  tidybot propose --data '{...}'          → plan with moves and renames (nothing moved yet)
you:    tidybot plan show / plan set / skip     → review and edit
you:    tidybot apply                           → files move, history recorded
you:    tidybot undo --last                     → changed your mind (original names restored)
anyone: tidybot find lease 2025                 → search by summary and keywords
```

## Why not just ask your agent to clean up the folder?

An agent can sort a folder with `ls`, `cat` and `mv`. tidybot makes that work safer, cheaper and
repeatable:

- **You review before anything moves.** The agent writes a plan, not moves. You edit the plan, then
  you run `apply`. With plain shell commands, the agent moves files while it works.
- **You can undo.** Each move goes into a history. `tidybot undo` puts files back and restores their
  original names. A move never overwrites a file, and tidybot recovers interrupted moves. tidybot
  doesn't delete files permanently: they go to the Trash or to a folder that you choose.
- **Your setup stays.** Places, rules and naming style are saved. Each session follows them,
  so you don't explain your places again, and results are the same from one run to the next.
- **It reads files that `cat` can't.** tidybot has built-in readers. They get the text from PDF
  (also PDFs with CJK fonts), DOCX, PPTX and XLSX files, and from text files in UTF-16 or
  Windows-1252. `tidybot preview` makes a small JPEG of a HEIC or WebP image, or of a PDF's first
  page, for agents that can't open those formats.
- **It uses fewer tokens.** `scan` gives one short line per file, so the agent reads full text only
  for the files it can't sort from that line. Summaries are cached by content hash, so the agent
  doesn't read a file again after a rename or move. Cheap subagents write the summaries.
- **It finds duplicates.** tidybot finds identical files by hash, and probable copies by text, name
  or size. An agent that reads one file at a time can't easily see these.
- **It protects secrets.** tidybot doesn't show the agent the content of files that look like
  credentials (keys, `.env` files, recovery codes), and it doesn't cache it.
- **You can easily find files later.** The summaries stay after the cleanup. `tidybot find` searches them.

## Install

```bash
npm install -g tidybot
```

Requires Node 22.22.2+ or 24.15+ (or 26+).

## Get started

After you install tidybot, open your coding agent (Claude Code, or any agent that can run shell
commands) and tell it:

> Run CLI command `tidybot guide` and set up

The agent reads the guide and then helps you set up tidybot. It asks which folders hold your
organized files and which folder you want to clean up. Then it looks at your files and proposes
places. It also asks how to name files, about general rules, and if tidybot can delete files.
It saves only what you approve. After that, you can ask it to tidy a folder, for example
"tidy my Downloads".

## Build from source

```bash
pnpm install
pnpm build
pnpm link --global      # puts `tidybot` on your PATH
# or, without building:  pnpm dev -- <command>
```

## Commands

**Agent-facing**

| Command | What it does |
|---|---|
| `guide [overview\|organize\|summarize\|onboard]` | Instructions for the agent. `overview` (the default) is the entry point: overall workflow and rules. The others cover how to judge, renaming, onboarding and the subagent prompt |
| `scan [dir] [-r] [--older-than 14d] [--offset n] [--full] [--include-hidden] [--include <glob>]` | Compact list of files (type, size, date, summary or short preview, flags: `sensitive`, `duplicate`, `similar`, `needsSummary`, `more`), plus duplicate groups, similar files, places, rules, naming style and rename mode. Skips hidden files, files already in places and, if asked, recent ones. Without `-r`, lists the subfolders it left out (`skippedDirs`). Pages with `nextOffset` |
| `inspect <files...>` | Full excerpt and details for specific files (step 2 after `scan`) |
| `summary todo [dir] [-r]` | Files that still need a summary. Identical copies are listed once |
| `summary save [--data] [--model]` | Stores agent-written summaries: `[{file, summary, keywords[]}]` |
| `summary get <files...>` / `summary list` | Reads summaries back (`list` is for semantic search on the agent side) |
| `propose [--data] [--append] [--allow-unsummarized]` | Saves `{file, place, rename?, reason, confidence}` choices as a plan, or `{file, delete: true, reason}` to delete a file. Moves nothing. `--data -` reads stdin |
| `preview <files...> [--out dir]` | Writes a small JPEG of an image (HEIC, WebP, …) or of a PDF's first page, for agents whose image tools can't open them. Uses `sips` on macOS, ImageMagick elsewhere |
| `survey <dirs...> [--include-hidden] [--include <glob>]` | Summarizes existing folder trees, for onboarding. Skips hidden folders |
| `places import [--data] [--dry-run]` | Adds or updates many places at once |

**Human-facing**

| Command | What it does |
|---|---|
| `plan list \| show \| set \| skip \| discard` | Review and edit. `plan set <files...> [--place p \| --path d \| --delete]`, `plan set <file> --name n` (or `--keep-name`). `plan set <file> <place>` also works |
| `apply [plan] [--dry-run] [--yes] [--on-conflict rename]` | Runs moves, renames and deletions. Asks for confirmation |
| `history`, `undo <ids> \| --plan \| --last`, `forget <ids>` | Move history and undo |
| `recover [--abandon <ids>]` | Finishes or rolls back interrupted moves (also runs automatically). `--abandon` drops one it can't resolve, after you've checked its files |
| `find <words...>` | Searches files by summary, keywords and name |
| `places list \| add \| edit \| rm` | Places |
| `rules`, `rules add \| rm`, `rules naming [style]` | General rules and naming style for the agent |
| `config get \| set \| unset` | `source`, `excerptChars`, `previewChars`, `maxFiles`, `olderThan`, `skipOrganized`, `rename` (auto/always/off), `naming`, `extensionCase` (keep/lower), `historyMaxMoves`, `summariesMax` (0 = unlimited), `allowDelete`, `trashDir`, `maskPersonal` |
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
- `duplicates` lists identical files. That includes copies already filed in a place, as long as
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
| `sensitive add-rule <name> --prefix <text>` or `--regex <pattern>` | Adds your own rule for a secret the built-in rules don't know, such as your company's tokens. Its id is `custom.<name>` | With your OK |
| `sensitive rm-rule <name>` | Removes one of your rules, in the current scope | Only when you ask |

Your own rules are content rules for secret values. A `--prefix` rule matches the prefix followed by 8 or
more letters, digits, `_` or `-`. A `--regex` rule uses JavaScript syntax, is at most 300 characters,
and must not match empty text. Rules are kept in `config.yaml` as `secretRules`, at most 32 per scope.
Project rules are added to the global ones, and a project rule replaces a global rule of the same name.
Never put a whole secret value in a rule.

File exceptions are tied to the file's content hash. If the file changes, it's checked again.
Cached summaries are checked against the current sensitivity rules on every read, including
`find` and `summary list`, so revoking an exception takes effect immediately.

## Personal data

tidybot can mask personal data in what it shows the agent and in the summaries it keeps. The value
is replaced with a label, and the words around it stay, so files still sort as before:

| Kind | Example | Masked |
|---|---|---|
| `ssn` | `SSN: 536-22-1234` | `SSN: [SSN]` |
| `passport` | `Passport No.: 123456789` | `Passport No.: [PASSPORT]` |
| `id-card` | Chinese resident ID number | `[ID CARD]` |
| `card` | `4111 1111 1111 1111` | `[CARD …1111]` |
| `iban` | `DE89 3704 0044 0532 0130 00` | `[IBAN …3000]` |
| `birthday` | `Date of birth: 1990-03-05` | `Date of birth: [DATE OF BIRTH]` |
| `email` | `john.smith@chase.com` | `[EMAIL]@chase.com` |

It's off by default. Turn it on with `config set maskPersonal all`, or name the kinds:
`config set maskPersonal ssn,card,iban`. Numbers must pass their check digit or range check, and passport
numbers and dates of birth count only after the words that name them, so other numbers and dates stay.

Masking covers `scan` and `inspect` excerpts, cached summaries, `find` and `summary list`, including
summaries saved before you turned it on. It doesn't keep personal data from the model completely: a
subagent that summarizes a file opens the file itself.

## Per-project settings (advanced)

`tidybot init` in a directory creates `<dir>/.tidybot/` with its own `places.yaml` and `config.yaml`.
Commands run anywhere under that directory pick it up, the same way git finds its folder.

- The project's places **replace** the global set.
- Project config **overrides** global values key by key, and project `rules` are **added** to the global ones.
- Inside a project, `source` defaults to the project root.
- Plans, history and summaries stay global.
- `--global` ignores the project, and `--project <dir>` picks one explicitly.

## Storage

```
~/.tidybot/                 # global home (override with TIDYBOT_HOME)
  config.yaml               # settings, naming style, rules
  places.yaml               # places — hand-editable
  plans/<id>.json           # one file per plan
  operations/<id>.json      # recovery journals for moves/undos in progress
  move-locks/              # temporary process locks while moving or recovering
  history.jsonl             # append-only: move / undo / forget
  summaries.jsonl           # append-only: content hash → summary + keywords
  index.json                # path → hash cache (skips rehashing; lets `find` locate files)
  allowlist.json            # per-file sensitive-detection exceptions, keyed by content hash
<project>/.tidybot/         # optional per-project config.yaml + places.yaml
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
the idea of destination folders with rules, which tidybot calls places. The code and the history of
`main` are new. The old code is on the [`legacy`](https://github.com/mondaychen/tidybot/tree/legacy) branch.

## License

[Apache 2.0](./LICENSE)
