/** NDJSON validation: one JSON value per line. Pure: runs inline for small input and in ndjson.worker.ts for large input. */

export interface NdjsonResult {
  valid: number;
  invalid: number;
  /** Every error as `Line N: message`, newline-joined (what Copy errors copies). */
  errorText: string;
  /** What the panel shows: all of `errorText` for small input, the first `NDJSON_SHOWN_ERRORS` lines for large input. */
  shownText: string;
}

export type NdjsonTasks = { validate: { payload: string; result: NdjsonResult } };

/** Input above this many characters is validated in the worker (and its error list is shortened on screen). */
export const NDJSON_INLINE_LIMIT = 100_000;
/** Large input only: rendering tens of thousands of error lines costs more than parsing the records. */
export const NDJSON_SHOWN_ERRORS = 200;

export function validateNdjson(input: string): NdjsonResult {
  let valid = 0;
  const errors: string[] = [];
  input.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try { JSON.parse(line); valid += 1; }
    catch (error) { errors.push(`Line ${index + 1}: ${error instanceof Error ? error.message : "Invalid JSON"}`); }
  });
  const errorText = errors.join("\n");
  const shown = input.length > NDJSON_INLINE_LIMIT && errors.length > NDJSON_SHOWN_ERRORS ? errors.slice(0, NDJSON_SHOWN_ERRORS).join("\n") : errorText;
  return { valid, invalid: errors.length, errorText, shownText: shown };
}
