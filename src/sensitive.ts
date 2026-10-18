import path from "node:path";
import { lintSource } from "@secretlint/core";
import { rules as recommended } from "@secretlint/secretlint-rule-preset-recommend";

/**
 * Heuristics for files that likely hold credentials. Sensitive files get no excerpt, no cached
 * summary, and are flagged so the agent can suggest a password manager instead of a folder.
 * False positives are cheap (the agent still sees name, type and size); false negatives leak secrets.
 * Each rule has a stable id so it can be allowlisted (see store/allowlist.ts).
 */

export interface RuleInfo {
  id: string;
  /** name: matched against the filename (file isn't opened); content: against extracted text. */
  kind: "name" | "content";
  reason: string;
  /** Matches actual secret values (vs. names or mentions). Used to vet agent-written summaries. */
  value?: boolean;
}

interface Rule extends RuleInfo {
  test: (s: string) => boolean;
  /** A reason with details about the match, for rules whose hits are hard to judge from the name
   * alone. It must never quote the matched text. */
  describe?: (s: string) => string;
}

export interface SensitiveHit {
  rule: string;
  reason: string;
}

const re = (id: string, kind: Rule["kind"], pattern: RegExp, reason: string, value = false): Rule => ({
  id,
  kind,
  reason,
  value,
  test: (s) => pattern.test(s),
});

/** Like `re`, but a match counts only when `ok` accepts its value (group 1). Every match is checked. */
const reValue = (id: string, pattern: RegExp, reason: string, ok: (v: string) => boolean): Rule => {
  const all = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  return { id, kind: "content", reason, value: true, test: (s) => [...s.matchAll(all)].some((m) => ok(m[1] ?? m[0])) };
};

/** Not a value but a stand-in for one: `${DB_PASS}`, `<your-key>`, `{{token}}`, `%PASS%`, `********`,
 * `____`, `process.env.TOKEN`. */
function placeholder(v: string): boolean {
  return /^[$%{<[*]/.test(v) || /^[*xX._-]+$/.test(v) || /^(process\.env|os\.environ|os\.getenv)\b/.test(v);
}

/** One plain word ("required", "Optional") is prose, not a password: "Password: required". A value with a
 * digit, a symbol or a capital after the first letter still counts, as does an all-lowercase passphrase
 * of 16 letters or more. */
const proseWord = (v: string) => /^[A-Z]?[a-z]{1,15}$/.test(v.replace(/[.,;:!?)]+$/, ""));

const lettersAndDigits = (v: string) => /\d/.test(v) && /[A-Za-z]/.test(v);

const SENSITIVE_EXT =new Set([".pem", ".key", ".p12", ".pfx", ".kdbx", ".keystore", ".jks", ".ovpn", ".gpg", ".asc", ".ppk", ".env"]);

/** Lines that look like one-time recovery codes: "abcd-efgh", "1234 5678", "a1b2c3d4e5". */
const CODE_LINE = /^\s*(\d+[.)]\s*)?[A-Za-z0-9]{4,6}[- ]?[A-Za-z0-9]{4,6}([- ][A-Za-z0-9]{4,6})?\s*$/;
const codeLines = (t: string) => t.split("\n").filter((l) => CODE_LINE.test(l) && /\d/.test(l));

/** "12 of 300 lines look like 8-character codes": enough to judge a likely false positive (a
 * few codes in a long document) without showing any of them. */
function describeCodes(t: string): string {
  const codes = codeLines(t);
  const lengths = new Map<number, number>();
  for (const l of codes) {
    const n = l.replace(/^\s*\d+[.)]/, "").replace(/[^A-Za-z0-9]/g, "").length;
    lengths.set(n, (lengths.get(n) ?? 0) + 1);
  }
  const common = [...lengths].sort((a, b) => b[1] - a[1])[0]?.[0];
  const lines = t.split("\n").filter((l) => l.trim()).length;
  return `list of one-time codes: ${codes.length} of ${lines} lines look like ${common}-character codes`;
}

const PATTERNS: Rule[] = [
  // ---- filename rules (checked first; the file isn't opened when one matches)
  { id: "name.extension", kind: "name", reason: "key/credential file type", test: (n) => SENSITIVE_EXT.has(path.extname(n).toLowerCase()) },
  re("name.recovery-codes", "name", /recovery[-_ ]?(codes?|key)/i, "recovery codes"),
  re("name.backup-codes", "name", /backup[-_ ]?codes?/i, "backup codes"),
  re("name.emergency-kit", "name", /emergency[-_ ]?kit/i, "password manager emergency kit"),
  re("name.client-secret", "name", /client[-_ ]?secret/i, "OAuth client secret"),
  re("name.secret", "name", /secret/i, "name mentions a secret"),
  re("name.password", "name", /password|passwd/i, "name mentions passwords"),
  re("name.credential", "name", /credential/i, "name mentions credentials"),
  re("name.private-key", "name", /private[-_ ]?key|\bid_(rsa|dsa|ecdsa|ed25519)\b/i, "private key"),
  re("name.wallet-seed", "name", /(seed|recovery|secret)[-_ ]?phrase|mnemonic|wallet[-_ ]?backup/i, "wallet seed"),
  re("name.2fa", "name", /\b(2fa|mfa|otp|totp)\b|two[-_ ]?factor/i, "2FA material"),
  re("name.tokens", "name", /api[-_ ]?keys?\b|access[-_ ]?keys?\b|\btokens?\b/i, "API keys or tokens"),
  re("name.env", "name", /(^|[._-])env$|^\.?env([._-]|$)/i, "environment file"),
  // ---- content rules (secret values)
  re("content.private-key", "content", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/, "private key", true),
  re("content.aws-key", "content", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, "AWS access key", true),
  re("content.github-token", "content", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/, "GitHub token", true),
  re("content.slack-token", "content", /\bxox[abprs]-[A-Za-z0-9-]{10,}/, "Slack token", true),
  re("content.sk-key", "content", /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/, "API secret key", true),
  re("content.stripe-key", "content", /\b(sk|rk)_live_[A-Za-z0-9]{16,}/, "Stripe key", true),
  re("content.google-api-key", "content", /\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key", true),
  re("content.client-secret", "content", /"?client_secret"?\s*[:=]/i, "OAuth client secret", true),
  re("content.jwt", "content", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./, "JWT", true),
  re("content.1password-key", "content", /\bA3-[A-Z0-9]{6}-[A-Z0-9]{5,6}-/, "1Password secret key", true),
  re("content.huggingface-token", "content", /\bhf_[A-Za-z0-9]{30,}/, "Hugging Face token", true),
  re("content.xai-key", "content", /\bxai-[A-Za-z0-9]{40,}/, "xAI API key", true),
  re("content.pypi-token", "content", /\bpypi-[A-Za-z0-9_-]{50,}/, "PyPI token", true),
  re("content.digitalocean-token", "content", /\bdop_v1_[a-f0-9]{64}\b/, "DigitalOcean token", true),
  // A gateway's or relay's own keys: oc_sk_…, or_sk_…
  reValue("content.relay-key", /\b[a-z]{2,4}_sk_([A-Za-z0-9_-]{20,})/, "API secret key", lettersAndDigits),
  // The password in scheme://user:password@host, for any scheme (redis, amqp, ftp, …)
  reValue("content.url-password", /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/?#"'<>]+:([^\s@/?#"'<>]{3,})@/, "password in a URL", (v) => !placeholder(v)),
  // A field called just "key", as in a provider config: "key": "oc_…". Code calls many things a key,
  // so only a long value with letters and digits counts.
  reValue("content.key-field", /(?:^|[^A-Za-z0-9_.-])["']?key["']?[ \t]*[:=][ \t]*["']?([A-Za-z0-9_\-./+=~!@#%^&*]{16,})/i, "key field", lettersAndDigits),
  reValue(
    "content.assignment",
    /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?([^\s"']{6,})/i,
    "credential assignment",
    (v) => !placeholder(v) && !proseWord(v),
  ),
  {
    id: "content.code-list",
    kind: "content",
    reason: "list of one-time codes",
    value: true,
    test: (t) => codeLines(t).length >= 5,
    describe: describeCodes,
  },
  // ---- content rules (mentions: not secrets themselves, so fine inside a summary)
  re("content.mentions", "content", /recovery codes?|backup codes?|emergency kit|(seed|recovery|secret) phrase/i, "mentions recovery material"),
];

/** secretlint's maintained recommended rules (cloud, SaaS and database credentials), checked after
 * the patterns above. They run as one rule id, so they are allowlisted together. */
const SECRETLINT: RuleInfo = { id: "content.secretlint", kind: "content", reason: "secret value", value: true };

/** Every rule, in the order they are checked. */
export const RULES: readonly RuleInfo[] = [...PATTERNS, SECRETLINT];

export const RULE_IDS = new Set(RULES.map((r) => r.id));

const SECRETLINT_PREFIX = "@secretlint/secretlint-rule-";
/** Without filter-comments, a `secretlint-disable` comment in a file can't switch detection off. */
const SECRETLINT_CONFIG = {
  rules: recommended.filter((r) => r.meta.id !== `${SECRETLINT_PREFIX}filter-comments`).map((r) => ({ id: r.meta.id, rule: r })),
};

/** The secretlint rule that matched, e.g. "github". Its message is not used: it quotes the secret. */
async function secretlint(text: string): Promise<string | undefined> {
  const { messages } = await lintSource({
    // With a .txt name, rules that read the file from disk (GCP's .p12 check) never run.
    source: { filePath: "excerpt.txt", content: text, contentType: "text" },
    options: { config: SECRETLINT_CONFIG },
  });
  return messages[0]?.ruleId.replace(SECRETLINT_PREFIX, "");
}

const hit = (r: Rule | undefined, text = ""): SensitiveHit | undefined => (r ? { rule: r.id, reason: r.describe?.(text) ?? r.reason } : undefined);

export function sensitiveByName(file: string, disabled: ReadonlySet<string> = new Set()): SensitiveHit | undefined {
  const name = path.basename(file);
  return hit(PATTERNS.find((r) => r.kind === "name" && !disabled.has(r.id) && r.test(name)));
}

/** `valuesOnly`: only rules that match actual secret values (used to vet agent-written summaries). */
export async function sensitiveByContent(
  text: string,
  opts: { valuesOnly?: boolean; disabled?: ReadonlySet<string> } = {},
): Promise<SensitiveHit | undefined> {
  const found = hit(
    PATTERNS.find((r) => r.kind === "content" && (!opts.valuesOnly || r.value) && !opts.disabled?.has(r.id) && r.test(text)),
    text,
  );
  if (found || opts.disabled?.has(SECRETLINT.id)) return found;
  const rule = await secretlint(text);
  return rule ? { rule: SECRETLINT.id, reason: `${SECRETLINT.reason} (${rule})` } : undefined;
}
