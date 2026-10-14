/** Writing analysis (reading grade, sentence length, punctuation spacing). Pure: inline for small text, writing.worker.ts for large text. */

/** Text above this many characters is analysed in the worker. */
export const WRITING_INLINE_LIMIT = 100_000;
/** The sentence list renders at most this many rows and this many characters of sentence text (the stats cover every sentence). */
export const SENTENCE_ROWS_LIMIT = 1_000;
export const SENTENCE_TEXT_LIMIT = 200_000;
/** The findings box shows at most this many lines (the count and Copy findings cover every finding). */
export const FINDINGS_SHOWN_LIMIT = 2_000;

export interface GradeResult {
  count: number;
  sentenceCount: number;
  syllableCount: number;
  flesch: number;
  fk: number;
  fog: number;
}

export interface SentenceRow {
  index: number;
  words: number;
  text: string;
}

export interface SentencesResult {
  /** Total sentences, even when `rows` is capped. */
  total: number;
  rows: SentenceRow[];
  /** True when the last listed sentence was cut to fit `SENTENCE_TEXT_LIMIT`. */
  clipped: boolean;
  average: number;
  long: number;
}

export interface PunctuationResult {
  count: number;
  /** Every finding as `Line n: kind — excerpt`, for Copy findings. */
  output: string;
  /** The first `FINDINGS_SHOWN_LIMIT` lines of `output`. */
  shown: string;
}

export type WritingTasks = {
  grade: { payload: string; result: GradeResult | null };
  sentences: { payload: string; result: SentencesResult };
  punctuation: { payload: string; result: PunctuationResult };
};

function syllables(word: string): number {
  const clean = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!clean) return 0;
  if (clean.length <= 3) return 1;
  const groups = clean.match(/[aeiouy]+/g)?.length ?? 1;
  const silentE = /e$/.test(clean) && !/le$/.test(clean);
  return Math.max(1, groups - (silentE ? 1 : 0));
}

/** Words that end in a period without ending the sentence ("Dr. Smith"). Compared lower-case, without the period. */
const TITLE_ABBREVIATIONS = new Set(["dr", "mr", "mrs", "ms", "prof", "st", "vs"]);
/** Month abbreviations only count when a day number follows ("Jan. 5"). */
const MONTH_ABBREVIATIONS = new Set(["jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"]);
const MAX_ABBREVIATION_LENGTH = 6;
const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= "0" && ch <= "9";
const isBlank = (ch: string): boolean => /\s/.test(ch);

/**
 * True when the single "." at `index` does not end a sentence: a decimal point or version dot between digits ("3.50", "v1.2.3"),
 * a title or Latin abbreviation ("Dr.", "vs.", "e.g.", "a.m."), or a month abbreviation before a day number ("Jan. 5").
 * Everything else, including "Missing space.After", still ends one.
 */
function dotKeepsSentenceOpen(text: string, index: number): boolean {
  if (isDigit(text[index - 1]) && isDigit(text[index + 1])) return true;
  // The whitespace-delimited word around the dot, bounded so a huge unbroken paste stays cheap.
  let from = index;
  while (from > 0 && index - from < MAX_ABBREVIATION_LENGTH + 4 && !isBlank(text[from - 1])) from--;
  let to = index + 1;
  while (to < text.length && to - index < MAX_ABBREVIATION_LENGTH + 4 && !isBlank(text[to])) to++;
  const word = text.slice(from, to).replace(/^[("'“‘[]+|[)"'”’\],;:]+$/gu, "");
  // Initialisms: p.m. e.g. i.e. U.S.A. (at least two letter-dot pairs).
  if (/^(?:\p{L}\.){2,}\p{L}?$/u.test(word)) return true;
  const name = word.replace(/\.+$/, "").toLowerCase();
  if (name.length > MAX_ABBREVIATION_LENGTH || word.slice(name.length) !== ".") return false;
  if (TITLE_ABBREVIATIONS.has(name)) return true;
  return MONTH_ABBREVIATIONS.has(name) && /^\s+[0-9]/.test(text.slice(index + 1, index + 4));
}

/** Runs of ".", "!" and "?" that end a sentence, as [start, end) offsets. Shared by the sentence list and the reading-grade count. */
export function sentenceTerminators(text: string): [number, number][] {
  const found: [number, number][] = [];
  for (const match of text.matchAll(/[.!?]+/g)) {
    const start = match.index;
    if (match[0] === "." && dotKeepsSentenceOpen(text, start)) continue;
    found.push([start, start + match[0].length]);
  }
  return found;
}

export function gradeText(text: string): GradeResult | null {
  const words = text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) ?? [];
  const terminated = sentenceTerminators(text).length;
  const sentenceCount = Math.max(1, terminated || (words.length ? 1 : 0));
  const count = words.length;
  const syllableCount = words.reduce((sum, word) => sum + syllables(word), 0);
  if (!count) return null;
  const asl = count / sentenceCount;
  const asw = syllableCount / count;
  const flesch = 206.835 - 1.015 * asl - 84.6 * asw;
  const fk = 0.39 * asl + 11.8 * asw - 15.59;
  const complex = words.filter((word) => syllables(word) >= 3).length;
  const fog = 0.4 * (asl + (100 * complex) / count);
  return { count, sentenceCount, syllableCount, flesch, fk, fog };
}

export function analyzeSentences(text: string): SentencesResult {
  const pieces: string[] = [];
  let cut = 0;
  for (const [start, end] of sentenceTerminators(text)) {
    // A run right after a cut (leading "..." or a skipped abbreviation boundary) has no text of its own and is dropped.
    if (start > cut) pieces.push(text.slice(cut, end));
    cut = end;
  }
  pieces.push(text.slice(cut));
  const sentences = pieces.map((piece) => piece.trim()).filter(Boolean);
  const rows = sentences.map((sentence, index) => ({
    index: index + 1,
    words: (sentence.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).length,
    text: sentence,
  }));
  const total = rows.reduce((sum, row) => sum + row.words, 0);
  const listed: SentenceRow[] = [];
  let budget = SENTENCE_TEXT_LIMIT;
  let clipped = false;
  for (const row of rows.slice(0, SENTENCE_ROWS_LIMIT)) {
    if (budget <= 0) break;
    if (row.text.length > budget) {
      listed.push({ ...row, text: `${row.text.slice(0, budget)}…` });
      clipped = true;
      break;
    }
    listed.push(row);
    budget -= row.text.length;
  }
  return {
    total: rows.length,
    rows: listed,
    clipped,
    average: rows.length ? total / rows.length : 0,
    long: rows.filter((row) => row.words > 25).length,
  };
}

export function checkPunctuation(text: string): PunctuationResult {
  const found: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const add = (kind: string, match: RegExpMatchArray) => found.push(`Line ${index + 1}: ${kind} — ${match[0].replace(/\s/g, "·")}`);
    for (const match of line.matchAll(/\s+[,.!?;:]/g)) add("Whitespace before punctuation", match);
    for (const match of line.matchAll(/ {2,}/g)) add("Repeated spaces", match);
    for (const match of line.matchAll(/[.!?](?=[A-Za-z0-9])/g)) add("Possible missing space after sentence mark", match);
    for (const match of line.matchAll(/([!?])\1{2,}/g)) add("Repeated terminal punctuation", match);
  });
  return { count: found.length, output: found.join("\n"), shown: found.slice(0, FINDINGS_SHOWN_LIMIT).join("\n") };
}
