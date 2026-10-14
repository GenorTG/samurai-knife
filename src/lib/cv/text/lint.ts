import type { CvLang } from "../schema";
import { finding, type Finding } from "./findings";
import { pyRegex, startsLower } from "./regex";
import * as tokens from "./tokens";
import { EN_STOP, PL_DIACRITICS, PL_STOP, TECH_TERMS } from "./vocab";

/**
 * Deterministic lint for Polish and English CV text. Rules only *find* problems; rewriting is the model's job.
 * Every rule is a function `(text, lang, kind) -> Finding[]` registered in `RULES`; list-level rules live in `lintList`.
 */

export type TextKind = "bullet" | "summary" | "paragraph";
type Rule = (text: string, lang: CvLang, kind: TextKind) => Finding[];

export const LONG_BULLET_WARN = 28;
export const LONG_BULLET_INFO = 20;
export const MIN_DIACRITIC_CHARS = 40;

const URL_OR_EMAIL = pyRegex(String.raw`\S+@\S+|(?:https?://|www\.)\S+`, "g");
const WORD_RE = /\p{L}+/gu;
const LEAD = /^[\s\-–—•*·▪●]*/u;
const SENTENCE_END = /[.!?…]\s+/gu;

function sentenceStarts(text: string): number[] {
  const lead = LEAD.exec(text);
  return [lead ? lead[0].length : 0, ...Array.from(text.matchAll(SENTENCE_END), (m) => m.index + m[0].length)];
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((t) => /[\p{L}\p{N}_]/u.test(t)).length;
}

const span = (m: RegExpMatchArray | RegExpExecArray): [number, number] => [m.index ?? 0, (m.index ?? 0) + m[0].length];

/** Same-length blanking so offsets into the result are offsets into `text`. */
const blankUrls = (text: string): string => text.replace(URL_OR_EMAIL, (m) => " ".repeat(m.length));

// --- vague openers ---------------------------------------------------------------------------------------------

const WEAK: Record<CvLang, RegExp> = {
  en: pyRegex(
    String.raw`(?:i\s+(?:was|am|have\s+been)\s+)?(?:(?:primarily|mainly|mostly|also)\s+)?` +
      String.raw`(?:responsible\s+for|worked\s+on|helped\s+(?:with|to)|assisted\s+(?:with|in)` +
      String.raw`|in\s+charge\s+of|involved\s+in|participated\s+in|tasked\s+with` +
      String.raw`|(?:duties|responsibilities)\s+included)\b`,
    "iy",
  ),
  pl: pyRegex(
    String.raw`(?:by[łl](?:em|am)\s+)?(?:odpowiedzialn\w*\s+za` +
      String.raw`|zajmowa[łl](?:em|am)\s+si[ęe]|zajmuj[ęe]\s+si[ęe]` +
      String.raw`|bra[łl](?:em|am)\s+udzia[łl]\s+w|uczestniczy[łl](?:em|am)\s+w` +
      String.raw`|pomaga[łl](?:em|am)\s+(?:w|przy|z)|pracowa[łl](?:em|am)\s+nad)\b`,
    "iy",
  ),
};

function weakOpener(text: string, lang: CvLang): Finding[] {
  const out: Finding[] = [];
  const re = WEAK[lang];
  for (const start of sentenceStarts(text)) {
    re.lastIndex = start;
    const m = re.exec(text);
    if (m) {
      out.push(
        finding(
          "weak-opener",
          "warn",
          `Vague opener '${m[0].trim()}' names a duty, not what was done.`,
          "Open with a strong past-tense verb and the outcome (EN 'Built…', 'Cut…'; PL 'Zbudowałem…', 'Skróciłem…'). Keep only facts you can back up.",
          span(m),
        ),
      );
    }
  }
  return out;
}

// --- buzzwords -------------------------------------------------------------------------------------------------

// [pattern, context that makes the match legitimate: searched in a ±24-char window]
type BuzzSpec = readonly [string, string | null];
const BUZZ_SPECS: Record<CvLang, readonly BuzzSpec[]> = {
  en: [
    [String.raw`team[\s-]player`, null],
    [
      "dynamic",
      String.raw`dynamic\s+(?:programming|typing|dispatch|sql|array|memory|routing|content|import` +
        String.raw`|linking|librar\w+|languages?|quer\w+|pricing|dns|forms?|pages?|rendering` +
        String.raw`|config\w*|dashboards?|reports?)`,
    ],
    ["passionate", null],
    [String.raw`results?[\s-](?:driven|oriented)`, null],
    [String.raw`self[\s-]motivated`, null],
    [String.raw`hard[\s-]?working`, null],
    [String.raw`detail[\s-]oriented`, null],
    [String.raw`go[\s-]getter`, null],
    [String.raw`synerg(?:y|ies)`, null],
    [String.raw`think(?:ing)?\s+outside\s+the\s+box`, null],
    [String.raw`proven\s+track\s+record`, null],
    ["enthusiastic", null],
    ["creative", String.raw`creative\s+(?:coding|commons|suite|cloud)`],
  ],
  pl: [
    [String.raw`team[\s-]player`, null],
    [
      String.raw`dynamiczn\w*`,
      String.raw`programowani\w*\s+dynamiczn|dynamiczn\w*\s+(?:programowani\w*|typowani\w*|routing\w*` +
        String.raw`|stron\w*|tre[śs]\w*|zmienn\w*|alokacj\w*|dns)`,
    ],
    [String.raw`zaanga[żz]owan\w*`, String.raw`zaanga[żz]owan\w*\s+w\b`],
    [String.raw`kreatywn\w*`, null],
    [String.raw`komunikatywn\w*`, null],
    [String.raw`pasjonat\w*`, null],
    [String.raw`ambitn\w*`, null],
    [String.raw`sumienn\w*`, null],
    [String.raw`pracowit\w*`, null],
    [String.raw`odporn\w*\s+na\s+stres`, null],
    [String.raw`zorientowan\w+\s+na\s+(?:wyniki|cele?)`, null],
  ],
};
const BUZZ: Record<CvLang, { pattern: RegExp; ignore: RegExp | null }[]> = {
  en: BUZZ_SPECS.en.map(([p, i]) => ({ pattern: pyRegex(String.raw`\b(?:${p})\b`, "gi"), ignore: i ? pyRegex(i, "i") : null })),
  pl: BUZZ_SPECS.pl.map(([p, i]) => ({ pattern: pyRegex(String.raw`\b(?:${p})\b`, "gi"), ignore: i ? pyRegex(i, "i") : null })),
};

function buzzword(text: string, lang: CvLang): Finding[] {
  const out: Finding[] = [];
  for (const { pattern, ignore } of BUZZ[lang]) {
    for (const m of text.matchAll(pattern)) {
      const start = m.index;
      const end = start + m[0].length;
      if (ignore?.test(text.slice(Math.max(0, start - 24), end + 24))) continue;
      out.push(finding("buzzword", "warn", `Buzzword '${m[0]}' claims a trait without evidence.`, "Show the trait through a concrete result, or drop the word.", [start, end]));
    }
  }
  return out;
}

// --- first person (EN bullets) ---------------------------------------------------------------------------------

const FIRST_PERSON = [
  pyRegex(String.raw`\bI(?:['’](?:m|ve|ll|d))?\b`, "g"), // case-sensitive: 'i' is not the pronoun
  pyRegex(String.raw`\b(?:my|me|myself|mine)\b`, "gi"),
];

function firstPerson(text: string, lang: CvLang, kind: TextKind): Finding[] {
  if (lang !== "en" || kind !== "bullet") return [];
  const hits = FIRST_PERSON.flatMap((p) => Array.from(text.matchAll(p))).sort((a, b) => a.index - b.index);
  if (hits.length === 0) return [];
  const words = Array.from(new Set(hits.map((m) => `'${m[0]}'`))).join(", ");
  return [finding("first-person", "warn", `First-person ${words} in an English bullet.`, "CV bullets drop the subject: start with the verb ('Built…', not 'I built…').", span(hits[0]))];
}

// --- length and substance (bullets) ----------------------------------------------------------------------------

function longBullet(text: string, _lang: CvLang, kind: TextKind): Finding[] {
  if (kind !== "bullet") return [];
  const n = wordCount(text);
  if (n <= LONG_BULLET_INFO) return [];
  return [
    finding(
      "long-bullet",
      n > LONG_BULLET_WARN ? "warn" : "info",
      `Bullet is ${n} words (aim for ≤${LONG_BULLET_INFO}).`,
      "Split into two bullets or cut context the reader does not need.",
    ),
  ];
}

function hasSignal(text: string): boolean {
  if (/\p{Nd}/u.test(text)) return true;
  return tokens.tokenize(text).some((t) => tokens.isTech(t.text) || tokens.isProperNoun(text, t));
}

function noSignal(text: string, _lang: CvLang, kind: TextKind): Finding[] {
  if (kind !== "bullet" || wordCount(text) < 3 || hasSignal(text)) return [];
  return [
    finding(
      "no-signal",
      "info",
      "No number, name or technology — the bullet is hard to verify or skim.",
      "Add one real, checkable detail: scale, technology or result. Never a made-up number.",
    ),
  ];
}

// --- typography ------------------------------------------------------------------------------------------------

const DOUBLE_SPACE = /(?<=\S) {2,}(?=\S)/gu;
const SPACE_BEFORE_PUNCT = pyRegex(String.raw`(?<=\S)[ \t]+(?=[,;:!?]|\.(?!\w))`, "g");
const CURLY = "“”‘’„‚";
const STRAIGHT = "\"'";

function aggregate(rule: string, matches: RegExpMatchArray[], label: string, hint: string): Finding[] {
  if (matches.length === 0) return [];
  const count = matches.length > 1 ? ` (${matches.length}x)` : "";
  return [finding(rule, "warn", label + count, hint, span(matches[0]))];
}

const doubleSpace = (text: string): Finding[] => aggregate("double-space", Array.from(text.matchAll(DOUBLE_SPACE)), "Double space.", "Use a single space.");

const spaceBeforePunct = (text: string): Finding[] =>
  aggregate("space-before-punct", Array.from(text.matchAll(SPACE_BEFORE_PUNCT)), "Space before punctuation.", "Remove the space before , ; : ! ? .");

function quoteMix(text: string, lang: CvLang): Finding[] {
  const has = (set: string): boolean => Array.from(set).some((c) => text.includes(c));
  if (!(has(STRAIGHT) && has(CURLY))) return [];
  const style = lang === "pl" ? "„…”" : "“…”";
  return [finding("quote-mix", "warn", "Straight and curly quotes/apostrophes are mixed.", `Pick one style and use it throughout (typographic ${style} for ${lang.toUpperCase()}).`)];
}

// --- language-specific -----------------------------------------------------------------------------------------

/** Words that belong to the *other* language: (matches, any-has-diacritic, total word count). */
function foreignHits(text: string, lang: CvLang): { hits: RegExpMatchArray[]; diacritic: boolean; total: number } {
  const otherStop = lang === "pl" ? EN_STOP : PL_STOP;
  const words = Array.from(blankUrls(text).matchAll(WORD_RE));
  const hits: RegExpMatchArray[] = [];
  let diacritic = false;
  for (const m of words) {
    const w = m[0];
    const lw = w.toLowerCase();
    if (TECH_TERMS.has(lw)) continue;
    if (otherStop.has(lw)) hits.push(m);
    else if (lang === "en" && startsLower(w) && Array.from(w).some((c) => PL_DIACRITICS.includes(c))) {
      hits.push(m);
      diacritic = true;
    }
  }
  return { hits, diacritic, total: words.length };
}

/** Function words that only Polish text has (PL_STOP leaves out the short ones it shares with English tokens). */
const POLISH_MARKERS: ReadonlySet<string> = new Set([...PL_STOP, "i", "w", "z", "ze", "do", "to", "lub", "czy", "ma", "mam", "dla", "nie"]);

function missingDiacritics(text: string, lang: CvLang): Finding[] {
  if (lang !== "pl") return [];
  const body = text.replace(URL_OR_EMAIL, " ").trim();
  if (body.length <= MIN_DIACRITIC_CHARS || Array.from(body).some((c) => PL_DIACRITICS.includes(c))) return [];
  const { hits, total } = foreignHits(body, "pl");
  if (total && hits.length / total > 0.25) return []; // it is English, not stripped Polish (see lang-mix)
  // Only text that is demonstrably Polish can have lost its diacritics: a job title or a product name has no Polish function words.
  const polishWords = Array.from(body.matchAll(WORD_RE)).filter((m) => POLISH_MARKERS.has(m[0].toLowerCase())).length;
  if (polishWords < 2) return [];
  return [
    finding(
      "missing-diacritics",
      "warn",
      `${body.length} characters of Polish text without a single ą/ć/ę/ł/ń/ó/ś/ź/ż.`,
      "Likely stripped diacritics: restore them (check any word you are unsure of).",
    ),
  ];
}

function langMix(text: string, lang: CvLang): Finding[] {
  const { hits, diacritic } = foreignHits(text, lang);
  if (hits.length < 2 && !diacritic) return [];
  const ownStop = lang === "pl" ? PL_STOP : EN_STOP;
  const own = Array.from(text.matchAll(WORD_RE)).filter((m) => ownStop.has(m[0].toLowerCase())).length;
  const other = lang === "pl" ? "English" : "Polish";
  const words = Array.from(new Set(hits.map((m) => `'${m[0]}'`))).join(", ");
  return [
    finding(
      "lang-mix",
      hits.length > own ? "warn" : "info",
      `Looks like ${other} inside a ${lang.toUpperCase()} field: ${words}.`,
      `Translate the ${other} fragment; tech terms and product names may stay.`,
      span(hits[0]),
    ),
  ];
}

const ORPHAN = pyRegex(String.raw`(?<![\w/\-])[aiouwzAIOUWZ] (?=[^\s.])`, "g");

function nbspOrphan(text: string, lang: CvLang): Finding[] {
  if (lang !== "pl") return [];
  const matches = Array.from(text.matchAll(ORPHAN));
  if (matches.length === 0) return [];
  const count = matches.length > 1 ? ` (${matches.length}x)` : "";
  return [
    finding(
      "nbsp-orphan",
      "info",
      `Single-letter word followed by a normal space can end a line${count}.`,
      "Use a non-breaking space (U+00A0) after a/i/o/u/w/z. The renderer can do this automatically.",
      span(matches[0]),
    ),
  ];
}

export const RULES: readonly Rule[] = [weakOpener, buzzword, firstPerson, longBullet, noSignal, doubleSpace, spaceBeforePunct, quoteMix, missingDiacritics, langMix, nbspOrphan];

/** Lint one text. `kind` selects bullet-only rules (first person, length, signal). */
export function lintText(text: string, lang: CvLang, kind: TextKind = "paragraph"): Finding[] {
  if (!text.trim()) return [];
  const found = RULES.flatMap((rule) => rule(text, lang, kind));
  const key = (f: Finding): number => f.span?.[0] ?? text.length + 1;
  return found.sort((a, b) => key(a) - key(b) || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}

// --- list-level rules ------------------------------------------------------------------------------------------

function firstWord(text: string): string {
  const m = /\p{L}+/u.exec(text);
  return m ? m[0].toLowerCase() : "";
}

/** Flag the minority style (ties flag the bullets without a period). */
function trailingPeriod(items: readonly string[]): Map<number, Finding> {
  const withPeriod: number[] = [];
  const without: number[] = [];
  items.forEach((t, i) => {
    if (!t.trim()) return;
    (t.trimEnd().endsWith(".") ? withPeriod : without).push(i);
  });
  if (withPeriod.length === 0 || without.length === 0) return new Map();
  const [minority, label] =
    withPeriod.length < without.length
      ? [withPeriod, "ends with a period but most bullets have none"]
      : [without, "has no final period but most bullets end with one"];
  return new Map(
    minority.map((i) => [i, finding("trailing-period", "warn", `Bullet ${label}.`, "Make the whole list consistent: all with or all without a final period.")]),
  );
}

function duplicateOpeners(items: readonly string[]): Map<number, Finding> {
  const out = new Map<number, Finding>();
  const heads = items.map(firstWord);
  let i = 0;
  while (i < heads.length) {
    let j = i;
    while (j + 1 < heads.length && heads[j + 1] === heads[i] && heads[i]) j += 1;
    if (j - i + 1 >= 3) {
      for (let k = i + 1; k <= j; k++) {
        out.set(k, finding("duplicate-opener", "warn", `Bullets ${i + 1}-${j + 1} all open with '${heads[i]}'.`, "Vary the opening verbs; keep every claim factual."));
      }
    }
    i = j + 1;
  }
  return out;
}

/** Lint a bullet list: per-bullet findings plus list-level consistency, one array per item. */
export function lintList(items: readonly string[], lang: CvLang): Finding[][] {
  const perItem = items.map((t) => lintText(t, lang, "bullet"));
  for (const extra of [trailingPeriod(items), duplicateOpeners(items)]) {
    for (const [idx, f] of extra) perItem[idx].push(f);
  }
  return perItem;
}
