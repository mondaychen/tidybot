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
agent:  tidybot scan ~/Downloads --json         → files + excerpts + summaries + folders + rules
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
| `guide [organize\|summarize\|onboard]` | Instructions for the agent: workflow, how to judge, renaming, subagent prompt |
| `scan [dir] [-r] [--include-organized]` | Files with type, excerpt and cached summary, plus smart folders, rules, naming style and rename mode. Files already in smart folders are skipped by default |
| `summary todo [dir] [-r]` | Files that still need a summary |
| `summary save [--data] [--model]` | Stores agent-written summaries: `[{file, summary, keywords[]}]` |
| `summary get <files...>` / `summary list` | Reads summaries back (`list` is for semantic search on the agent side) |
| `propose [--data] [--append] [--allow-unsummarized]` | Saves `{file, folder, rename?, reason, confidence}` choices as a plan. Moves nothing |
| `survey <dirs...>` | Summarizes existing folder trees, for onboarding |
| `folders import [--data] [--dry-run]` | Adds or updates many smart folders at once |

**Human-facing**

| Command | What it does |
|---|---|
| `plan list \| show \| set \| skip \| discard` | Review and edit. `plan set <file> [folder] [--path d] [--name n] [--keep-name]` |
| `apply [plan] [--dry-run] [--yes] [--on-conflict rename]` | Runs moves and renames. Asks for confirmation |
| `history`, `undo <ids> \| --plan \| --last`, `forget <ids>` | Move history and undo |
| `find <words...>` | Searches files by summary, keywords and name |
| `folders list \| add \| edit \| rm` | Smart folders |
| `rules`, `rules add \| rm`, `rules naming [style]` | General rules and naming style for the agent |
| `config get \| set \| unset` | `source`, `excerptChars`, `maxFiles`, `skipOrganized`, `rename` (auto/always/off), `naming` |
| `init [dir] [--copy-global]` | Creates per-project settings (see below) |
| `status` | Active scope, counts, open plans |

Global flags: `--json` (or `TIDYBOT_JSON=1`), `-g/--global`, `--project <dir>`.

## Smart rename

When `rename` is `auto` (the default), the agent proposes a new name only when the current one is
unhelpful or when it would collide with a file already at the destination. `propose` flags collisions
as `warnings` so the agent can fix them before you review. The extension is always kept, and names
are sanitized to a single path segment. Your naming style (`tidybot rules naming "..."`) and general
rules (`tidybot rules add "..."`) are included in every `scan` so the agent follows them.

## Summaries and search

Summaries are cached by **content hash**, so they survive renames and moves, and identical copies
share one summary. Short text files don't need one: their text is cached automatically. Images always
need a summary before they can be proposed, because the excerpt can't say what's in a photo. The agent
is told to delegate summarizing to subagents on a cheap model; see `tidybot guide summarize`.

## Sensitive files

Files that look like they hold credentials are flagged `sensitive` and never excerpted, summarized or
cached. That covers recovery codes, keys, `.env`/`.pem` files, OAuth client secrets, password-manager
emergency kits, and text containing token-like strings. The agent is told to suggest a password manager
for them instead of a folder. `summary save` also rejects summaries that contain secret values.

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
  history.jsonl             # append-only: move / undo / forget
  summaries.jsonl           # append-only: content hash → summary + keywords
  index.json                # path → hash cache (skips rehashing; lets `find` locate files)
<project>/.tidybot/         # optional per-project config.yaml + folders.yaml
```

## Develop

```bash
pnpm test        # vitest
pnpm typecheck
pnpm dev -- scan ~/Downloads
```

See [DECISIONS.md](./DECISIONS.md) for design choices and open questions.
