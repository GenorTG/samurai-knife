import { finding, type Finding, type Severity } from "./findings";
import { glossaryMismatches } from "./glossary";
import { pyRegex, rstripChars } from "./regex";
import * as tokens from "./tokens";
import { TECH_TERMS } from "./vocab";

/** PL <-> EN consistency check: what must survive translation unchanged, and what must differ. */

export const LENGTH_RATIO_WARN = 2.2;
export const LENGTH_RATIO_MIN_CHARS = 40;
export const UNTRANSLATED_MIN_PROSE_WORDS = 3;

const EMAIL = pyRegex(String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`, "g");
const URL_RE = pyRegex(
  String.raw`(?:https?://|www\.)[^\s<>"'()\[\]]+` +
    String.raw`|(?<!\w)(?:[a-z0-9-]+\.)+(?:com|pl|io|dev|org|net|eu|app|ai|co|me)\b(?:/[^\s<>"')\]]*)?`,
  "gi",
);
const VERSION = pyRegex(String.raw`\bv\d+(?:\.\d+)*\b|\b\d+(?:\.\d+){2,}(?:[-+][\w.]+)?\b`, "gi");
const THOUSANDS_SPACE = pyRegex(String.raw`(?<![\d.,])\d{1,3}(?:[   ]\d{3})+(?!\d)`, "g");
const NUMBER = /\d+(?:\.\d+)?/g;
const PL_DECIMAL = /(?<![\d,])(\d+),(\d+)(?!\d|,\d)/g;
const TRAILING_PUNCT = ".,;:!?";

type Multiset = Map<string, number>;

function pull(pattern: RegExp, text: string): [string[], string] {
  return [Array.from(text.matchAll(pattern), (m) => m[0]), text.replace(pattern, " ")];
}

function normUrl(url: string): string {
  return rstripChars(rstripChars(url, TRAILING_PUNCT).toLowerCase().replace(/^(?:https?:\/\/)?(?:www\.)?/, ""), "/");
}

function isThousands(version: string): boolean {
  const parts = version.split(".");
  return parts[0].length <= 3 && parts.slice(1).every((p) => p.length === 3 && /^\d+$/.test(p));
}

/** Like `pull` for version strings, but leaves Polish thousands ('1.250.000') in the text. */
function pullVersions(text: string): [string[], string] {
  const found: string[] = [];
  const rest = text.replace(VERSION, (m) => {
    if (isThousands(m)) return m;
    found.push(m);
    return " ";
  });
  return [found, rest];
}

const normNumber = (raw: string): string => (raw.includes(".") ? rstripChars(rstripChars(raw, "0"), ".") : raw);

function numbers(input: string, lang: string): Multiset {
  let text = input.replace(THOUSANDS_SPACE, (m) => m.replace(/\D/g, ""));
  if (lang === "en") {
    text = text.replace(/(?<=\d),(?=\d{3}(?!\d))/g, "");
  } else {
    text = text.replace(/(?<=\d)\.(?=\d{3}(?!\d))/g, "");
    text = text.replace(PL_DECIMAL, "$1.$2");
  }
  const out: Multiset = new Map();
  for (const raw of text.match(NUMBER) ?? []) {
    const n = normNumber(raw);
    out.set(n, (out.get(n) ?? 0) + 1);
  }
  return out;
}

/** Elements of `a` not covered by `b` (Counter subtraction), repeated per count. */
function multisetMinus(a: Multiset, b: Multiset): string[] {
  const out: string[] = [];
  for (const [n, count] of a) for (let i = 0; i < count - (b.get(n) ?? 0); i++) out.push(n);
  return out;
}

/** lowercase name -> is_tech, for tech terms and (outside title-case text) proper nouns. */
function namesOf(text: string): Map<string, boolean> {
  const title = tokens.isTitleCase(text);
  const out = new Map<string, boolean>();
  for (const tok of tokens.tokenize(text)) {
    if (/^\p{Nd}/u.test(tok.text)) continue;
    const key = tok.text.toLowerCase();
    if (tokens.isTech(tok.text)) {
      if (!out.has(key)) out.set(key, true);
    } else if (!title && tokens.isProperNoun(text, tok) && !out.has(key)) {
      out.set(key, false);
    }
  }
  return out;
}

/** Everything in one side that must be mirrored on the other. */
export class Facts {
  readonly emails: Set<string>;
  readonly urls: Set<string>;
  readonly versions: Set<string>;
  readonly numbers: Multiset;
  readonly words: Set<string>;
  readonly names: Map<string, boolean>;

  constructor(text: string, lang: string) {
    const [emails, afterEmails] = pull(EMAIL, text);
    const [urls, afterUrls] = pull(URL_RE, afterEmails);
    const [versions, rest] = pullVersions(afterUrls);
    this.emails = new Set(emails.map((e) => e.toLowerCase()));
    this.urls = new Set(urls.map(normUrl));
    this.versions = new Set(versions.map((v) => v.toLowerCase()));
    this.numbers = numbers(rest, lang);
    this.words = new Set(tokens.tokenize(rest).map((t) => t.text.toLowerCase()));
    this.names = namesOf(rest);
  }
}

/** Equal up to inflection/transliteration: shared prefix of all but ~2 letters. */
function sameName(a: string, b: string): boolean {
  if (a === b) return true;
  const m = Math.min(a.length, b.length);
  let common = 0;
  while (common < m && a[common] === b[common]) common += 1;
  return m >= 3 && common >= Math.max(3, m - 2);
}

function missingNames(src: Map<string, boolean>, otherWords: Set<string>): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const [name, isTech] of src) {
    let found = false;
    for (const w of otherWords) {
      if (sameName(name, w)) {
        found = true;
        break;
      }
    }
    if (!found) out.set(name, isTech);
  }
  return out;
}

const sortStrings = (values: Iterable<string>): string[] => Array.from(values).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const otherSide = (label: "PL" | "EN"): "PL" | "EN" => (label === "PL" ? "EN" : "PL");

function untranslated(pl: string, en: string): Finding[] {
  const norm = (t: string): string => t.replace(/\s+/g, " ").trim().toLowerCase().replace(/ß/g, "ss");
  if (norm(pl) !== norm(en)) return [];
  const prose = tokens
    .tokenize(pl)
    .filter((t) => /^\p{L}+$/u.test(t.text) && t.text.length >= 3 && !TECH_TERMS.has(t.text.toLowerCase()) && !tokens.isProperNoun(pl, t) && !tokens.isTech(t.text));
  if (prose.length < UNTRANSLATED_MIN_PROSE_WORDS) return []; // names, tech stacks and URLs legitimately read the same in both languages
  return [
    finding("tr-untranslated", "warn", "PL and EN text are identical: one side looks like an untranslated copy.", "Translate the side that is in the wrong language."),
  ];
}

function compareNumbers(pl: Facts, en: Facts): Finding[] {
  const out: Finding[] = [];
  for (const [label, src, dst] of [["PL", pl, en], ["EN", en, pl]] as const) {
    const missing = multisetMinus(src.numbers, dst.numbers).sort((a, b) => Number(a) - Number(b));
    if (missing.length === 0) continue;
    // a lone small integer with no digits on the other side is probably spelled out ("two")
    const soft = dst.numbers.size === 0 && missing.every((n) => !n.includes(".") && Number(n) <= 10);
    out.push(
      finding(
        "tr-number",
        soft ? "warn" : "error",
        `Number(s) ${missing.join(", ")} in ${label} not found in ${otherSide(label)}.`,
        "Numbers must match across languages. Check the source of truth with the user; never adjust a figure to make the sides agree.",
      ),
    );
  }
  return out;
}

function compareSets(rule: string, noun: string, pl: Set<string>, en: Set<string>): Finding[] {
  const out: Finding[] = [];
  for (const [label, only] of [["PL", [...pl].filter((x) => !en.has(x))], ["EN", [...en].filter((x) => !pl.has(x))]] as const) {
    if (only.length) {
      out.push(finding(rule, "error", `${noun} ${sortStrings(only).join(", ")} in ${label} but not in ${otherSide(label)}.`, `Copy the ${noun.toLowerCase()} to both sides verbatim.`));
    }
  }
  return out;
}

const TECH_SEVERITY: readonly (readonly [boolean, Severity])[] = [[true, "warn"], [false, "info"]];

function compareNames(pl: Facts, en: Facts): Finding[] {
  const out: Finding[] = [];
  for (const [label, src, dst] of [["PL", pl, en], ["EN", en, pl]] as const) {
    const missing = missingNames(src.names, dst.words);
    for (const [isTech, severity] of TECH_SEVERITY) {
      const group = sortStrings([...missing].filter(([, t]) => t === isTech).map(([n]) => n));
      if (group.length) {
        out.push(
          finding(
            "tr-name",
            severity,
            `${isTech ? "Tech term(s)" : "Proper noun(s)"} ${group.join(", ")} in ${label} not found in ${otherSide(label)}.`,
            "Names and tech terms normally appear on both sides. Translated institution names are fine; add the term if it was dropped.",
          ),
        );
      }
    }
  }
  return out;
}

/** Python-style `f"{x:.1f}"`: round half to even on exact ties (JS toFixed rounds them up). */
function fixed1(x: number): string {
  const scaled = x * 10;
  const floor = Math.floor(scaled);
  if (scaled - floor === 0.5) return ((floor % 2 === 0 ? floor : floor + 1) / 10).toFixed(1);
  return x.toFixed(1);
}

/** Compare the PL and EN versions of one field. Findings never say which side is "right". */
export function checkPair(pl: string, en: string): Finding[] {
  const plBlank = !pl.trim();
  const enBlank = !en.trim();
  if (plBlank && enBlank) return [];
  if (plBlank !== enBlank) {
    const [empty, full] = plBlank ? ["PL", "EN"] : ["EN", "PL"];
    return [finding("tr-missing", "warn", `${empty} side is empty while ${full} has text.`, `Translate the ${full} text into ${empty}.`)];
  }

  const pf = new Facts(pl, "pl");
  const ef = new Facts(en, "en");
  const out = [
    ...untranslated(pl, en),
    ...compareNumbers(pf, ef),
    ...compareSets("tr-url", "URL", pf.urls, ef.urls),
    ...compareSets("tr-email", "Email", pf.emails, ef.emails),
    ...compareSets("tr-version", "Version", pf.versions, ef.versions),
    ...compareNames(pf, ef),
  ];

  const lp = pl.trim().length;
  const le = en.trim().length;
  const longer = Math.max(lp, le);
  const shorter = Math.min(lp, le);
  if (longer >= LENGTH_RATIO_MIN_CHARS && longer / shorter > LENGTH_RATIO_WARN) {
    out.push(
      finding(
        "tr-length",
        "warn",
        `${lp > le ? "PL" : "EN"} is ${fixed1(longer / shorter)}x longer than the other side (${lp} vs ${le} chars): content may be missing or added.`,
        "Compare both sides sentence by sentence.",
      ),
    );
  }

  for (const entry of glossaryMismatches(pl, en)) {
    out.push(
      finding(
        "tr-glossary",
        "info",
        `PL '${entry.pl}' is usually '${entry.en}' in EN (accepted: ${entry.accept.join(", ")}); none found.`,
        "Use the glossary rendering unless the sentence needs a different sense.",
      ),
    );
  }
  return out;
}

/**
 * Facts present in `before` but gone from `after` (numbers, URLs, emails, versions, names).
 * Used to warn when a rewrite of the same-language text silently loses a hard fact.
 * Plain-word omissions (e.g. "private", "from scratch") are invisible to this check.
 */
export function droppedFacts(before: string, after: string, lang: string): string[] {
  const old = new Facts(before, lang);
  const next = new Facts(after, lang);
  return [
    ...multisetMinus(old.numbers, next.numbers).map((n) => `number ${n}`),
    ...sortStrings([...old.urls].filter((u) => !next.urls.has(u))).map((u) => `url ${u}`),
    ...sortStrings([...old.emails].filter((e) => !next.emails.has(e))).map((e) => `email ${e}`),
    ...sortStrings([...old.versions].filter((v) => !next.versions.has(v))).map((v) => `version ${v}`),
    ...[...missingNames(old.names, next.words).keys()].map((n) => `name ${n}`),
  ];
}
