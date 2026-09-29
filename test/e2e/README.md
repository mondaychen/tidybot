# E2E fixture: a messy Downloads folder

`make_downloads_test.py` builds a realistic Downloads folder (about 100 items, or 130 with `--real-from`) and
writes a ground-truth manifest to `downloads-test.manifest.json` next to the script (gitignored). The manifest is
written outside the fixture, so tidybot never scans it.

```bash
pip install reportlab pillow python-docx openpyxl python-pptx   # ffmpeg + ssh-keygen optional
python3 test/e2e/make_downloads_test.py ~/Downloads-test --real-from ~/Downloads
python3 test/e2e/make_downloads_test.py ~/Downloads-test --force   # reset after a test moved things
```

`--force` only wipes a folder that has the hidden `.tidybot-fixture` marker, so it can't erase a real folder.

File ages are set through modification times. tidybot also counts a file's creation time as its age,
which macOS moves back along with the modification time but Linux doesn't, so on Linux every file
looks recent to `--older-than`. Run the fixture on macOS.

File ages are relative to when the fixture was built (`recent` means under 14 days old then), so rebuild it
with `--force` before a test run.

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
| `tags` | edge cases: `bad-name`, `uuid-name`, `needs-vision`, `image-only-pdf`, `recent`, `directory`, `extracted-archive`, `case-collision`, `nfd-unicode-name`, `near-255-byte-limit`, `emoji-name`, `partial-download`, `over-64MiB-quick-hash`, `same-sampled-hash-not-duplicate`, `symlink`, `zero-bytes`, `no-extension`, … |

`summary` in the manifest lists all secrets, PII, duplicate groups and recent files.

## The e2e suite

```bash
pnpm test:e2e                                        # builds a fresh fixture in a temp dir
TIDYBOT_E2E_REAL_FROM=~/Downloads pnpm test:e2e      # also include the real sample files
```

`downloads.e2e.ts` runs the CLI against the fixture and checks it against the manifest. It isn't part of
`pnpm test`, because it needs the Python packages above. It checks that:

- `scan` lists every top-level file, and no hidden files, directories or symlinks. A recursive scan also
  lists nested files
- `--older-than 14d` leaves exactly the `recent` files alone (macOS only, see above)
- the reported duplicate groups are exactly the byte-identical ones, including large files whose sampled
  hashes match but whose middles differ
- every `secret` is flagged (images are asked to be viewed instead), and no secret value appears in scan
  output or `summaries.jsonl`
- `needs-content` documents get text, CJK documents extract, and `needs-vision` files are flagged for a summary
- filing everything by category, with name conflicts renamed, and then `undo --last` puts every file back
  with its original `sha256`

tidybot moves files, not directories, so `directory` items are only listed as context. It doesn't treat
`pii` as sensitive either; those files are organized like any other.
