/**
 * Python-`re` flavoured regex helper. The word lists and rules were prototyped in Python, where `\w` and `\b`
 * are Unicode-aware; in JavaScript they are ASCII-only even with the `u` flag, which would break every Polish
 * word. `pyRegex` rewrites `\w`, `\W` and `\b` (outside character classes; `\w` inside) to Unicode property
 * equivalents and always sets the `u` flag.
 */

const WORD_CLASS = "\\p{L}\\p{N}_";
export const WORD = `[${WORD_CLASS}]`;
const NON_WORD = `[^${WORD_CLASS}]`;
export const WORD_BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;

export function pyRegex(source: string, flags = ""): RegExp {
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\" && i + 1 < source.length) {
      const next = source[i + 1];
      i += 1;
      if (next === "w") out += inClass ? WORD_CLASS : WORD;
      else if (next === "W" && !inClass) out += NON_WORD;
      else if (next === "b" && !inClass) out += WORD_BOUNDARY;
      else out += `\\${next}`;
      continue;
    }
    if (ch === "[" && !inClass) inClass = true;
    else if (ch === "]" && inClass) inClass = false;
    out += ch;
  }
  return new RegExp(out, flags.includes("u") ? flags : `${flags}u`);
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Python `str.rstrip(chars)` for a set of characters. */
export function rstripChars(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

/** Python `str.isalpha()` for a non-empty token. */
export function isAlpha(text: string): boolean {
  return /^\p{L}+$/u.test(text);
}
export const startsWithDigit = (text: string): boolean => /^\p{Nd}/u.test(text);
export const startsUpper = (text: string): boolean => /^\p{Lu}/u.test(text);
export const startsLower = (text: string): boolean => /^\p{Ll}/u.test(text);
