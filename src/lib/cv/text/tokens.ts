import { isAlpha, startsUpper, startsWithDigit } from "./regex";
import { NAME_EXCLUDE, TECH_TERMS } from "./vocab";

/** Tokenising helpers: tech-term detection, sentence starts, proper-noun heuristics. */

// word, optionally joined by . / - (Node.js, CI/CD), optionally trailing + or # (C++, C#)
const TOKEN = /[\p{L}\p{N}]+(?:[./-][\p{L}\p{N}]+)*[+#]*|[+#]+/gu;
const ALLCAPS = /^[A-Z][A-Z0-9]+$/;
const CAMEL = /[a-z][A-Z]/;
const DOTTED = /[.+#][\p{L}\p{N}_]{2,}|\+\+|#/u;
const BULLET_MARKS = "-–—•*·▪●";
const OPENERS = " \t \"'“„‘(";

export interface Tok {
  text: string;
  start: number;
  end: number;
}

export function tokenize(text: string): Tok[] {
  return Array.from(text.matchAll(TOKEN), (m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
}

function isTechAtom(atom: string): boolean {
  return TECH_TERMS.has(atom.toLowerCase()) || ALLCAPS.test(atom) || CAMEL.test(atom);
}

/** Tech name or acronym: Docker, API, CI/CD, Node.js, C++, gRPC, PostgreSQL-ish camel case. */
export function isTech(token: string): boolean {
  if (startsWithDigit(token) || NAME_EXCLUDE.has(token.toLowerCase())) return false;
  if (DOTTED.test(token) && !token.endsWith(".")) return true;
  return token.split(/[/-]/).some((part) => part !== "" && isTechAtom(part));
}

export function isSentenceStart(text: string, pos: number): boolean {
  let end = pos;
  while (end > 0 && OPENERS.includes(text[end - 1])) end -= 1;
  if (end === 0) return true;
  const last = text[end - 1];
  return ".!?:\n".includes(last) || BULLET_MARKS.includes(last);
}

/** Most words capitalised (a role title, a heading): capitals carry no proper-noun signal. */
export function isTitleCase(text: string): boolean {
  const words = tokenize(text).map((t) => t.text).filter(isAlpha);
  return words.length >= 2 && words.filter(startsUpper).length / words.length >= 0.6;
}

/** Capitalised mid-sentence word that is not a tech term, month/day or language name. */
export function isProperNoun(text: string, tok: Tok): boolean {
  const w = tok.text;
  return w.length >= 2 && startsUpper(w) && !isTech(w) && !NAME_EXCLUDE.has(w.toLowerCase()) && !isSentenceStart(text, tok.start);
}
