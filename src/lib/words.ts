/** Word frequency over free text. Pure: runs inline for small text and in words.worker.ts for large text. */

export interface WordsInput {
  text: string;
  minimum: number;
  order: "count" | "alpha";
}

export interface WordsOutput {
  /** The first `TOP_WORDS` rows by the chosen order. */
  top: [string, number][];
  total: number;
  unique: number;
  /** Every row as `word<TAB>count`, for the Copy TSV button. */
  tsv: string;
}

export const TOP_WORDS = 500;
/** Text above this many characters is counted in the worker. */
export const WORDS_INLINE_LIMIT = 200_000;

export type WordsTasks = { words: { payload: WordsInput; result: WordsOutput } };

export function countWords({ text, minimum, order }: WordsInput): WordsOutput {
  const counts = new Map<string, number>();
  for (const token of text.toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []) {
    if (token.length >= minimum) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const rows = [...counts].sort(([a, ac], [b, bc]) => (order === "alpha" ? a.localeCompare(b) : bc - ac || a.localeCompare(b)));
  const total = rows.reduce((sum, [, count]) => sum + count, 0);
  return { top: rows.slice(0, TOP_WORDS), total, unique: rows.length, tsv: rows.map(([word, count]) => `${word}\t${count}`).join("\n") };
}
