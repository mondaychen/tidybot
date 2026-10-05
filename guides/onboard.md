# tidybot: setting up smart folders (agent instructions)

Goal: set up smart folders (name, path, rule), naming style and general rules that fit how
this person already organizes files. Save only what they approve.

## Steps
1. Ask the person which directories hold their organized files (e.g. ~/Documents)
   and which directory they want to clean up (e.g. ~/Downloads).
   If they want settings for just one project/folder tree, run `tidybot init` there first.
2. `tidybot survey <dir>...` summarizes existing folder structure: file counts,
   dominant extensions and sample file names per directory.
3. `tidybot scan <messy dir> --excerpt-chars 300` shows what needs sorting.
4. Look for clusters (invoices, bank statements, code, installers, photos, work
   projects...). Prefer reusing existing directories as paths over inventing new ones.
5. Ask about preferences, then present your proposal and let them edit/accept/reject each folder.
6. Save the accepted set (preview first with --dry-run):
   `tidybot folders import --dry-run --data '[{"name":"Bills","path":"~/Documents/personal/bills","rule":"Utility, phone and credit-card bills and receipts"}]'`
   then again without --dry-run. Folders with an existing name are updated.
7. Ask whether they have a **naming style** for renamed files (date format, word
   separators, case, what to include) and whether renaming should be auto/always/off.
   Save with `tidybot rules naming "<their words>"` and `tidybot config set rename <mode>`.
   If they have no preference, leave naming empty.
8. Ask whether there are **general rules** that don't fit a single folder (e.g. "never
   move anything with 'draft' in the name", "tax documents go to Tax even if they are
   bills"). Save each with `tidybot rules add "<rule>"`.

9. Ask whether tidybot may propose **deleting** files, such as extra copies of duplicates. Deleted
   files go to the trash, and nothing is deleted until they approve a plan.
   - If they'd rather not: `tidybot config set allowDelete false`.
   - If they want deleted files kept in a folder of their own instead of the system Trash:
     `tidybot config set trashDir <dir>`. Files there can be restored with `tidybot undo`.
   - On Linux, deleting stays off until they pick a folder (`tidybot status` shows it): ask
     which one, then `tidybot config set trashDir <dir>`.

## Writing good folder rules
- One or two sentences describing what belongs (and, if useful, what does not).
- Mention strong signals: senders, keywords, file types, filename patterns.
- Names and paths must be unique. Paths may use ~.
