import type { SqlValue } from "sql.js";
import type { EngineState } from "./sqlite-runtime";
import type { SqlSchema } from "./types";

/**
 * Task contract between the SQL lab (main thread) and `sqlite.worker.ts`, which owns the sql.js database.
 * Result rows never cross the thread boundary wholesale: the worker keeps them and the grid pulls windows.
 */

/** Rows kept in the worker per result set. Exports and the windowed grid read these. */
export const MAX_STORED_ROWS = 500_000;
/** Rows returned inline with a run: results this small render as a plain table, larger ones as a windowed grid. */
export const INLINE_ROWS = 1000;
/** Snapshots (restore points for Cancel) are kept only up to this size. */
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

export type { EngineState };

export interface StatementMeta {
  index: number;
  sql: string;
  kind: string;
  columns: string[];
  /** Rows the statement produced (may exceed `stored`; `countCapped` when counting stopped early). */
  total: number;
  countCapped: boolean;
  /** Rows kept in the worker and available to the grid/exports. */
  stored: number;
  changes: number | null;
  ms: number;
  /** The first rows, so small results render without a round trip. */
  inline: SqlValue[][];
}

export interface RunOutput {
  results: StatementMeta[];
  error: { index: number; sql: string; message: string } | null;
  ms: number;
  state: EngineState;
  /** Set when the database changed: bytes to restore if a later run is cancelled. `null` when it is too large to snapshot. */
  snapshot?: Uint8Array | null;
}

export interface RunProgress {
  /** 1-based statement being run. */
  statement: number;
  /** Rows produced so far by that statement. */
  rows: number;
  ms: number;
}

export interface ImportProgress {
  phase: "parsing" | "inserting";
  rows: number;
  total: number;
}

export interface ImportOutput {
  name: string;
  columns: string[];
  rows: number;
  state: EngineState;
  snapshot: Uint8Array | null;
}

export type SqlTasks = {
  /** (Re)create the database: from `bytes` (a .sqlite file or a snapshot) or empty. Also boots the engine. */
  open: { payload: { bytes: Uint8Array | null }; result: EngineState };
  run: {
    payload: { sql: string; maxStored: number; inline: number; /** Leave the row stores of the previous run alone (utility statements). */ keepResults?: boolean };
    result: RunOutput;
    progress: RunProgress;
  };
  /** Text of the first statement in `sql` (for EXPLAIN QUERY PLAN); "" when there is none. Throws the syntax error. */
  firstStatement: { payload: { sql: string }; result: string };
  rows: { payload: { statement: number; offset: number; limit: number }; result: SqlValue[][] };
  exportRows: { payload: { statement: number; format: "csv" | "json" }; result: Blob };
  exportDb: { payload: null; result: Uint8Array };
  importFile: {
    payload: { name: string; tableName: string; buffer: ArrayBuffer };
    result: ImportOutput;
    progress: ImportProgress;
  };
  schema: { payload: null; result: SqlSchema };
};
