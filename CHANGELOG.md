# Changelog

## 0.2.0

### Added
- **Masking of personal data.** `tidybot config set maskPersonal all` (or a list such as
  `ssn,card,iban`) replaces ID and account numbers, dates of birth and the part of an email address
  before the `@` with labels such as `[SSN]`, `[CARD …1111]` and `[EMAIL]@chase.com`. The words around
  a value stay, so files still sort as before. Masking applies to `scan` and `inspect` excerpts,
  cached summaries, `find` and `summary list`, also to summaries saved before you turned it on. It is
  off by default, and onboarding asks about it. See "Personal data" in the README.
- **Your own secret rules.** `tidybot sensitive add-rule <name> --prefix <text>` or `--regex <pattern>`
  adds a rule for a secret that the built-in rules don't know, such as your company's own tokens.
  Matching files become `sensitive`. `tidybot sensitive rm-rule <name>` removes a rule, and
  `tidybot sensitive rules` lists your rules with the built-in ones.
- **More secrets found:** PGP private key blocks, temporary AWS keys (`ASIA…`), Hugging Face, xAI,
  PyPI and DigitalOcean tokens, relay keys such as `oc_sk_…`, a long `"key": "…"` value, and
  passwords in any `scheme://user:password@host` URL (for example redis or amqp).
- A "Get started" section in the README.

### Changed
- `content.assignment` no longer flags stand-ins for a value, such as `password: ${DB_PASSWORD}`,
  `api_key = <your-key>`, `password = ********` or `Password: ____`, or one plain word, as in
  "Password: required". Setup guides, config templates and forms now keep their excerpts.
- The summarize guide tells subagents not to copy ID, passport, card or account numbers into
  summaries.

### Upgrade notes
- The new rules can flag files that 0.1.0 didn't flag. If a new rule flags harmless files, turn it
  off with `tidybot sensitive allow-rule <id>`.

## 0.1.0

First release on npm.
