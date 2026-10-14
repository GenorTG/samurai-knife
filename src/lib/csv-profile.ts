/** Column profile of a CSV/TSV sample. Pure: runs inline for small text and in csv-profile.worker.ts for large text. */
import { parseDelimited } from "./delimited";

export interface CsvProfileInput {
  text: string;
  delimiter: string;
}

export interface ColumnProfile {
  name: string;
  type: string;
  missing: number;
  unique: number;
  rows: number;
}

export interface CsvProfileOutput {
  profiles: ColumnProfile[];
}

/** Text above this many characters is profiled in the worker. */
export const CSV_PROFILE_INLINE_LIMIT = 100_000;

export type CsvProfileTasks = { profile: { payload: CsvProfileInput; result: CsvProfileOutput } };

function guessType(values: string[]): string {
  const present = values.filter((value) => value.trim() !== "");
  if (!present.length) return "empty";
  if (present.every((value) => /^(true|false)$/i.test(value))) return "boolean";
  if (present.every((value) => value.trim() !== "" && Number.isFinite(Number(value)))) return "number";
  if (present.every((value) => /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value) && !Number.isNaN(Date.parse(value)))) return "date";
  return "text";
}

export function profileCsv({ text, delimiter }: CsvProfileInput): CsvProfileOutput {
  const rows = parseDelimited(text, delimiter);
  const header = rows[0] ?? [];
  const profiles = header.map((name, index) => {
    const values = rows.slice(1).map((row) => row[index] ?? "");
    const present = values.filter((value) => value.trim() !== "");
    return { name: name || `Column ${index + 1}`, type: guessType(values), missing: values.length - present.length, unique: new Set(present).size, rows: values.length };
  });
  return { profiles };
}
