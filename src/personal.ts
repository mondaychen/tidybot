/**
 * Masking of personal data: ID and account numbers, dates of birth and email addresses. Unlike a
 * secret, these don't hide the file: the value is replaced with a label ("[SSN]") and the words around
 * it stay, so a bank statement still reads as one. Turned on per kind with `config set maskPersonal`.
 *
 * Each rule finds as little as it can be sure of: numbers that check themselves (a card's Luhn digit,
 * an IBAN's mod 97, a Chinese ID's check digit, the SSN ranges), and numbers that are one only by the
 * words before them (a passport number, a date of birth). The patterns follow the personal-data rules
 * in magpie's internal/redact (MIT, github.com/yetone/magpie).
 */

export const PERSONAL_KINDS = ["ssn", "passport", "id-card", "card", "iban", "birthday", "email"] as const;
export type PersonalKind = (typeof PERSONAL_KINDS)[number];

interface Rule {
  kind: PersonalKind;
  /** Group 1 is the value to mask. Flags `g` and `d` are added. */
  pattern: RegExp;
  ok?: (v: string) => boolean;
  /** Where set, may shorten the value (by its end) to one that checks; undefined when none does. */
  fix?: (v: string) => string | undefined;
  label: (v: string) => string;
}

const lastFour = (v: string) => v.replace(/[^A-Za-z0-9]/g, "").slice(-4);

function ssnOK(v: string): boolean {
  const d = v.replace(/[- ]/g, "");
  if (d.length !== 9 || d.startsWith("000") || d.startsWith("666") || d.startsWith("9") || d.slice(3, 5) === "00" || d.slice(5) === "0000") {
    return false;
  }
  // The ones printed in ads and examples, and one digit nine times.
  return !["123456789", "078051120", "219099999"].includes(d) && new Set(d).size > 1;
}

/** Enough digits to be a number, not a word, and in capitals: the pattern's keyword is any case. */
const passportOK = (v: string) => v === v.toUpperCase() && (v.match(/\d/g)?.length ?? 0) >= 5 && new Set(v).size > 1;

function chineseIdOK(v: string): boolean {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = weights.reduce((s, w, i) => s + Number(v[i]) * w, 0);
  return v[17]?.toUpperCase() === "10X98765432"[sum % 11];
}

function luhn(v: string): boolean {
  const ds = [...v.replace(/\D/g, "")].map(Number).reverse();
  if (ds.length < 15 || ds.length > 19) return false;
  const sum = ds.reduce((s, d, i) => s + (i % 2 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0);
  return sum % 10 === 0;
}

/** IBAN length by country (SWIFT's IBAN registry). */
const IBAN_LENGTH: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28,
  CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18,
  FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28,
  IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20,
  LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28,
  NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24,
  SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26,
  UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

function ibanOK(v: string): boolean {
  const s = v.replace(/ /g, "");
  if (IBAN_LENGTH[s.slice(0, 2)] !== s.length) return false;
  let m = 0;
  for (const c of s.slice(4) + s.slice(0, 4)) {
    m = /\d/.test(c) ? (m * 10 + Number(c)) % 97 : (m * 100 + c.charCodeAt(0) - 55) % 97;
  }
  return m === 1;
}

/** An IBAN printed in groups of four can be followed by a word in capitals; drop groups until it checks. */
function ibanFix(v: string): string | undefined {
  for (let s = v; ; s = s.slice(0, s.lastIndexOf(" "))) {
    if (ibanOK(s)) return s;
    if (!s.includes(" ")) return undefined;
  }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function dateOK(v: string): boolean {
  const ns = v.match(/\d+/g)?.map((n) => ({ n: Number(n), len: n.length })) ?? [];
  const valid = (y: number, m: number, d: number) => y >= 1900 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
  const month = MONTHS.findIndex((m) => v.toLowerCase().includes(m)) + 1;
  if (ns.length === 2 && month) {
    // March 5, 1990 or 5 March 1990
    const [a, b] = ns as [{ n: number; len: number }, { n: number; len: number }];
    return a.len === 4 ? valid(a.n, month, b.n) : valid(b.n, month, a.n);
  }
  if (ns.length !== 3) return false;
  const [a, b, c] = ns as [{ n: number; len: number }, { n: number; len: number }, { n: number; len: number }];
  return a.len === 4 ? valid(a.n, b.n, c.n) : valid(c.n, a.n, b.n) || valid(c.n, b.n, a.n);
}

/** What may stand between a label and its value: `Passport No.: …`, `SSN is …`. */
const SEP = String.raw`["']?[ \t]*(?:[:#=：][ \t]*)?(?:(?:is|was)[ \t]+|是[ \t]*|は[ \t]*)?["']?`;
const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?`;
const DATE = String.raw`\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}[ \t]*年[ \t]*\d{1,2}[ \t]*月[ \t]*\d{1,2}[ \t]*日?|\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|${MONTH}[ \t]+\d{1,2}(?:st|nd|rd|th)?,?[ \t]+\d{4}|\d{1,2}(?:st|nd|rd|th)?[ \t]+${MONTH},?[ \t]+\d{4}`;

const RULES: Rule[] = ([
  // 123-45-6789 as it is written, or nine digits after "SSN"
  { kind: "ssn", pattern: /(?<![A-Za-z0-9-])(\d{3}-\d{2}-\d{4})(?![A-Za-z0-9-])/, ok: ssnOK, label: () => "[SSN]" },
  {
    kind: "ssn",
    pattern: new RegExp(String.raw`\b(?:ssn|social[ \t]+security(?:[ \t]+(?:number|no\.?|#))?)${SEP}(\d{9}|\d{3} \d{2} \d{4})(?!\d)`, "i"),
    ok: ssnOK,
    label: () => "[SSN]",
  },
  {
    kind: "passport",
    pattern: new RegExp(
      String.raw`(?:\bpassport(?:[ \t]*(?:no\.?|number|num|#))?|\breisepass(?:nummer)?|护照(?:号码|号)?|護照(?:號碼|号码|番号)?|パスポート(?:番号)?)${SEP}([A-Z0-9]{6,9})(?![A-Za-z0-9])`,
      "i",
    ),
    ok: passportOK,
    label: () => "[PASSPORT]",
  },
  // Chinese resident ID: region, birth date, sequence, check digit
  {
    kind: "id-card",
    pattern: /(?<![A-Za-z0-9])([1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])(?![A-Za-z0-9])/,
    ok: chineseIdOK,
    label: () => "[ID CARD]",
  },
  // Card numbers in groups of four, or Amex's 4-6-5. The last four digits stay: receipts print them too.
  {
    kind: "card",
    pattern: /(?<!\d)([3-6]\d{3}(?:[ -]?\d{4}){2,3}(?:[ -]?\d{1,3})?|3[47]\d{2}[ -]?\d{6}[ -]?\d{5})(?!\d)/,
    ok: luhn,
    label: (v) => `[CARD …${lastFour(v)}]`,
  },
  {
    kind: "iban",
    pattern: /(?<![A-Za-z0-9])([A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,3})?))(?![A-Za-z0-9])/,
    fix: ibanFix,
    label: (v) => `[IBAN …${lastFour(v)}]`,
  },
  // A date only after the words that say it's a birthday: other dates are what files are sorted by.
  {
    kind: "birthday",
    pattern: new RegExp(
      String.raw`(?:\bdate[ \t]+of[ \t]+birth|\bbirth[ \t_-]?date|\bbirthday|\bdob\b|\bd\.o\.b\.?|\bborn(?:[ \t]+on)?|\bgeburtsdatum|\bgeboren(?:[ \t]+am)?|生日|出生日期|出生年月日|出生于|出生於|出生|誕生日|生年月日)${SEP}(${DATE})(?!\d)`,
      "i",
    ),
    ok: dateOK,
    label: () => "[DATE OF BIRTH]",
  },
  // The part before the @. The domain stays: it says who the mail is from (chase.com).
  {
    kind: "email",
    pattern: /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
    label: () => "[EMAIL]",
  },
] satisfies Rule[]).map((r) => ({ ...r, pattern: new RegExp(r.pattern.source, `${r.pattern.flags}gd`) }));

interface Span {
  start: number;
  end: number;
  value: string;
  label: string;
}

/** Where `text` has personal data of the given kinds, in order and not overlapping. */
function find(text: string, kinds: readonly PersonalKind[]): Span[] {
  if (kinds.length === 0 || !text) return [];
  const spans: Span[] = [];
  for (const r of RULES) {
    if (!kinds.includes(r.kind)) continue;
    for (const m of text.matchAll(r.pattern)) {
      const at = m.indices?.[1];
      if (!at || m[1] === undefined) continue;
      const value = r.fix ? r.fix(m[1]) : r.ok && !r.ok(m[1]) ? undefined : m[1];
      if (value) spans.push({ start: at[0], end: at[0] + value.length, value, label: r.label(value) });
    }
  }
  // Where two overlap, the one that starts first wins, then the longer.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  return spans.filter((s, i) => !spans.slice(0, i).some((p) => p.end > s.start));
}

/** Replace the personal data of the given kinds in `text` with labels. Masked text masks to itself. */
export function maskPersonal(text: string, kinds: readonly PersonalKind[]): string {
  let out = "";
  let pos = 0;
  for (const s of find(text, kinds)) {
    out += text.slice(pos, s.start) + s.label;
    pos = s.end;
  }
  return out + text.slice(pos);
}

/** `maskPersonal` for a keyword, which is stored in lowercase: IBANs and passport numbers are found
 * in capitals. The result is lowercase. */
function maskKeyword(keyword: string, kinds: readonly PersonalKind[]): string {
  const upper = keyword.toUpperCase();
  const masked = maskPersonal(upper, kinds);
  return (masked === upper ? maskPersonal(keyword, kinds) : masked).toLowerCase();
}

/** A summary and its keywords, masked. A keyword is often a value from the summary on its own, where
 * no rule finds it ("X1234567" without "Passport No:"), so what the summary has is masked there too. */
export function maskSummary(summary: string, keywords: readonly string[], kinds: readonly PersonalKind[]): { summary: string; keywords: string[] } {
  const known = find(summary, kinds).map((s) => ({ value: s.value.toLowerCase(), label: s.label.toLowerCase() }));
  return {
    summary: maskPersonal(summary, kinds),
    keywords: keywords.map((k) => known.reduce((out, v) => out.replaceAll(v.value, v.label), maskKeyword(k, kinds))),
  };
}

/** `config set maskPersonal` input: "all", "none" or "", or kinds separated by commas or spaces. */
export function parsePersonalKinds(raw: string): string[] {
  const words = raw.split(/[\s,]+/).filter(Boolean).map((w) => w.toLowerCase());
  if (words.length === 1 && words[0] === "all") return [...PERSONAL_KINDS];
  if (words.length === 1 && words[0] === "none") return [];
  return [...new Set(words)];
}
