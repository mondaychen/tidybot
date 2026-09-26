# Design decisions

Source: `~/workspace/file_organizer`. That project has a PRD, a Python/Flask + LangChain prototype
and an Electron app that calls a hosted `podia.ai` API. I kept its core idea and redesigned the
rest for a CLI that an agent drives. Open questions are collected at the end under 🟡.

## What carried over from the original idea

| PRD concept | tidybot |
|---|---|
| Smart folders (name + path + natural-language rule, unique names and paths) | `folders.yaml`, `tidybot folders …`. Names are unique case-insensitively, paths are unique after `~` expansion |
| Analyze files by name, type and content excerpt | `scan` extracts excerpts from txt/md/csv/json/etc., PDF, DOCX, PPTX and XLSX. Unknown extensions are sniffed for text |
| AI suggests exactly one smart folder, never a made-up path | The agent sends folder **names**. Unknown names become `invalid` items and are never moved |
| User reviews and edits suggestions before any move | A plan is a reviewable artifact: `plan show / set / skip`, then `apply` |
| Batch analyze and batch move | One `scan` for many files, one `propose` for many items, `apply` moves all pending items |
| Create destination directories that don't exist | Yes (`mkdir -p`) |
| Operation history with timestamps, undo, "remove failed undo" | `history.jsonl`, `undo`, `forget` |
| Status per file (pending, analyzing, analyzed, failed) | Plan item status: `pending / invalid / skipped / moved / failed`, each with a `note` |
| Conversational onboarding that scans existing dirs and proposes folders | `survey` + `guide onboard` + `folders import --dry-run`. The conversation happens in the agent |
| Persist default directory | `config.yaml` → `source` |

## What I dropped

- **Hosted API, product key, proxy settings.** There's no server anymore, because the agent is the model.
- **Tree view, grid/list/detail view modes, desktop notifications.** These are GUI concerns.
  `scan --recursive` and `survey` cover the useful part of browsing nested directories.
- **Legacy "destinations" list.** It's superseded by smart folders. A folder with an empty rule works the same way.

## Key decisions

1. **No LLM inside tidybot. AI features become agent-callable commands.** *(confirmed)*
   - Classification: `scan` (context in) and `propose` (decisions out).
   - Onboarding: `survey` and `folders import`.
   - Summaries: `summary todo` and `summary save`.
   - `guide` holds the judging instructions, including the few-shot examples from the original `prompt.py`.
   A built-in `classify` that calls a model directly is out for now.

2. **Propose-then-apply, with plans stored on disk.** A plan file lets the agent and the human work at
   different times, lets an interrupted `apply` resume (it's saved after every file), and makes AI
   suggestions auditable.

3. **Confirmation gate on `apply`** *(confirmed)*. On a TTY it asks y/N. With no TTY, or with `--json`,
   it needs `--yes`. The skill tells agents not to pass `--yes` without approval. For a hard block, deny
   `Bash(tidybot apply*)` in the agent's permission settings.

4. **Moves never overwrite.** A collision fails the item unless `--on-conflict rename` is set (which gives
   `file (1).pdf`). The main fix is now smart rename (#12): `propose` detects collisions early. Undo refuses
   to overwrite too. Cross-device moves use copy + unlink.

5. **Storage formats:**
   - YAML for files people edit: `config.yaml`, `folders.yaml`.
   - JSON for machine-rewritten files: `plans/<id>.json`, `index.json`.
   - Append-only JSONL for logs: `history.jsonl`, `summaries.jsonl`. The last record wins.
   - Writes are atomic (temp file + rename). There's no locking, which is fine for a single-user CLI.

6. **Global state with optional per-project settings.** `tidybot init` creates `<dir>/.tidybot/`, which is
   found by walking up from cwd like git. The rules for combining them:
   - Project `folders.yaml` **replaces** the global folders. Merging two folder sets would make "which
     folders apply here" hard to reason about. Use `init --copy-global` to start from the global set.
   - Project `config.yaml` overrides global values key by key. `rules` are **added** to the global list,
     since global rules like "never move drafts" should still apply.
   - Inside a project, `source` defaults to the project root.
   - Writes (`folders add`, `config set`, `rules add`) go to the project when one is active. `-g` forces global.
   - Plans, history, summaries and the index stay **global**. A move is a move wherever you ran it from,
     and a content hash means the same thing everywhere.
   - `~/.tidybot` is never mistaken for a project, even when `TIDYBOT_HOME` points somewhere else.

7. **Output is human-readable by default and JSON with `--json`** *(confirmed)*. JSON errors look like
   `{ok:false, error:{code,message}}` with exit code 1.

8. **Files are identified by path relative to the plan's `source`.** Absolute paths are stored internally.

9. **Content extraction:**
   - `unpdf` for PDF, and `jszip` plus light XML parsing for DOCX/PPTX/XLSX.
   - Excerpts are capped by `excerptChars` (default 1000).
   - Legacy `.doc/.xls/.ppt` are out of scope *(confirmed)*.
   - The extractor reports `complete: true` when the excerpt is the whole file, which drives the
     "short files need no summary" logic.

10. **`propose --append`** merges proposals into an open plan, and later proposals replace earlier ones for
    the same file. It's used for batching large directories and for fixing conflicts. Moved items are
    never rewritten.

11. **Undo doesn't reopen the plan.** Items keep status `moved` as a record, and history shows them as `undone`.

12. **Smart rename.**
    - A proposal can carry `rename` (a filename only). tidybot sanitizes it:
      - It rejects `/`, `\` and NUL.
      - It replaces `<>:"|?*` and control characters with `-`, and strips leading dots.
      - It caps names at 200 characters.
      - It **re-adds the original extension** if the agent dropped or changed it (compared case-insensitively),
        so a rename can never change a file's type.
    - `folder: null` together with `rename` means rename in place.
    - `rename` mode in config:
      - `auto` (default): rename only unhelpful names and conflicts.
      - `always`: rename every file using the naming style.
      - `off`: renames are dropped, with a warning on the item.
    - Undo restores the original name, because history stores full paths.
    - Conflict detection at propose time covers both "file exists at destination" and "two items target
      the same path" (common with `-r`, which flattens `a/x.pdf` and `b/x.pdf` into one folder). These
      are **warnings** rather than errors, so you can still accept them and use `--on-conflict rename`.
      I made this call because blocking seemed too strict.

13. **Rules beyond smart folders.** `config.yaml` now holds `naming` (a free-text style guide) and
    `rules` (a list of free-text instructions). Both are returned by every `scan`, so the agent always
    sees them. Onboarding tells the agent to ask for both. Managed with `tidybot rules …`.

14. **Recursive scans skip organized files.** With `-r`, tidybot doesn't descend into any smart folder
    below the scan root (default `skipOrganized: true`; `--include-organized` turns it off). If you scan a
    smart folder itself, it isn't skipped, because you asked for it explicitly. `survey` marks directories
    that are smart folders.

15. **File summaries, driven by the agent and cached by content hash.**
    - **Key**: `sha256` of the whole file. Files over 64 MiB get a `quick:` hash of size + first/last 4 MiB,
      so scanning a folder of videos stays fast. That could collide on large files that differ only in the
      middle; I accepted that for a cache.
    - **Index** (`index.json`): path → {hash, size, mtime}. Files aren't rehashed unless size or mtime
      change. It's updated on scan, summary save, apply and undo, which is how `find` knows where a file
      lives *now*. Files moved outside tidybot drop out of `find` until the next scan sees them;
      `summary prune` cleans up stale paths.
    - **When a summary is needed**:
      - Images: **required**. `propose` marks unsummarized images `invalid` unless you pass `--allow-unsummarized`.
      - Documents longer than the excerpt: **recommended**.
      - Short text: never. Its text is auto-cached as a `source: content` summary so `find` covers it.
      - Archives, video, audio and other non-text files: not flagged, since there's nothing for a model to read.
    - **Delegation**: `guide summarize` tells the agent to use subagents on a cheap/fast model or at low
      effort, with batches of about 5–10 files, and includes a subagent prompt. tidybot hashes files
      itself; it doesn't trust hashes from the agent.
    - **Search**: `find` does simple keyword scoring (keyword match 3, name 2, summary text 1). Fuzzy or
      semantic lookups are left to the agent via `summary list`.

16. **Sensitive files (found in an external review against a real Downloads folder).** Short files used to
    have their full text cached as a summary. That stored recovery codes, an OAuth `client_secret` and a
    password-manager Emergency Kit in plain text in `summaries.jsonl`, and showed them to the agent.
    - `extractExcerpt` now flags likely secrets, and the check lives there so no caller can bypass it.
      There are two checks:
      - **By name/extension**: recovery or backup codes, emergency kit, secret, password, credential,
        private key, seed phrase, 2FA, API key or token, `.env`, `.pem`, `.key`, `.p12`, `.kdbx`, and so on.
        Files that match by name are never opened.
      - **By content**, over all the text read, not just the excerpt: private keys, AWS/GitHub/Slack/Stripe/
        Google/`sk-` keys, `client_secret`, JWTs, 1Password secret keys, `password=…` assignments, and lists
        of one-time codes.
    - For sensitive files: no excerpt, no cached summary, no `needsSummary`, a `sensitive: "<reason>"` field,
      and a count in the `scan` output. The organize guide tells the agent not to open them and to suggest a
      password manager. Sensitive images are exempt from the "images need a summary" rule.
    - `summary save` rejects summaries whose text contains a secret *value*. Describing one ("GitHub recovery
      codes") is fine. The subagent prompt says the same.
    - **I chose to lean towards flagging too much.** A false positive only costs the excerpt. The agent still
      sees the name, type and size. `token` in a filename counts as sensitive, for example.

17. **Bounded memory.** Extraction used to `readFile` every file. That meant 1.2 GB of RAM in the review,
    and outright failure on files over 2 GB.
    - Known binary types (installers, archives, media, images, fonts, databases) are never opened.
    - Text sniffing reads only the head of the file: `max(8 KB, 4 × excerptChars)` bytes.
    - PDF and Office files over 50 MB are skipped. PDFs are parsed for at most the first 5 pages.
    - Concurrency dropped from 8 to 4.
    - Measured: a scan over 3 GB of files (six 300 MB `.dmg` files and a 1.2 GB unknown-type file) peaks
      at 107 MB RSS and takes 0.2 s.

18. **Filename limits and macOS semantics.**
    - Names are capped at **255 bytes**, measured on the NFD form. HFS+ decomposes accents, so this is the
      worst case. Names are truncated on grapheme boundaries, so emoji and accents never get split, and
      stored in NFC. A 180-character Chinese name used to pass `propose` and then fail at `apply`; now it's
      shortened at propose time.
    - Conflict keys are lowercased and NFC-normalized, so `X.pdf` and `x.pdf` in one plan get a warning.
      This applies on Linux too, where it only costs an extra warning.
    - `exists()` hits on the item's own file (same device + inode) aren't treated as conflicts. A case-only
      rename goes through a temporary name. Both are tested on the real case-insensitive APFS volume.
    - `--on-conflict rename` suffixes also respect the byte limit.
    - Copies across drives keep the modified time.

19. **Smaller fixes.**
    - `plan set x.txt` errors when the name matches more than one file, instead of picking one.
    - Each plan records `context` (rename mode, naming style, rules and folders in effect at the latest
      `propose`). This answers open question 4 from the previous round.

## 🟡 Open questions

1. **Is `find` enough?** Keyword scoring plus agent-side semantic search over `summary list` works
   for hundreds or low thousands of files. Past that, `summary list` gets too big for an agent's context.
   Options: add `--since`, `--folder` or `--type` filters, or store embeddings (which would need a model,
   and so contradicts decision #1). I'd wait until it hurts.
2. **Summaries are global, not per-project.** For work and personal files on one machine, would you
   want them kept apart, for example for privacy when sharing a project's `.tidybot`? Nothing sensitive is
   stored in the project directory today.
3. **Summarizing files that aren't being organized.** `summary todo` works on any directory, so you could
   index `~/Documents` just for `find`. Should onboarding offer that? It's cheap on a small model, but
   it's a lot of files.
4. **Existing summaries from before the secrets fix.** Nobody has a real `~/.tidybot` yet (I checked this
   machine), so I didn't write a migration. If you ran an earlier build against real files, delete
   `~/.tidybot/summaries.jsonl`.
5. **Name.** It's `tidybot` for now (the original was "Podia File Organizer"). There's no license or npm scope yet.
