# tidybot: overview (agent instructions)

Use tidybot when the user asks to tidy, sort, file away, rename or organize files (e.g. ~/Downloads),
set up places or rules for that, or find "that file about X".

tidybot is a CLI. You do the judging (classifying, naming, summarizing), tidybot handles the file
I/O and caching, and the user reviews before anything moves. Output is plain text by default; add
`--json` (or set `TIDYBOT_JSON=1`) if you'd rather parse JSON. Field names below are the JSON ones.

## Workflow
1. Run `tidybot status`. If `places` is 0, set up first by following `tidybot guide onboard`,
   which includes asking about naming style and general rules.
2. **Summarize** (follows `tidybot guide summarize`): `tidybot summary todo <dir> [-r]`.
   - Hand the listed files to subagents on a cheap/fast model, or at low effort, about 5–10 files each.
     Images need a multimodal model. If its tools can't open HEIC, WebP or PDF pages, use
     `tidybot preview <rel>... --source <dir>` to make small JPEGs.
   - Save the results with `tidybot summary save --model <m> --data '[...]'`.
   - This step is required for images, because `propose` rejects an image that has no summary. The exception
     is an image whose filename already says what it is: propose it with `"summarySkipped": "<reason>"`.
3. **Organize** (follows `tidybot guide organize`):
   - `tidybot scan <dir> [-r]` gives you a compact list of files (summary or short preview, flags),
     duplicate groups, `similar` files (probable copies that aren't identical: check them, don't
     delete them unless the user's rules say so), places, `rules`, `naming` and `rename` mode.
     Without `-r`, subfolders are listed in `skippedDirs`. Files already inside
     places are skipped. Page with `--offset <nextOffset>`. If the user wants recent files left alone,
     add `--older-than 14d`.
   - For files the preview doesn't settle, run `tidybot inspect <rel>... --source <dir>`. Don't use `scan --full`.
   - Pick one place **by name** for each file, or `null`. Add a `rename` when the name is unhelpful
     or conflicts, following `naming`. Extra copies of duplicates (and files the user's rules say to
     delete) can be proposed as `{"file": "<rel>", "delete": true, "reason": "..."}` when `trash.enabled`.
     Files to leave alone on purpose (the user's rules say so, or they're in a subfolder the user already
     organized by hand) go in as `{"file": "<rel>", "skip": true, "reason": "..."}`. Don't leave them out.
   - `tidybot propose --source <dir> --data '{"items":[{"file":"<rel>","place":"<name>","rename":"<optional>","reason":"...","confidence":0.8}]}'`.
     For a large plan, send the JSON on stdin with `--data -`.
   - Fix any `warnings` (name conflicts): if the files are identical, propose deleting the copy; if
     they're different, re-propose with `--append` and a different `rename`.
   - Show the user `tidybot plan show` and apply their edits with `tidybot plan set <file>... --place <name>`,
     `tidybot plan set <file> --name n` (or `--keep-name`) and `tidybot plan skip <file>...`.
4. **Do not run `tidybot apply` until the user approves the plan.** When they do, run
   `tidybot apply --yes`. `tidybot undo --last` reverts the batch, original names included.
   If tidybot reports an interrupted move it can't recover safely, show the user both paths. Run
   `tidybot recover --abandon <id>` only once they confirm the files are where they want them.
5. **Duplicates and sensitive files:** deleted files always go to the trash (system Trash, or the user's
   `trashDir`). Keep the copy already filed. If deleting is off, tell the user which copies they could
   delete instead. Suggest a password manager for `sensitive` files.
   - Harmless files flagged by a **filename** rule (`sensitiveRule: name.*`) you may allow yourself:
     `tidybot sensitive allow <rel> --source <dir> --reason "..."`. Tell the user which ones.
   - **Content** matches (`content.*`) need the user's OK (`--content`). Turn a whole rule off
     (`sensitive allow-rule <id>`) only when the user asks.
6. **Find files:** `tidybot find <words>`. For vague descriptions, read `tidybot summary list`
   and match by meaning yourself.

## Rules
- Only use place names returned by `scan`. Never make up paths.
- The user's `rules` apply to everything, and a place's rule matters more than its name.
- If the user hasn't given a naming style and you're about to rename many files, ask whether they have one.
  Save it with `tidybot rules naming "..."`.
- When a scan reports `"truncated": true`, work in batches (`--match`, then `propose --append`).
