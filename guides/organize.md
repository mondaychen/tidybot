# tidybot: organizing files (agent instructions)

You decide which place each file belongs in, and optionally a better name.
tidybot gathers the facts and performs the moves; a human reviews your plan first.

## Steps
1. `tidybot scan [dir]` (add `-r` for subfolders) returns a **compact** view (field names as in `--json` output):
   - `places`: places, the destination folders (name, path, rule)
   - `rules`, `naming`, `rename`, `extensionCase`: the user's extra instructions, naming style, rename mode,
     and whether renamed files get a lowercase extension
   - `trash`: whether you may propose deleting files (`enabled`), and where they'd go
   - `files`: `rel`, type, size, date, and either a cached `summary` or a short `preview`.
     Flags: `more` (longer text available), `needsSummary` ("required" for images,
     "recommended" for long documents and for documents with no text, like scanned PDFs), `sensitive`,
     `duplicate`, `similar`.
   - `duplicates`: groups of identical files, including copies already filed elsewhere
   - `similar`: groups of probable copies that aren't identical, with `why`: "same text" (same extracted
     text, other bytes), "same name" (same name apart from ` (1)`, ` copy` or `-2`) or "same size"
     (same type and exact size). See Duplicates and similar files.
   - `skippedDirs`: subfolders a scan without `-r` left out. `extractedArchives`: an archive next to the
     folder it was extracted into (`export.zip` and `export/`).
   - `nextOffset`: present when there are more files; scan again with `--offset <n>`.
   Files already inside a place are skipped (`skippedPlaces`). So are recent files
   when the user configured `olderThan` (`skippedRecent`); pass `--older-than 14d` yourself if
   they say to leave recent downloads alone.
2. When the preview isn't enough to decide, get the full text for just those files:
   `tidybot inspect <rel>... --source <dir>`. Don't use `scan --full` on big folders.
3. If any file has `needsSummary`, do the summarize step (`tidybot guide summarize`).
   Images need a summary unless the filename already says what the image is: then propose it
   with `"summarySkipped": "<why the name is enough>"` (e.g. "Passport Photo IMG 1360.JPG").
4. For every file choose exactly one place **by name**, or `null` when nothing
   fits. Never invent places or paths. Optionally propose a new name (see Renaming),
   propose deleting the file instead (see Deleting), or leave it where it is on purpose
   (see Leaving files in place).
5. Submit on stdin, so a large plan doesn't hit the command-line length limit:
   ```
   tidybot propose --source <dir> --data - <<'EOF'
   {"items":[{"file":"<rel>","place":"<name>","rename":"<new name or omit>","reason":"<short why>","confidence":0.9}]}
   EOF
   ```
   `--data '<json>'` also works for a few items. This writes a plan; it moves nothing.
6. Check the plan's items for `warnings` (e.g. `conflict: ... already exists`). Each conflict says
   whether the two files are `identical` or `different`. For identical files, propose deleting the
   copy instead. For different files, re-propose with a different `rename` using `--append`.
7. For `duplicates`, propose deleting the extra copies when deleting is enabled (keep the one
   already in a place, or else the best-named one). Otherwise tell the user which copies
   they could delete. Tell the user about `sensitive` files separately.
8. Show the human `tidybot plan show`; apply their edits with
   `tidybot plan set <file>... --place <name>`, `tidybot plan set <file> --name <new>` (or `--keep-name`)
   and `tidybot plan skip <file>...`. For many different changes, re-propose those items with `--append`.
9. Only after the human approves: `tidybot apply --yes`. Undo: `tidybot undo --last`.
   Files sent to the system Trash can't be undone by tidybot; the user restores them from the Trash.

## How to judge
- The user's `rules` apply to everything; a place's `rule` outranks its name.
- Use filename, type, excerpt and summary together. Excerpts may be empty (images,
  archives, scanned PDFs): rely on the summary, filename and type.
- Labels such as `[SSN]`, `[CARD …1111]` or `[EMAIL]@chase.com` are personal data that tidybot masked
  (`maskPersonal`). Sort by the text around them. Don't open the file to find the value.
- Prefer the most specific place that matches (e.g. "Bills" over "Personal").
- Use `null` rather than guessing when unsure; give a reason.
- `confidence` is 0–1 and optional. Keep `reason` under ~15 words.

## Renaming
Respect `rename` mode: **off** = never rename; **auto** (default) = rename only when the
current name is unhelpful (UUIDs, "scan0001", "download (3)", "IMG_1234") or to resolve a
conflict; **always** = give every file a name following the naming style.
- Follow `naming` if set. Otherwise: descriptive, concise, keep dates found in the content
  (YYYY-MM-DD first when the user has no preference), no special characters.
- `rename` is the file name only (no folders). The extension is kept automatically. With
  `extensionCase: lower`, tidybot makes it lowercase (`.HEIC` → `.heic`).
- To rename without moving, use `"place": null` together with `"rename"`.

## Examples
- "May 02 Chase scan.pdf", no excerpt, places [Legal, Bills, Bank statements, Work]
  -> place "Bank statements", rename omitted (name is already fine)
- "3f2a9c1e-77b0-4d1a.pdf", excerpt "Form I-485 ... Receipt Notice ... May 01, 2023"
  -> place "Legal", rename "2023-05-01 I-485 receipt notice"

## Leaving files in place
Propose `{"file": "<rel>", "skip": true, "reason": "<why>"}` (no place, rename or delete) for a
file you leave where it is on purpose. The plan shows it as skipped, "left in place by agent".
Use `"place": null` only when you looked for a place and none fits.
Skip a file when:
- The user's `rules` say to leave it alone (e.g. "don't touch ~/Downloads/Projects").
- It's in a subfolder the user already organized by hand (you see these with `-r`; without it, they
  are only listed in `skippedDirs`). Signs: a
  descriptive folder name ("taxes-2023", "Wedding photos", "client-acme") and files that belong
  together. Skip all of its files, so you don't split the folder across places. A subfolder
  with a generic name ("New Folder", "Archive (2)", an unzipped download) full of unrelated files
  isn't organized: file those normally.
Rules:
- Put each skipped file in the proposal. Don't leave it out: the user can't review what isn't in the plan.
- Don't skip a file just because you're unsure where it goes. Use `null` with a reason.
- Tell the user which subfolders you left alone, so they can file them with `tidybot plan set`.

## Sensitive files
Files with `sensitive` (recovery codes, keys, credentials…) have no preview on purpose.
Don't open them. Point them out and suggest a password manager, then deleting the file.
Only propose a place for them if the user asks.

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

## Duplicates and similar files
- `duplicates` are byte-for-byte identical: you may propose deleting the extra copies (see Deleting).
- `similar` files are **not** identical. They're hints: an old and a new version, a download saved
  twice, two scans of one page. Before you treat them as copies, compare them (`inspect`, summaries,
  dates, sizes). Propose deleting one only when the user's `rules` say so (e.g. "keep the newest of
  `(1)`-style copies") or the user agrees. Otherwise file both, and tell the user.
- `extractedArchives`: the folder usually holds what the archive holds. tidybot moves files, not
  folders, so tell the user. Propose deleting the archive only when the user agrees or their rules say so.

## Large directories
Scan pages through files (`nextOffset`). Propose each page, adding later pages to the same
plan with `tidybot propose --append`. `--match '*.pdf'` narrows a scan by name.

## Deleting
Deleted files go to the trash, never straight away: the system Trash / Recycle Bin, or the
user's `trashDir` folder. Propose `{"file": "<rel>", "delete": true, "reason": "<why>"}` (no place).
- Only when `trash.enabled` is true in the scan. If it's false, say why (`trash.reason`) instead.
- Only for exact `duplicates` (never the last copy), or files the user's `rules` say to delete,
  or files the user agreed to delete.
  Don't delete a file just because it looks old or unimportant.
- Don't delete `sensitive` files unless the user asks.
- The user can switch an item with `tidybot plan set <file> --delete`, or back with
  `tidybot plan set <file> <place>`.

## Hidden files
Scans leave out hidden files and folders (dotfiles, and whatever the OS marks hidden); `skippedHidden`
counts them. Only include them when the user asks: `--include <glob>` for specific ones
(e.g. `--include .env.example`), `--include-hidden` for all.
