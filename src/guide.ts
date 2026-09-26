/**
 * Instructions for the AI agent driving tidybot. This replaces the old hard-coded LLM prompt:
 * tidybot gathers context and applies decisions; the agent does the judging.
 */

export const ORGANIZE_GUIDE = `# tidybot: organizing files (agent instructions)

You decide which smart folder each file belongs in, and optionally a better name.
tidybot gathers the facts and performs the moves; a human reviews your plan first.

## Steps
1. \`tidybot --json scan [dir]\` (add \`-r\` for subfolders) returns:
   - \`folders\`: smart folders (name, path, rule)
   - \`rules\`, \`naming\`, \`rename\`: the user's extra instructions, naming style and rename mode
   - \`files\`: name, type, size, date, excerpt, cached \`summary\`/\`keywords\`, and
     \`needsSummary\` ("required" for images, "recommended" for long documents).
   Files already inside a smart folder are skipped (see \`skippedFolders\`).
   Files with \`sensitive\` (recovery codes, keys, credentials…) have no excerpt on purpose.
   Don't open them. Point them out to the user and suggest storing them in a password manager
   and deleting the file. Only propose a folder for them if the user asks.
2. If any file has \`needsSummary\`, do the summarize step first (\`tidybot guide summarize\`).
   It is **required** for images: \`propose\` rejects images without a summary.
3. For every file choose exactly one smart folder **by name**, or \`null\` when nothing
   fits. Never invent folders or paths. Optionally propose a new name (see Renaming).
4. Submit:
   \`tidybot --json propose --source <dir> --data '{"items":[{"file":"<rel>","folder":"<name>","rename":"<new name or omit>","reason":"<short why>","confidence":0.9}]}'\`
   (or pipe the JSON on stdin). This writes a plan; it moves nothing.
5. Check the plan's items for \`warnings\` (e.g. \`conflict: ... already exists\`). Fix them by
   re-proposing those files with a different \`rename\` using \`--append\`.
6. Show the human \`tidybot plan show\`; apply their edits with
   \`tidybot plan set <file> [folder] [--name <new>] [--keep-name]\` / \`tidybot plan skip <file>\`.
7. Only after the human approves: \`tidybot --json apply --yes\`. Undo: \`tidybot undo --last\`.

## How to judge
- The user's \`rules\` apply to everything; a folder's \`rule\` outranks its name.
- Use filename, type, excerpt and summary together. Excerpts may be empty (images,
  archives, scanned PDFs): rely on the summary, filename and type.
- Prefer the most specific folder that matches (e.g. "Bills" over "Personal").
- Use \`null\` rather than guessing when unsure; give a reason.
- \`confidence\` is 0–1 and optional. Keep \`reason\` under ~15 words.

## Renaming
Respect \`rename\` mode: **off** = never rename; **auto** (default) = rename only when the
current name is unhelpful (UUIDs, "scan0001", "download (3)", "IMG_1234") or to resolve a
conflict; **always** = give every file a name following the naming style.
- Follow \`naming\` if set. Otherwise: descriptive, concise, keep dates found in the content
  (YYYY-MM-DD first when the user has no preference), no special characters.
- \`rename\` is the file name only (no folders). The extension is kept automatically.
- To rename without moving, use \`"folder": null\` together with \`"rename"\`.

## Examples
- "May 02 Chase scan.pdf", no excerpt, folders [Legal, Bills, Bank statements, Work]
  -> folder "Bank statements", rename omitted (name is already fine)
- "3f2a9c1e-77b0-4d1a.pdf", excerpt "Form I-485 ... Receipt Notice ... May 01, 2023"
  -> folder "Legal", rename "2023-05-01 I-485 receipt notice"

## Large directories
\`scan\` is capped by --max-files. Work in batches: scan with --match, propose, then
add later batches to the same plan with \`tidybot propose --append\`.
`;

export const SUMMARIZE_GUIDE = `# tidybot: summarizing files (agent instructions)

Summaries are cached by content hash, so each file is summarized once, survives
renames/moves, and powers \`tidybot find\`. Short text files need none (their text is
cached automatically).

## Steps
1. \`tidybot --json summary todo [dir] [-r]\` lists files that need a summary, with
   \`need\` = "required" (images) or "recommended" (long documents).
2. Delegate the reading. If you can spawn subagents, use a cheap/fast model or low
   reasoning effort (e.g. Haiku) and give each subagent a batch of ~5–10 file paths.
   Images need a multimodal model that can view image files. If you can't delegate,
   read the files yourself.
3. Subagent prompt (adapt as needed):

   > For each file path below, open the file and return JSON:
   > [{"file": "<path as given>", "summary": "<1–3 sentences: what it is, who/what it
   > concerns, key dates or amounts>", "keywords": ["<5–10 lowercase search terms:
   > document type, organizations, people, topics, year>"]}]
   > Never copy passwords, keys, tokens or codes into the summary; say what kind of
   > credential it is instead ("GitHub recovery codes").
   > Describe images by their content (e.g. "photo of a receipt from Costco dated
   > 2026-03-02", "screenshot of a flight booking"). Do not speculate beyond what is
   > visible. Return only the JSON.

   Files flagged \`sensitive\` never appear in the todo list. \`summary save\` rejects text
   that looks like a secret value.
4. Save the results: \`tidybot --json summary save --model <model> --data '[...]'\`
   (or pipe on stdin). Then continue with \`tidybot guide organize\`.

## Finding files later
- \`tidybot --json find <words...>\` does keyword search over summaries and names.
- For vague requests ("that lease thing from last spring"), read
  \`tidybot --json summary list\` and judge semantically yourself.
`;

export const ONBOARD_GUIDE = `# tidybot: setting up smart folders (agent instructions)

Goal: set up smart folders (name, path, rule), naming style and general rules that fit how
this person already organizes files. Save only what they approve.

## Steps
1. Ask the person which directories hold their organized files (e.g. ~/Documents)
   and which directory they want to clean up (e.g. ~/Downloads).
   If they want settings for just one project/folder tree, run \`tidybot init\` there first.
2. \`tidybot --json survey <dir>...\` summarizes existing folder structure: file counts,
   dominant extensions and sample file names per directory.
3. \`tidybot --json scan <messy dir> --excerpt-chars 300\` shows what needs sorting.
4. Look for clusters (invoices, bank statements, code, installers, photos, work
   projects...). Prefer reusing existing directories as paths over inventing new ones.
5. Ask about preferences, then present your proposal and let them edit/accept/reject each folder.
6. Save the accepted set (preview first with --dry-run):
   \`tidybot --json folders import --dry-run --data '[{"name":"Bills","path":"~/Documents/personal/bills","rule":"Utility, phone and credit-card bills and receipts"}]'\`
   then again without --dry-run. Folders with an existing name are updated.
7. Ask whether they have a **naming style** for renamed files (date format, word
   separators, case, what to include) and whether renaming should be auto/always/off.
   Save with \`tidybot rules naming "<their words>"\` and \`tidybot config set rename <mode>\`.
   If they have no preference, leave naming empty.
8. Ask whether there are **general rules** that don't fit a single folder (e.g. "never
   move anything with 'draft' in the name", "tax documents go to Tax even if they are
   bills"). Save each with \`tidybot rules add "<rule>"\`.

## Writing good folder rules
- One or two sentences describing what belongs (and, if useful, what does not).
- Mention strong signals: senders, keywords, file types, filename patterns.
- Names and paths must be unique. Paths may use ~.
`;

export const GUIDES = { organize: ORGANIZE_GUIDE, summarize: SUMMARIZE_GUIDE, onboard: ONBOARD_GUIDE } as const;
export type GuideTopic = keyof typeof GUIDES;
