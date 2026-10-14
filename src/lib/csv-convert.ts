/** CSV / TSV to JSON for the CSV workbench's first tab. Pure: runs inline for small text and in csv-convert.worker.ts for large text. */
import { parseDelimited } from "./delimited";

export interface CsvConvertInput {
  text: string;
  delimiter: string;
  hasHeader: boolean;
}

export interface CsvConvertOutput {
  /** False when the text is blank: the tool shows no stats, no preview and the placeholder. */
  parsed: boolean;
  /** Data rows (header excluded when `hasHeader`). */
  dataRows: number;
  columns: number;
  cells: number;
  /** The whole pretty-printed JSON, for Copy / Save .json. */
  json: string;
  /** The header cells shown above the preview table (generated `column_n` names without a header row). */
  header: string[];
  /** The first `PREVIEW_ROWS` data rows. */
  previewRows: string[][];
}

/** Text above this many characters is converted in the worker. */
export const CSV_CONVERT_INLINE_LIMIT = 100_000;
/** The preview table shows this many data rows. */
export const PREVIEW_ROWS = 200;
/** The JSON pane renders at most this many characters; Copy / Save use the whole JSON. */
export const JSON_PANE_LIMIT = 500_000;

export type CsvConvertTasks = { convert: { payload: CsvConvertInput; result: CsvConvertOutput } };

const EMPTY: CsvConvertOutput = { parsed: false, dataRows: 0, columns: 0, cells: 0, json: "[]", header: [], previewRows: [] };

/**
 * One unique JSON key per column position. A blank header cell becomes `column_N`, a repeated name gets `_2`, `_3`…, and cells
 * beyond the header's width get `column_N` too: assigning by name alone silently drops values (`a,a,b` kept only the last `a`,
 * and cells past the header vanished).
 */
export function columnKeys(header: string[], width: number): string[] {
  const used = new Set<string>();
  return Array.from({ length: width }, (_, index) => {
    const base = header[index] || `column_${index + 1}`;
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
    used.add(key);
    return key;
  });
}

function toObjects(rows: string[][], keys: string[]): Record<string, string>[] {
  return rows.slice(1).map((row) => Object.fromEntries(keys.map((key, index) => [key, row[index] ?? ""])));
}

export function convertCsv({ text, delimiter, hasHeader }: CsvConvertInput): CsvConvertOutput {
  // A BOM at the very start (pasted, or from a file read as text) would stay glued to the first header name.
  const rows = text.trim() ? parseDelimited(text.replace(/^﻿/, ""), delimiter) : [];
  if (rows.length === 0) return EMPTY;
  let columns = 0;
  let cells = 0;
  for (const row of rows) {
    if (row.length > columns) columns = row.length;
    cells += row.length;
  }
  const keys = hasHeader ? columnKeys(rows[0], columns) : Array.from({ length: columns }, (_, i) => `column_${i + 1}`);
  const shaped = hasHeader
    ? toObjects(rows, keys)
    : rows.map((row, index) => Object.fromEntries(row.map((cell, cellIndex) => [`column_${cellIndex + 1}`, cell]).concat([["row", String(index + 1)]])));
  const body = hasHeader ? rows.slice(1) : rows;
  return {
    parsed: true,
    dataRows: rows.length - (hasHeader ? 1 : 0),
    columns,
    cells,
    json: JSON.stringify(shaped, null, 2),
    header: keys,
    previewRows: body.slice(0, PREVIEW_ROWS),
  };
}
