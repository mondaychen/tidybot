---
name: tidybot
description: Organize a messy directory (e.g. ~/Downloads) into the user's smart folders, rename badly named files, set up smart folders and naming rules, or find a file by what it contains, using the tidybot CLI. Use when the user asks to tidy, sort, file away, rename, or organize files, set up folders or rules for that, or find "that file about X".
---

# tidybot

tidybot is a CLI. You do the judging (classifying, naming, summarizing), tidybot handles the file
I/O and caching, and the user reviews before anything moves. Always pass `--json`.

1. Run `tidybot --json status`. If `folders` is 0, set up first by following `tidybot guide onboard`,
   which includes asking about naming style and general rules.
2. **Summarize** (follows `tidybot guide summarize`): `tidybot --json summary todo <dir> [-r]`.
   - Hand the listed files to subagents on a cheap/fast model, or at low effort, about 5–10 files each.
     Images need a multimodal model.
   - Save the results with `tidybot --json summary save --model <m> --data '[...]'`.
   - This step is required for images, because `propose` rejects an image that has no summary. The exception
     is an image whose filename already says what it is: propose it with `"summarySkipped": "<reason>"`.
3. **Organize** (follows `tidybot guide organize`):
   - `tidybot --json scan <dir> [-r]` gives you a compact list of files (summary or short preview, flags),
     duplicate groups, smart folders, `rules`, `naming` and `rename` mode. Files already inside smart
     folders are skipped. Page with `--offset <nextOffset>`. If the user wants recent files left alone,
     add `--older-than 14d`.
   - For files the preview doesn't settle, run `tidybot --json inspect <rel>... --source <dir>`. Don't use `scan --full`.
   - Pick one smart folder **by name** for each file, or `null`. Add a `rename` when the name is unhelpful
     or conflicts, following `naming`.
   - `tidybot --json propose --source <dir> --data '{"items":[{"file":"<rel>","folder":"<name>","rename":"<optional>","reason":"...","confidence":0.8}]}'`
   - Fix any `warnings` (name conflicts) by re-proposing with `--append` and a different `rename`.
   - Show the user `tidybot plan show` and apply their edits with `tidybot plan set <file> [folder] [--name n] [--keep-name]`
     and `tidybot plan skip <file>`.
4. **Do not run `tidybot apply` until the user approves the plan.** When they do, run
   `tidybot --json apply --yes`. `tidybot undo --last` reverts the batch, original names included.
5. **Duplicates and sensitive files:** tidybot never deletes. Tell the user which copies they could delete
   (keep the one already filed), and suggest a password manager for `sensitive` files.
   - Harmless files flagged by a **filename** rule (`sensitiveRule: name.*`) you may allow yourself:
     `tidybot --json sensitive allow <rel> --source <dir> --reason "..."`. Tell the user which ones.
   - **Content** matches (`content.*`) need the user's OK (`--content`). Turn a whole rule off
     (`sensitive allow-rule <id>`) only when the user asks.
6. **Find files:** `tidybot --json find <words>`. For vague descriptions, read `tidybot --json summary list`
   and match by meaning yourself.

Rules:
- Only use smart folder names returned by `scan`. Never make up paths.
- The user's `rules` apply to everything, and a folder's rule matters more than its name.
- If the user hasn't given a naming style and you're about to rename many files, ask whether they have one.
  Save it with `tidybot rules naming "..."`.
- When a scan reports `"truncated": true`, work in batches (`--match`, then `propose --append`).
