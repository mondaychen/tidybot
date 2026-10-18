# Design decisions

Source: the old `file_organizer` project. Its 2023 Python/Flask + LangChain prototype is on the
[`legacy`](https://github.com/mondaychen/tidybot/tree/legacy) branch. I kept its core idea and
redesigned the rest for a CLI that an agent drives. Open questions are collected at the end under 🟡.

## What carried over from the original idea

| Original concept | tidybot |
|---|---|
| A list of destination folders in the config | Smart folders: `folders.yaml`, `tidybot folders …`. Each folder has a name, a path and a natural-language rule. Names are unique case-insensitively, paths are unique after `~` expansion. A folder with an empty rule works like an old destination |
| Analyze files by name, type and content excerpt | `scan` extracts excerpts from txt/md/csv/json/etc., PDF, DOCX, PPTX and XLSX. Unknown extensions are sniffed for text |
| The model selects exactly one destination, never a made-up path | The agent sends folder **names**. Unknown names become `invalid` items and are never moved |
| User reviews suggestions before any move | A plan is a reviewable artifact: `plan show / set / skip`, then `apply` |
| Batch analyze and batch move | One `scan` for many files, one `propose` for many items, `apply` moves all pending items |
| Create destination directories that don't exist | Yes (`mkdir -p`) |
| Status per file (pending, analyzing, analyzed, failed) | Plan item status: `pending / invalid / skipped / moved / failed`, each with a `note` |
| Default source directory in the config | `config.yaml` → `source` |

## What I dropped

- **API keys and the Flask server.** tidybot calls no model, because the agent is the model.
- **The web UI.** tidybot is a CLI. `scan --recursive` and `survey` cover the useful part of browsing
  nested directories.

## Key decisions

1. **No LLM inside tidybot. AI features become agent-callable commands.** *(confirmed)*
   - Classification: `scan` (context in) and `propose` (decisions out).
   - Onboarding: `survey` and `folders import`.
   - Summaries: `summary todo` and `summary save`.
   - `guide` holds the judging instructions, including the few-shot examples from the original `prompt.py`.
   A built-in `classify` that calls a model directly is out for now.

2. **Propose-then-apply, with plans stored on disk.** A plan file lets the agent and the human work at
   different times and makes AI suggestions auditable. A per-operation recovery journal is persisted
   before moving, and history is appended after every file. The index and plan are saved once per batch;
   journals are retired only after that, so recovery replays an interrupted batch. Discarded plans cannot
   be applied or previewed.

3. **Confirmation gate on `apply`** *(confirmed)*. On a TTY it asks y/N. With no TTY, or with `--json`,
   it needs `--yes`. `tidybot guide` tells agents not to pass `--yes` without approval. For a hard block, deny
   `Bash(tidybot apply*)` in the agent's permission settings.

4. **Moves never overwrite.** A collision fails the item unless `--on-conflict rename` is set (which gives
   `file (1).pdf`). The main fix is now smart rename (#12): `propose` detects collisions early. Undo refuses
   to overwrite too. Destinations are created with exclusive hard links, so a concurrent writer cannot
   be overwritten between an existence check and a rename. Cross-device moves copy to a private staging
   file, preserve modification time, link it into place exclusively, then unlink the source.
   - Filesystems without hard links (exFAT, FAT, some network shares, Linux `protected_hardlinks`) fall back
     to rename after checking that the destination is free. Node has no no-replace rename, so another
     writer could still be overwritten in the moment between the check and the rename.
   - `utimes` can't set nanoseconds, so a cross-device copy's modification time can differ from the
     original below the microsecond. The index carries a moved file's hash over when the source matched its
     entry, and records the destination's actual timestamp.

5. **Storage formats:**
   - YAML for files people edit: `config.yaml`, `folders.yaml`.
   - JSON for machine-rewritten files: `plans/<id>.json`, `index.json`.
   - Append-only JSONL for logs: `history.jsonl`, `summaries.jsonl`. The last record wins.
   - Retention is capped by record count, not bytes or lines: `historyMaxMoves` keeps the newest N moves
     plus their undo/forget records (a raw line cut could orphan an undo), and `summariesMax` keeps the N
     most recently written summaries. Both default to 0 (unlimited). They're enforced after each write
     (apply, undo, forget, summary save, scan) and by `tidybot compact`. Superseded summary records are
     always dropped when summaries are written. Dropped moves can't be undone.
   - Rewritten files use temp file + flush + rename (`write-file-atomic`), and are always written mode 0600. Moves, undo, recovery, `forget` and `compact` share a
     process lock, because they all write `history.jsonl`. Other stores still assume one writer; atomic
     replacement alone does not prevent lost updates.
   - Only `move-locks/<pid>-<uuid>.lock` files count as claims (not Finder's `.DS_Store`). A claim is
     stale once its process has exited, or when its PID belongs to a process that started after the claim
     was made (the PID was reused after a crash or reboot). The error names the lock file.
   - `operations/<id>.json` records each move/undo before removing its source. CLI startup reconciles
     interrupted operations, repairs an interrupted final history append, and updates history, plans
     and the index. It skips journals while another process holds the lock, since they are in use.
   - Recovery decides what the operation created by inode, or by size and mtime for files renamed on FAT,
     which may renumber them. Size and mtime never stand in for the original otherwise: a different file
     renamed into the old name could match them, and treating it as the original would unlink the moved file. It refuses ambiguous filesystem changes and retains the journal. That only
     blocks moves and undo; other commands print a warning. Once the user has checked the files,
     `tidybot recover --abandon <id>` drops the journal without touching them.

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
   - `unpdf` for PDF, and `fflate` plus light XML parsing for DOCX/PPTX/XLSX. Only the archive entries that
     are read get decompressed.
   - Text files are read as UTF-8, or as UTF-16 when they start with a byte-order mark (Excel and Windows
     exports). Other text that isn't valid UTF-8 is read as Windows-1252, a superset of Latin-1. Data with
     NUL bytes or control characters other than tab, newline, form feed and carriage return is binary.
   - File types come from mime-db (the `mime` package), with overrides for installers (`.dmg`, `.pkg`,
     `.exe`, `.msi`, `.deb`) and for YAML (`application/yaml`). mime-db gives some extensions a binary
     format that are as often text: `.ts` and `.mts` (MPEG transport stream, or TypeScript) and `.pub`
     (Microsoft Publisher, or an SSH public key). For those, the first 4 KB decide: text by the same test
     as extraction gets `text/typescript` or `text/plain`; anything else, or an unreadable file, keeps
     mime-db's type.
   - PDFs in non-embedded CJK fonts extract as nothing without pdf.js's CMaps, which unpdf doesn't bundle. The
     build copies them (about 1.6 MB) from `pdfjs-dist`, a dev dependency pinned to unpdf's pdf.js version.
     It also copies the standard fonts (about 0.8 MB) for PDFs that use a non-embedded Dingbats, Symbol or
     other base font. Both are given to pdf.js as directory paths: unpdf's default is a `file:` URL, which
     pdf.js can't read under Node. pdf.js warnings are off (`verbosity: 0`), because it prints them to the
     console for every broken font.
   - Excerpts are capped by `excerptChars` (default 1000).
   - Legacy `.doc/.xls/.ppt` are out of scope *(confirmed)*.
   - The extractor reports `complete: true` when the excerpt is the whole file, which drives the
     "short files need no summary" logic.
   - XLSX sheet names and shared strings are only a preview: worksheet cells are omitted, so this
     extraction is always incomplete. Old automatically cached XLSX previews are ignored.

10. **`propose --append`** merges proposals into an open plan, and later proposals replace earlier ones for
    the same file. It's used for batching large directories and for fixing conflicts. Moved items are
    never rewritten.

11. **Undo doesn't reopen the plan.** Items keep status `moved` as a record, and history shows them as `undone`.

12. **Smart rename.**
    - A proposal can carry `rename` (a filename only). tidybot sanitizes it:
      - It rejects `/`, `\` and NUL.
      - It replaces `<>:"|?*` and control characters with `-`, collapses runs of whitespace, strips
        leading dots, and strips trailing dots and spaces.
      - It caps names at 255 bytes, truncating on grapheme boundaries (see #18 for how bytes are counted).
      - It **re-adds the original extension** if the agent dropped or changed it (compared case-insensitively),
        so a rename can never change a file's type.
      - A name that comes out the same as the current one, or empty, means no rename.
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
      middle; I accepted that for a cache. Duplicate candidates with sampled hashes are verified by
      streaming the entire file before being reported as identical, including indexed copies elsewhere.
      The index caches that verified hash while size and mtime are unchanged, so each copy is read once.
    - **Index** (`index.json`): path → {hash, size, mtime}. Files aren't rehashed unless size or mtime
      change. It's updated on scan, summary save, apply and undo, which is how `find` knows where a file
      lives *now*. Files moved outside tidybot drop out of `find` until the next scan sees them;
      `summary prune` cleans up stale paths.
    - **When a summary is needed**:
      - Images: **required**. `propose` marks unsummarized images `invalid` unless you pass `--allow-unsummarized`.
      - Documents longer than the excerpt: **recommended**.
      - PDF/Office documents with no text, such as scans: **recommended**, since only viewing them tells what they are.
      - Short text: never. Its text is auto-cached as a `source: content` summary so `find` covers it.
      - Archives, video, audio and other non-text files: not flagged, since there's nothing for a model to read.
    - **Delegation**: `guide summarize` tells the agent to use subagents on a cheap/fast model or at low
      effort, with batches of about 5–10 files, and includes a subagent prompt. tidybot hashes files
      itself; it doesn't trust hashes from the agent. A batch is all-or-nothing: if any item is refused
      (a missing file, a secret value), none of it is saved, so a corrected retry doesn't duplicate records.
    - **Search**: `find` ranks matches with MiniSearch (BM25), boosting keywords ×3 and the filename ×2
      over summary text. Words match by prefix (`invo` finds `invoice`) and tolerate small typos. Text is
      split into words with `Intl.Segmenter`, so Chinese and Japanese summaries are searchable by word.
      Semantic lookups are left to the agent via `summary list`.

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
        of one-time codes. After these, secretlint's maintained recommended rules run as one more rule,
        `content.secretlint`, covering cloud, SaaS and database credentials (npm, GitLab, OpenAI,
        connection strings with passwords, and others). Its `filter-comments` rule is left out, so a
        `secretlint-disable` comment in a file can't switch detection off. The reason names the
        secretlint rule (`secret value (npm)`) but never its message, which quotes the secret.
    - For sensitive files: no excerpt, no cached summary, no `needsSummary`, a `sensitive: "<reason>"` field,
      and a count in the `scan` output. The organize guide tells the agent not to open them and to suggest a
      password manager. Sensitive images are exempt from the "images need a summary" rule.
    - `summary save` rejects summaries whose text contains a secret *value*. Describing one ("GitHub recovery
      codes") is fine. The subagent prompt says the same.
    - Cached reads re-check the current sensitivity policy, so an old content allowance or disabled rule
      cannot expose cached secret values after it is revoked, even with `--include-missing`.
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

20. **Two-step scan** *(requested)*. `scan` now returns a compact view by default: `rel`, type, size, date,
    and either a summary or a `previewChars` (160) preview, plus flags (`more`, `needsSummary`,
    `sensitive`, `duplicate`). Absolute paths and long excerpts are gone.
    - `inspect <files>` returns full details for only the files the agent is unsure about. `--full`
      keeps the old output.
    - Paging replaces the hard cap: `--offset`, and `nextOffset` in the output. The default page size
      went from 200 to 500 files.
    - Excerpts are still *read* up to `excerptChars` during `scan`, because that's how sensitive,
      complete and needsSummary get decided. Only the output is smaller.
    - On 336 files: 116 KB compact against 461 KB full. That's about 340 bytes per file, mostly the preview.
      `previewChars 80` would roughly halve it. I kept 160 because a shorter preview means more `inspect` calls.

21. **Duplicates** *(requested)*. `scan` groups scanned files by content hash, ignoring empty files. It
    also lists identical files the index knows about elsewhere, for example a copy already filed in a
    smart folder. The limit is that "elsewhere" only covers files tidybot has hashed. A smart folder that
    has never been scanned won't show up; running `scan -r --include-organized` once over the smart
    folders fills that in. The agent can propose deleting the extra copies, keeping the one already
    filed (#26).

22. **`--older-than` / `olderThan`** *(requested)*. A file counts as recent if it was created **or**
    modified within the window (`max(mtime, birthtime)`). Birth time catches downloads whose modified date
    was set to the server's old timestamp. Units are `h d w m y`, where `m` is 30 days. The result includes
    `skippedRecent`. `--any-age` overrides the config value.

23. **Skipping the summary for an image** *(requested)*. A proposal item can include
    `summarySkipped: "<reason>"` for an image whose filename already says what it is. The plan shows
    `[no summary: <reason>]` so you can check it during review. Images without a summary and without a
    reason are still rejected.

24. **Allowing sensitive-detection false positives** *(requested)*. Every rule has a stable ID
    (`name.tokens`, `content.assignment`, …), and `scan` reports `sensitiveRule` next to `sensitive`.
    - **Per-file, keyed by content hash** (`allowlist.json`). If the file changes, the exception stops
      applying and the file is checked again. A path-keyed allowlist would keep trusting a file after
      someone pasted a key into it.
    - **Two levels.** By default an allowance only waives the *filename* rules, and content is still checked.
      That covers the noisy cases (`design-tokens.json`, `secret-santa.xlsx`) and is safe for the agent to do
      on its own. If the content also matches a rule, `allow` refuses and names the rule. Waiving content rules
      needs `--content`, and the guide says to get the user's OK first.
    - **Batches are all-or-nothing.** If any file in an `allow` call is refused, nothing is saved.
      A `--reason` is required and shown in `sensitive list`.
    - **Rule-wide:** `allow-rule` / `disallow-rule` edit `allowRules` in config, in the current scope, combined
      across global and project like `rules`. Any rule can be turned off, even high-confidence ones like
      `content.private-key`, because it's your machine. The guide says to do it only when the user asks.
    - **Limitation:** "ask the user first" is a soft rule for the agent. `--content` and `allow-rule` aren't
      technically gated. If you want a hard gate, deny `Bash(tidybot sensitive allow-rule*)` and
      `Bash(tidybot sensitive allow*--content*)` in the agent's permissions, the same way as for `apply`.

25. **Hidden files** *(requested)*. `scan`, `summary todo` and `survey` leave out what the OS file browser hides:
    - **Everywhere:** names starting with a dot.
    - **macOS:** the hidden flag (`chflags hidden`), which is how `~/Library` is hidden. Node's `fs.Stats`
      doesn't expose file flags and no maintained package reads them, so tidybot runs
      `/usr/bin/find <dir> -maxdepth 1 -flags +hidden` once per directory (0.34 s for a recursive scan of a
      real Downloads folder). The full path avoids GNU find, which has no `-flags`. Finder's older
      "invisible" bit in `com.apple.FinderInfo` is rarely set now and isn't checked.
    - **Windows:** the hidden **or system** attribute, since Explorer hides both by default. They're read with
      `fswin`, an optional dependency with prebuilt binaries, one call per directory. If it can't load, only
      dotfiles count. Not tested on Windows yet.
    - **Linux:** names listed in a directory's `.hidden` file, which GNOME Files and KDE Dolphin honor.
    - `--include-hidden` lists everything. `--include <glob>` (repeatable) lists specific hidden entries: a
      glob without a slash matches names, one with a slash matches the path relative to the scanned
      directory. A matched hidden folder is walked, but hidden entries inside it need their own match.
    - Never listed, even with `--include-hidden`: tidybot's own `.tidybot/` and `.tidybot-move-*` staging
      folders, and folder metadata (`.DS_Store`, `.localized`, `Thumbs.db`, `desktop.ini`). Moving those is
      pointless or breaks a folder's view settings.
    - `scan` reports `skippedHidden`: hidden entries that would otherwise have been listed or walked into.
      A directory the user can't read (such as `~/.Trash` without Full Disk Access) is skipped and listed
      in `unreadable`, instead of failing the scan.
    - The scan root itself is never checked: scanning a hidden folder by name means you asked for it.
    - `survey` no longer special-cases a folder named `Library`; on macOS it's hidden anyway.

26. **Deleting files** *(requested)*. The agent can propose `{file, delete: true, reason}`, for extra copies
    of duplicates or files the user's rules say to delete. Nothing is deleted outright:
    - **System Trash / Recycle Bin** by default, through the `trash` package with globbing off, so brackets
      in names stay literal. tidybot can't restore from it, so `undo` says to use Finder's Put Back or
      the Recycle Bin's Restore. History records these as `trash` entries with no destination.
    - **`trashDir`**: a folder the user picks instead. Files get there by the ordinary journaled move,
      so `undo` works. A name already in the folder gets a ` (1)` suffix rather than failing. Scans
      always skip that folder, even with `--include-organized`.
    - **Linux:** off until the user sets `trashDir`. Desktop trash varies by environment, and onboarding
      asks the user for a folder. **`allowDelete: false`** turns deleting off everywhere.
    - Whether deleting is available is checked at `propose` (unavailable → `invalid` item) and again at
      `apply`, in case the setting changed in between. `scan` and `status` report it as `trash`, so
      the agent knows before proposing.
    - Sending to the system Trash is journaled like a move. The journal is written first. Recovery then
      counts the operation as done if the file has left, and rolls it back if the file is still there.
      If history can't be written after the file left, the journal stays and the next command records it.
    - The guide limits deletions to exact duplicates (never the last copy) and the user's own rules, and
      keeps sensitive files out unless the user asks. `plan set <file> --delete` lets the user mark a
      file, and `plan set <file> <folder>` turns it back into a move.
    - `trash` is async, which made `applyPlan` async. The move lock now holds its claim until an async
      callback settles.

27. **Skipping files on purpose** *(requested)*. A proposal item can be `{file, skip: true, reason}`. The
    plan records it as `skipped` with the note "left in place by agent", apart from `folder: null` ("agent
    found no matching smart folder"). So the user can tell a deliberate choice from a file the agent
    couldn't place.
    - A skip can't have a folder, rename or `delete`. It needs no image summary, because nothing happens
      to the file.
    - The guide uses it for files the user's rules protect, and for subfolders the user already organized
      by hand (seen with `-r`). Those are skipped as a whole, so the agent doesn't split them. Smart
      folders are still left out by the scan itself (#14).
    - The guide tells the agent to put skipped files in the proposal rather than leave them out, so they
      show up in review. `propose` doesn't enforce this: it doesn't know what the scan returned.

28. **Fixes from a full run on a real `~/Downloads`** *(requested, 2026-10-17)*. An agent did onboarding,
    summaries (261 files) and a clean-up (332 files). Its feedback led to these changes:
    - **pdf.js warnings:** see #9. They showed the install path on every `scan`, `propose` and `plan show`.
    - **Wallet recovery phrases:** `ArcRecoveryPhrase.png` was not flagged. `name.wallet-seed` now matches
      `recovery phrase`, `seed phrase`, `secret phrase` and `mnemonic`, and `content.mentions` matches the
      same phrases. An image has no text to check, so the name is the only signal.
    - **`content.code-list` gives a count:** the reason is now, for example, `list of one-time codes: 6 of
      300 lines look like 8-character codes`. A few codes in a long document is probably a false positive.
      The agent may not open the file, so the count is all it has to decide. The reason never quotes a
      line. Rules can give such a detail through an optional `describe`.
    - **`summary todo` lists each hash once.** A summary belongs to the content, so the other paths go in
      `copies`. The run had 6 duplicate pairs that subagents summarized two times.
    - **`status` shows "can undo: N move(s)"** (JSON `undoableMoves`, which replaces `activeMoves`), and
      the latest plan to undo. "active moves" read as moves still running. The count leaves out files
      sent to the system Trash, because `undo` can't restore those.
    - **`skippedDirs`:** without `-r`, `scan` lists the subfolders it left out. Before, 16 subfolders were
      left out with no message. A smart folder inside the scanned directory counts in `skippedFolders`.
    - **`extractedArchives`:** an archive next to a folder with the same name (`x.zip` and `x/`, also
      `.tar.gz`, `.7z`, `.rar` and others). tidybot moves files, not folders (open question 5), so the
      guide tells the agent to tell the user, and to delete the archive only with the user's OK.
    - **`similar`:** probable copies that aren't identical, in three groups, strongest first. A group is
      left out when a stronger group already holds all its files, or when all its files are identical:
      - `same text`: the same extracted text (at least 100 characters). That is all the text extraction
        read, not only the excerpt: whole Office and text files, and the first PDF pages up to
        `excerptChars`. Two files can share their first pages and differ later, so this is a hint.
      - `same name`: the same name and extension apart from a copy marker: ` (1)`, ` copy`, ` copy 2`,
        ` - Copy`. A number suffix (`-2`, `_2`, ` 2`) is also used for versions and parts, so it only
        counts when the plain name exists too (`output.pdf` and `output-2.pdf`, but not `chapter-1.pdf`
        and `chapter-2.pdf`). Same-named files in different subfolders aren't grouped without a marker.
      - `same size`: the same type and exact size, at 64 KB or more. This found two scans of one page
        in the run. Smaller files have the same size by chance too often.
      - The guide says similar files are not identical. The agent compares them and deletes one only
        when the user's rules say so (the run had "keep the newest of `(1)`-style copies") or the
        user agrees.
    - **Conflicts say `identical` or `different`.** `refreshWarnings` compares the two files byte for byte
      (sizes first, then 1 MB blocks, stopping at the first difference). It is synchronous, so `plan set`
      and `plan skip` stay synchronous. For identical files the warning says to delete one instead.
    - **`plan set <files...> --folder <name>`**, also with `--path` and `--delete`. `--name` takes one file
      only. The change is all or nothing: if one file isn't in the plan, nothing is saved. The older
      `plan set <file> <folder>` still works: when there is no `--folder`, `--path` or `--delete`, a last
      argument that names a smart folder and is not a file in the plan is the folder. For many different
      changes, the guide points to `propose --append`, which already takes JSON.
    - **`tidybot preview <files...> [--out <dir>]`** writes a JPEG of at most 1024 px of an image, or of
      a PDF's first page. Some agents' image tools can't open HEIC or WebP. There is no new dependency:
      - macOS: `sips`, which reads HEIC, WebP and camera formats, and renders PDFs. `-Z` also makes small
        images larger, so tidybot reads the size first and only makes images smaller. A PDF page is
        always rendered at 1024 px, because its size is in points (72 dpi).
      - Elsewhere: ImageMagick (`magick`, or `convert` except on Windows, where `convert` is a disk tool).
        PDFs need Ghostscript and HEIC needs libheif there. With no converter, the command says what to
        install.
      - Files flagged sensitive are refused, as everywhere else. The default output folder is
        `tidybot-previews` in the temp directory.
    - **`extensionCase: keep | lower`** (config). With `lower`, a renamed file gets a lowercase extension
      (`.HEIC` → `.heic`). Default `keep`. A config value is more reliable than reading "lowercase" from
      the free-text `naming`. Files that aren't renamed keep their names. Plans record the value in
      `context`.
    - **Smaller fixes:** `survey` says which limit cut it short (`truncatedBy`: `depth` or `maxDirs`) and
      which option to raise. Extensions drop a URL query string (`.css?v=1736221786` → `.css`), in
      `survey` and in file types. `--data -` reads stdin, and the guides send large plans that way: the
      run's 332 items were 60 KB on the command line, near `ARG_MAX` on some systems.

## 🟡 Open questions

1. **Is `find` enough?** Ranked full-text search plus agent-side semantic search over `summary list` works
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
5. **Cleanup/trash.** Deleting files to the trash is in (#26). Moving whole folders as one unit was **dropped** as
   overkill: tidybot organizes files, and folders in the scanned directory are left alone.
6. **Name.** It's `tidybot` for now. There's no license or npm scope yet.
