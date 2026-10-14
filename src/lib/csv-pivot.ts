/** Pivot arithmetic for the CSV pivot previewer. Pure, so it is unit-tested without a browser. */

export type PivotAggregation = "sum" | "count" | "average";

export interface PivotResult {
  rowKeys: string[];
  colKeys: string[];
  /** `cells[row][column]`, already formatted ("" = nothing to aggregate). */
  cells: string[][];
}

/**
 * The numeric values among raw cells. A blank or whitespace-only cell is "no value", not 0: `Number("")` and `Number("  ")` are
 * both 0 and finite, which used to inflate Count and drag Average down.
 */
export function numericValues(cells: Array<string | undefined>): number[] {
  return cells.filter((cell): cell is string => cell !== undefined && cell.trim() !== "").map(Number).filter(Number.isFinite);
}

/** `rows[0]` is the header; `ri`/`ci`/`vi` are the row-group, column-group and value column indexes. */
export function pivotTable(rows: string[][], ri: number, ci: number, vi: number, agg: PivotAggregation): PivotResult {
  const body = rows.slice(1);
  const rowKeys = [...new Set(body.map((row) => row[ri] ?? ""))];
  const colKeys = [...new Set(body.map((row) => row[ci] ?? ""))];
  const cells = rowKeys.map((r) =>
    colKeys.map((c) => {
      const values = numericValues(body.filter((row) => (row[ri] ?? "") === r && (row[ci] ?? "") === c).map((row) => row[vi]));
      if (agg === "count") return String(values.length);
      if (!values.length) return "";
      const sum = values.reduce((a, b) => a + b, 0);
      return String(agg === "average" ? Number((sum / values.length).toFixed(3)) : sum);
    }),
  );
  return { rowKeys, colKeys, cells };
}
