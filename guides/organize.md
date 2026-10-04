# tidybot: organizing files (agent instructions)

You decide which smart folder each file belongs in, and optionally a better name.
tidybot gathers the facts and performs the moves; a human reviews your plan first.

## Steps
1. `tidybot scan [dir]` (add `-r` for subfolders) returns a **compact** view (field names as in `--json` output):
   - `folders`: smart folders (name, path, rule)
   - `rules`, `naming`, `rename`: the user's extra instructions, naming style and rename mode
   - `files`: `rel`, type, size, date, and either a cached `summary` or a short `preview`.
     Flags: `more` (longer text available), `needsSummary` ("required" for images,
     "recommended" for long documents and for documents with no text, like scanned PDFs), `sensitive`, `duplicate`.
   - `duplicates`: groups of identical files, including copies already filed elsewhere
   - `nextOffset`: present when there are more files; scan again with `--offset <n>`.
   Files already inside a smart folder are skipped (`skippedFolders`). So are recent files
   when the user configured `olderThan` (`skippedRecent`); pass `--older-than 14d` yourself if
   they say to leave recent downloads alone.
2. When the preview isn't enough to decide, get the full text for just those files:
   `tidybot inspect <rel>... --source <dir>`. Don't use `scan --full` on big folders.
3. If any file has `needsSummary`, do the summarize step (`tidybot guide summarize`).
   Images need a summary unless the filename already says what the image is: then propose it
   with `"summarySkipped": "<why the name is enough>"` (e.g. "Passport Photo IMG 1360.JPG").
4. For every file choose exactly one smart folder **by name**, or `null` when nothing
   fits. Never invent folders or paths. Optionally propose a new name (see Renaming).
5. Submit:
   `tidybot propose --source <dir> --data '{"items":[{"file":"<rel>","folder":"<name>","rename":"<new name or omit>","reason":"<short why>","confidence":0.9}]}'`
   (or pipe the JSON on stdin). This writes a plan; it moves nothing.
6. Check the plan's items for `warnings` (e.g. `conflict: ... already exists`). Fix them by
   re-proposing those files with a different `rename` using `--append`.
7. Tell the user about `duplicates` and `sensitive` files separately: tidybot doesn't delete, so
   suggest which copies they could delete (prefer keeping the one already in a smart folder).
   Leave extra copies out of the plan unless the user wants them filed.
8. Show the human `tidybot plan show`; apply their edits with
   `tidybot plan set <file> [folder] [--name <new>] [--keep-name]` / `tidybot plan skip <file>`.
9. Only after the human approves: `tidybot apply --yes`. Undo: `tidybot undo --last`.

## How to judge
- The user's `rules` apply to everything; a folder's `rule` outranks its name.
- Use filename, type, excerpt and summary together. Excerpts may be empty (images,
  archives, scanned PDFs): rely on the summary, filename and type.
- Prefer the most specific folder that matches (e.g. "Bills" over "Personal").
- Use `null` rather than guessing when unsure; give a reason.
- `confidence` is 0–1 and optional. Keep `reason` under ~15 words.

## Renaming
Respect `rename` mode: **off** = never rename; **auto** (default) = rename only when the
current name is unhelpful (UUIDs, "scan0001", "download (3)", "IMG_1234") or to resolve a
conflict; **always** = give every file a name following the naming style.
- Follow `naming` if set. Otherwise: descriptive, concise, keep dates found in the content
  (YYYY-MM-DD first when the user has no preference), no special characters.
- `rename` is the file name only (no folders). The extension is kept automatically.
- To rename without moving, use `"folder": null` together with `"rename"`.

## Examples
- "May 02 Chase scan.pdf", no excerpt, folders [Legal, Bills, Bank statements, Work]
  -> folder "Bank statements", rename omitted (name is already fine)
- "3f2a9c1e-77b0-4d1a.pdf", excerpt "Form I-485 ... Receipt Notice ... May 01, 2023"
  -> folder "Legal", rename "2023-05-01 I-485 receipt notice"

## Sensitive files
Files with `sensitive` (recovery codes, keys, credentials…) have no preview on purpose.
Don't open them. Point them out and suggest a password manager, then deleting the file.
Only propose a folder for them if the user asks.

Detection errs on the side of flagging; `sensitiveRule` says which rule fired
(`tidybot sensitive rules` lists them all). Handling false positives:
- **Filename rule** (`name.*`) on a clearly harmless name, e.g. `design-tokens.json`,
  `secret-santa.xlsx`: you may allow it yourself:
  `tidybot sensitive allow <rel>... --source <dir> --reason "<why it's not a secret>"`,
  then `inspect` it. Content is still checked, so a real secret stays hidden.
  Tell the user which files you allowed.
- **Content rule** (`content.*`): the file's text looks like a secret. Ask the user before
  allowing it with `--content`. Never allow it on your own.
- **Turning a rule off** everywhere (`tidybot sensitive allow-rule <id>`): only when the user
  asks, e.g. after several false positives from the same rule.

## Large directories
Scan pages through files (`nextOffset`). Propose each page, adding later pages to the same
plan with `tidybot propose --append`. `--match '*.pdf'` narrows a scan by name.

## Hidden files
Scans leave out hidden files and folders (dotfiles, and whatever the OS marks hidden); `skippedHidden`
counts them. Only include them when the user asks: `--include <glob>` for specific ones
(e.g. `--include .env.example`), `--include-hidden` for all.
