# E2E fixture: a messy Downloads folder

`make_downloads_test.py` builds a realistic Downloads folder (about 130 items, about 290 MB) and writes a
ground-truth manifest to `downloads-test.manifest.json` next to the script (gitignored). The manifest is written
outside the fixture, so tidybot never scans it.

```bash
pip install reportlab pillow python-docx openpyxl python-pptx   # ffmpeg + ssh-keygen optional
python3 test/e2e/make_downloads_test.py ~/Downloads-test --real-from ~/Downloads
python3 test/e2e/make_downloads_test.py ~/Downloads-test --force   # reset after a test moved things
```

`--force` only wipes a folder that has the hidden `.tidybot-fixture` marker, so it can't erase a real folder.

## What's inside

Everything generated uses fake identities: John/Jane/Emma Doe, Acme Robotics, SSN 123-45-6789, the Visa
test card 4111…, and AWS's documented example key. Tokens in `prod.env` etc. are random and assembled at
runtime, so secret scanners don't flag the script itself.

`--real-from` copies a set of public, non-personal documents (JEDEC/ARM specs, the Sutton & Barto RL book,
media files). It skips any that aren't found.

Each manifest item has:

| field | meaning |
|---|---|
| `category` | expected destination (e.g. `Finance & Tax`, `Kids & School`, `Sensitive`, `Junk / Review`) |
| `sensitive` | `secret` (credentials: must never be excerpted or cached), `pii` (SSN, passport, health), or null |
| `duplicate_of` | byte-identical to another item |
| `tags` | edge cases: `bad-name`, `uuid-name`, `needs-vision`, `image-only-pdf`, `recent`, `directory`, `extracted-archive`, `case-collision`, `nfd-unicode-name`, `near-255-byte-limit`, `emoji-name`, `partial-download`, `over-64MiB-quick-hash`, `symlink`, `zero-bytes`, `no-extension`, … |

`summary` in the manifest lists all secrets, PII, duplicate groups and recent files, for quick assertions like:

- no `secret` item's content appears in `scan` output or `~/.tidybot/summaries.jsonl`
- every `duplicate_groups` entry is reported as duplicates
- `directory` items are proposed as single units
- `recent` items are left alone with `--older-than 14d`
- `apply` + `undo --last` restores every `sha256` at its original path
