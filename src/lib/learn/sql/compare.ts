/**
 * Lesson checking: the learner's result set against the reference solution's. Pure (tests/learn_sql.test.mjs).
 *
 * Rules: the column COUNT must match; when both sides use the same column names (any order, case-insensitive) the
 * learner's columns are reordered to the reference's, otherwise columns are compared by position (names are the
 * learner's choice unless the lesson says `columnNames: "match"`). Rows are a multiset unless the lesson is ordered.
 * Values are normalised: numbers and numeric strings (Postgres sends numeric/bigint as text) compare rounded to
 * `decimals` places, everything else as its JSON text.
 */
import { translator, type Translator } from "@/lib/i18n/core";

export type Cell = string | number | boolean | null;

export interface ResultSet {
  columns: string[];
  rows: Cell[][];
}

export interface CompareOptions {
  /** Row order matters (the task asks for ORDER BY). */
  ordered: boolean;
  /** "ignore" (default): names are free; "match": the learner must use the reference's column names. */
  columnNames?: "ignore" | "match";
  /** Decimal places numbers are rounded to before comparing (default 2). */
  decimals?: number;
  /** Language of the feedback (default English). */
  tr?: Pick<Translator, "t" | "tn">;
}

export interface CompareResult {
  pass: boolean;
  /** One-paragraph explanation for the learner. */
  message: string;
  expectedRows: number;
  actualRows: number;
  /** Reference rows the learner's result lacks (multiset). */
  missing: number;
  /** Learner rows the reference does not have (multiset). */
  extra: number;
  columnProblem?: string;
  /** Ordered checks: first 0-based row index where the order differs. */
  firstOrderMismatch?: number;
  /** A few concrete differing rows (normalised text) to show. */
  examples: { missing: string[]; extra: string[] };
}

const MIDNIGHT = /^(\d{4}-\d{2}-\d{2})[ T]00:00:00(?:\.0+)?(?:Z|\+00(?::?00)?)?$/;
const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export function normalizeCell(value: Cell, decimals = 2): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || (typeof value === "string" && NUMERIC.test(value.trim()))) {
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(n)) {
      const rounded = Number(n.toFixed(decimals));
      return `n:${Object.is(rounded, -0) ? 0 : rounded}`;
    }
  }
  if (typeof value === "boolean") return `b:${value}`;
  // A date and the same day's midnight timestamp (date_trunc without ::date) are the same answer.
  const midnight = MIDNIGHT.exec(String(value));
  if (midnight) return `s:${midnight[1]}`;
  return `s:${String(value)}`;
}

function rowKey(row: Cell[], decimals: number): string {
  return JSON.stringify(row.map((cell) => normalizeCell(cell, decimals)));
}

function readable(row: Cell[]): string {
  return `(${row.map((cell) => (cell === null ? "NULL" : String(cell))).join(", ")})`;
}

function lower(names: string[]): string[] {
  return names.map((name) => name.toLowerCase());
}

/** Learner columns rearranged to the reference's order when the names are a permutation; else null. */
function columnOrder(expected: string[], actual: string[]): number[] | null {
  const want = lower(expected);
  const have = lower(actual);
  if (new Set(want).size !== want.length || new Set(have).size !== have.length) return null;
  const order = want.map((name) => have.indexOf(name));
  return order.every((index) => index >= 0) ? order : null;
}

export function compareResults(expected: ResultSet, actual: ResultSet, options: CompareOptions): CompareResult {
  const decimals = options.decimals ?? 2;
  const { t, tn } = options.tr ?? translator("en");
  const base = { expectedRows: expected.rows.length, actualRows: actual.rows.length, missing: 0, extra: 0, examples: { missing: [] as string[], extra: [] as string[] } };
  if (expected.columns.length !== actual.columns.length) {
    const columnProblem = tn("Expected {n} column ({names}), your query returned {got} ({gotNames}).", "Expected {n} columns ({names}), your query returned {got} ({gotNames}).", expected.columns.length, { names: expected.columns.join(", "), got: actual.columns.length, gotNames: actual.columns.join(", ") || t("none") });
    return { ...base, pass: false, columnProblem, message: columnProblem };
  }
  const order = columnOrder(expected.columns, actual.columns);
  if (options.columnNames === "match" && !order) {
    const columnProblem = t("Name the columns {names} (use AS); yours are {got}.", { names: expected.columns.join(", "), got: actual.columns.join(", ") });
    return { ...base, pass: false, columnProblem, message: columnProblem };
  }
  const rows = order ? actual.rows.map((row) => order.map((index) => row[index])) : actual.rows;
  const wantKeys = expected.rows.map((row) => rowKey(row, decimals));
  const haveKeys = rows.map((row) => rowKey(row, decimals));

  const counts = new Map<string, number>();
  for (const key of wantKeys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const extraIdx: number[] = [];
  haveKeys.forEach((key, index) => {
    const left = counts.get(key) ?? 0;
    if (left > 0) counts.set(key, left - 1);
    else extraIdx.push(index);
  });
  const missingIdx: number[] = [];
  const remaining = new Map(counts);
  wantKeys.forEach((key, index) => {
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      missingIdx.push(index);
    }
  });
  const missing = missingIdx.length;
  const extra = extraIdx.length;
  const examples = {
    missing: missingIdx.slice(0, 3).map((index) => readable(expected.rows[index])),
    extra: extraIdx.slice(0, 3).map((index) => readable(rows[index])),
  };
  const result: CompareResult = { ...base, missing, extra, examples, pass: missing === 0 && extra === 0, message: "" };

  if (!result.pass) {
    const parts = [tn("Your query returned {n} row, the expected result has {expected}.", "Your query returned {n} rows, the expected result has {expected}.", actual.rows.length, { expected: expected.rows.length })];
    if (missing) parts.push(tn("{n} expected row is missing.", "{n} expected rows are missing.", missing));
    if (extra) parts.push(tn("{n} row is not in the expected result.", "{n} rows are not in the expected result.", extra));
    if (!order && expected.columns.length > 1) parts.push(t("Columns are compared by position: check their order."));
    result.message = parts.join(" ");
    return result;
  }
  if (options.ordered) {
    const mismatch = wantKeys.findIndex((key, index) => key !== haveKeys[index]);
    if (mismatch >= 0) {
      return {
        ...result,
        pass: false,
        firstOrderMismatch: mismatch,
        message: t("The rows are right but the order is not: row {row} should be {want}, yours is {got}. Check ORDER BY.", { row: mismatch + 1, want: readable(expected.rows[mismatch]), got: readable(rows[mismatch]) }),
      };
    }
  }
  result.message = options.ordered
    ? tn("Correct: {n} row matches the expected result in the right order.", "Correct: {n} rows match the expected result in the right order.", expected.rows.length)
    : tn("Correct: {n} row matches the expected result.", "Correct: {n} rows match the expected result.", expected.rows.length);
  return result;
}
