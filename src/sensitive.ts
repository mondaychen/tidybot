import path from "node:path";

/**
 * Heuristics for files that likely hold credentials. Sensitive files get no excerpt, no cached
 * summary, and are flagged so the agent can suggest a password manager instead of a folder.
 * False positives are cheap (the agent still sees name, type and size); false negatives leak secrets.
 */

const SENSITIVE_NAME: [RegExp, string][] = [
  [/recovery[-_ ]?(codes?|key)/i, "recovery codes"],
  [/backup[-_ ]?codes?/i, "backup codes"],
  [/emergency[-_ ]?kit/i, "password manager emergency kit"],
  [/client[-_ ]?secret/i, "OAuth client secret"],
  [/secret/i, "name mentions a secret"],
  [/password|passwd/i, "name mentions passwords"],
  [/credential/i, "name mentions credentials"],
  [/private[-_ ]?key|\bid_(rsa|dsa|ecdsa|ed25519)\b/i, "private key"],
  [/seed[-_ ]?phrase|mnemonic|wallet[-_ ]?backup/i, "wallet seed"],
  [/\b(2fa|mfa|otp|totp)\b|two[-_ ]?factor/i, "2FA material"],
  [/api[-_ ]?keys?\b|access[-_ ]?keys?\b|\btokens?\b/i, "API keys or tokens"],
  [/(^|[._-])env$|^\.?env([._-]|$)/i, "environment file"],
];

const SENSITIVE_EXT = new Set([".pem", ".key", ".p12", ".pfx", ".kdbx", ".keystore", ".jks", ".ovpn", ".gpg", ".asc", ".ppk", ".env"]);

const SECRET_CONTENT: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/, "GitHub token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}/, "API secret key"],
  [/\b(sk|rk)_live_[A-Za-z0-9]{16,}/, "Stripe key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
  [/"?client_secret"?\s*[:=]/i, "OAuth client secret"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./, "JWT"],
  [/\bA3-[A-Z0-9]{6}-[A-Z0-9]{5,6}-/, "1Password secret key"],
  [/(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?[^\s"']{6,}/i, "credential assignment"],
];

/** Signals in file content that aren't secrets themselves (so fine inside a summary). */
const MENTIONS: [RegExp, string][] = [[/recovery codes?|backup codes?|emergency kit|seed phrase/i, "mentions recovery material"]];

/** Lines that look like one-time recovery codes: "abcd-efgh", "1234 5678", "a1b2c3d4e5". */
const CODE_LINE = /^\s*(\d+[.)]\s*)?[A-Za-z0-9]{4,6}[- ]?[A-Za-z0-9]{4,6}([- ][A-Za-z0-9]{4,6})?\s*$/;

export function sensitiveByName(file: string): string | undefined {
  const name = path.basename(file);
  if (SENSITIVE_EXT.has(path.extname(name).toLowerCase())) return `${path.extname(name)} file`;
  return SENSITIVE_NAME.find(([re]) => re.test(name))?.[1];
}

/** `valuesOnly`: only look for actual secret values (used to vet agent-written summaries). */
export function sensitiveByContent(text: string, opts: { valuesOnly?: boolean } = {}): string | undefined {
  const patterns = opts.valuesOnly ? SECRET_CONTENT : [...SECRET_CONTENT, ...MENTIONS];
  const hit = patterns.find(([re]) => re.test(text));
  if (hit) return hit[1];
  const codeLines = text.split("\n").filter((l) => CODE_LINE.test(l) && /\d/.test(l)).length;
  if (codeLines >= 5) return "list of one-time codes";
  return undefined;
}
