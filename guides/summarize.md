# tidybot: summarizing files (agent instructions)

Summaries are cached by content hash, so each file is summarized once, survives
renames/moves, and powers `tidybot find`. Short text files need none (their text is
cached automatically).

## Steps
1. `tidybot summary todo [dir] [-r]` lists files that need a summary, with
   `need` = "required" (images) or "recommended" (long documents, and documents with no text such as
   scanned PDFs). Identical files are listed once: one summary covers the `copies` too.
2. Delegate the reading. If you can spawn subagents, use a cheap/fast model or low
   reasoning effort (e.g. Haiku) and give each subagent a batch of ~5–10 file paths.
   Images and scanned documents need a multimodal model that can view them. If you can't delegate,
   read the files yourself.
   If your image tools can't open a format (HEIC, WebP, or a PDF page), make a small JPEG first:
   `tidybot preview <rel>... --source <dir> --out <dir>` prints where each one is. Give the subagent
   the preview path to look at, but keep the original path in `file`.
3. Subagent prompt (adapt as needed):

   > For each file path below, open the file (or the preview given next to it) and return JSON:
   > [{"file": "<path as given>", "summary": "<1–3 sentences: what it is, who/what it
   > concerns, key dates or amounts>", "keywords": ["<5–10 lowercase search terms:
   > document type, organizations, people, topics, year>"]}]
   > Never copy passwords, keys, tokens or codes into the summary; say what kind of
   > credential it is instead ("GitHub recovery codes"). Don't copy ID, passport, card or
   > account numbers either; name the kind ("US passport", "Visa card ending 1111").
   > Describe images by their content (e.g. "photo of a receipt from Costco dated
   > 2026-03-02", "screenshot of a flight booking"). Do not speculate beyond what is
   > visible. Return only the JSON.

   Files flagged `sensitive` never appear in the todo list. `summary save` rejects text
   that looks like a secret value. If `maskPersonal` is set, it masks personal data such as
   ID and card numbers.
4. Save the results: `tidybot summary save --model <model> --data '[...]'`
   (or pipe on stdin). Then continue with `tidybot guide organize`.

## Finding files later
- `tidybot find <words...>` does ranked search over summaries, keywords and names (word prefixes match).
- For vague requests ("that lease thing from last spring"), read
  `tidybot summary list` and judge semantically yourself.
