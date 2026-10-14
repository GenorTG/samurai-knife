/**
 * View model of the Diff tool. Pure: runs inline for small inputs and in diff-view.worker.ts for large ones.
 * The worker returns rows as raw line pairs (cheap to clone); the word-level marks are rebuilt from them for the rows that
 * are on screen (`expandRow` gives exactly what `diffRows` gave), so a 2,000-row diff never builds a million word objects.
 */
import { computeDiff, wordMarks, type DiffRow, type MarkedWord } from "./diff";

export interface DiffViewInput {
  left: string;
  right: string;
}

export interface CompactRow {
  kind: DiffRow["kind"];
  left: string;
  right: string;
}

export interface DiffViewResult {
  ok: boolean;
  error?: string;
  rows: CompactRow[];
  patch: string;
  added: number;
  removed: number;
  unchanged: number;
}

export type DiffViewTasks = { diff: { payload: DiffViewInput; result: DiffViewResult } };

/** Inputs up to this many lines per side and characters in total are diffed inline. */
export const DIFF_INLINE_LINES = 400;
export const DIFF_INLINE_CHARS = 100_000;
/** Rendering budget per page of rows (see `rowsWithin`); each "Show more rows" adds one more page. */
export const DIFF_PAGE_BUDGET = 1_500;
/** The unified patch view renders at most this many characters; Copy patch / Download use the whole patch. */
export const DIFF_PATCH_PREVIEW = 200_000;

const joinWords = (words: MarkedWord[]): string => words.map((entry) => entry.word).join("");

export function computeDiffView({ left, right }: DiffViewInput): DiffViewResult {
  const result = computeDiff(left, right);
  if (!result.ok) return { ok: false, error: result.error, rows: [], patch: "", added: 0, removed: 0, unchanged: 0 };
  const rows = result.rows.map((row): CompactRow => ({ kind: row.kind, left: joinWords(row.left), right: joinWords(row.right) }));
  return { ok: true, rows, patch: result.patch, added: result.added, removed: result.removed, unchanged: result.unchanged };
}

/** Rebuild the `DiffRow` (with word marks) that `diffRows` produced for this compact row. */
export function expandRow({ kind, left, right }: CompactRow): DiffRow {
  if (kind === "same") return { kind, left: [{ word: left, mark: false }], right: [{ word: right, mark: false }] };
  if (kind === "del") return { kind, left: [{ word: left, mark: true }], right: [] };
  if (kind === "ins") return { kind, left: [], right: [{ word: right, mark: true }] };
  return { kind, ...wordMarks(left, right) };
}

/** Line count without allocating one string per line. */
export function countLines(text: string): number {
  let count = 1;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) count += 1;
  return count;
}

/** Roughly one unit per DOM element: an unchanged row costs 1, a changed row costs one per ~8 characters (one span per word and gap). */
function rowCost({ kind, left, right }: CompactRow): number {
  return kind === "same" ? 1 : 1 + (left.length + right.length) / 8;
}

/** How many leading rows fit in `budget` render units (always at least one). */
export function rowsWithin(rows: CompactRow[], budget: number): number {
  let spent = 0;
  for (let index = 0; index < rows.length; index += 1) {
    spent += rowCost(rows[index]);
    if (spent > budget) return Math.max(1, index);
  }
  return rows.length;
}
