import type { CvLang } from "../schema";

/**
 * Typographic polish for CV prose. Pure string functions (no DOM, no Intl).
 *
 * - Polish: a single-letter word (i a o u w z) is bound to the next word with a no-break space, so it never dangles
 *   at the end of a line.
 * - Dashes: spaced hyphen ` - ` and year / `MM.YYYY` ranges become en dashes.
 * - Quotes: straight quotes become curly (Polish „…”, English “…”); apostrophes become ’.
 */

export const NBSP = " ";
export const EN_DASH = "–";
const EM_DASH = "—";

const SINGLE_LETTER = /(?<![\p{L}\p{N}_.])([iaouwzIAOUWZ]) +(?=\S)/gu;
const SPACED_HYPHEN = /(?<=\S) +(?:-|--) +(?=\S)/g;
const YEAR_RANGE = /\b((?:19|20)\d{2})\s?-\s?((?:19|20)\d{2})\b/g;
const MONTH_RANGE = /\b(\d{2}\.\d{4})\s?-\s?(\d{2}\.\d{4})\b/g;
const APOSTROPHE = /(?<=[\p{L}\p{N}])'(?=[\p{L}\p{N}])/gu;

/** double open, double close, single open, single close */
const QUOTES: Record<CvLang, readonly [string, string, string, string]> = {
  pl: ["„", "”", "‚", "’"],
  en: ["“", "”", "‘", "’"],
};

function curlyQuotes(text: string, lang: CvLang): string {
  const [doubleOpen, doubleClose, singleOpen, singleClose] = QUOTES[lang];
  const chars = Array.from(text.replace(APOSTROPHE, "’"));
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch !== '"' && ch !== "'") continue;
    const prev = i > 0 ? chars[i - 1] : "";
    const opening = prev === "" || /\s/u.test(prev) || "([{/".includes(prev) || prev === EN_DASH || prev === EM_DASH;
    chars[i] = ch === '"' ? (opening ? doubleOpen : doubleClose) : opening ? singleOpen : singleClose;
  }
  return chars.join("");
}

/**
 * Apply the typography rules to one prose string. `nbsp: false` skips the no-break spaces: some ATS parsers do not
 * treat U+00A0 as whitespace, so the DOCX path keeps plain spaces and only gets dashes and quotes.
 */
export function typeset(text: string, lang: CvLang, options: { nbsp?: boolean } = {}): string {
  if (!text) return text;
  const nbsp = options.nbsp ?? true;
  let out = text.replaceAll("...", "…");
  out = out.replace(YEAR_RANGE, `$1${EN_DASH}$2`).replace(MONTH_RANGE, `$1${EN_DASH}$2`);
  out = out.replace(SPACED_HYPHEN, ` ${EN_DASH} `);
  out = curlyQuotes(out, lang);
  if (nbsp && lang === "pl") out = out.replace(SINGLE_LETTER, `$1${NBSP}`);
  return out;
}
