import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from "sql.js";
import { serveTasks, withTransfer } from "../workers/runtime";
import { MAX_SNAPSHOT_BYTES, type RunProgress, type SqlTasks } from "./sqlite-protocol";
import {
  changeMarker,
  csvCell,
  databaseSchema,
  detectDelimiter,
  engineState,
  importDelimited,
  importJson,
  openDatabase,
  runScript,
  snapshotOf,
} from "./sqlite-runtime";
import { parseDelimited } from "../delimited";

/**
 * Owns the sql.js database off the main thread. Statements run synchronously here, so a runaway query only blocks this
 * worker: the page terminates it (Cancel) and reopens the last snapshot in a fresh one.
 */

let sqlJs: SqlJsStatic | null = null;
let db: Database | null = null;
/** Row stores of the latest run, keyed by 1-based statement index. */
let results = new Map<number, { columns: string[]; rows: SqlValue[][] }>();

async function engine(): Promise<SqlJsStatic> {
  if (!sqlJs) sqlJs = await initSqlJs({ locateFile: (file) => `/sql/${file.replace(/^sql-wasm\.wasm$/, "sql-wasm-browser.wasm")}` });
  return sqlJs;
}

function current(): Database {
  if (!db) throw new Error("No database is open.");
  return db;
}

function resetResults(): void {
  results = new Map();
}

const CHUNK = 5000;

function* csvChunks(columns: string[], rows: SqlValue[][]): Generator<string> {
  yield `${columns.map((c) => csvCell(c)).join(",")}\r\n`;
  for (let i = 0; i < rows.length; i += CHUNK) {
    yield `${rows
      .slice(i, i + CHUNK)
      .map((r) => r.map(csvCell).join(","))
      .join("\r\n")}\r\n`;
  }
}

/** Same bytes as JSON.stringify(objects, null, 2), produced in slices so a big result never builds one giant string. */
function* jsonChunks(columns: string[], rows: SqlValue[][]): Generator<string> {
  if (rows.length === 0) {
    yield "[]";
    return;
  }
  yield "[\n";
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK).map((row) => {
      const o: Record<string, unknown> = {};
      columns.forEach((c, j) => {
        const v = row[j];
        o[c] = v instanceof Uint8Array ? `<blob ${v.length} bytes>` : v;
      });
      return JSON.stringify(o, null, 2).replace(/^/gm, "  ");
    });
    yield slice.join(",\n") + (i + CHUNK < rows.length ? ",\n" : "\n");
  }
  yield "]";
}

serveTasks<SqlTasks>({
  async open({ bytes }) {
    const sql = await engine();
    db?.close();
    db = null;
    resetResults();
    db = bytes ? openDatabase(sql, bytes) : new sql.Database();
    return engineState(db);
  },

  run({ sql, maxStored, inline, keepResults }, context) {
    const database = current();
    const before = changeMarker(database);
    let last = 0;
    const output = runScript(database, sql, {
      maxStored,
      onProgress: (p: RunProgress) => {
        const now = performance.now();
        if (now - last < 120) return;
        last = now;
        context.progress(p);
      },
    });
    if (!keepResults) resetResults();
    const meta = output.results.map((r) => {
      if (!keepResults) results.set(r.index, { columns: r.columns, rows: r.rows });
      const { rows, ...rest } = r;
      return { ...rest, stored: rows.length, inline: rows.slice(0, inline) };
    });
    const dirty = changeMarker(database) !== before;
    const snapshot = dirty ? snapshotOf(database, MAX_SNAPSHOT_BYTES) : undefined;
    const value = { results: meta, error: output.error, ms: output.ms, state: engineState(database), ...(snapshot !== undefined ? { snapshot } : {}) };
    return snapshot ? withTransfer(value, [snapshot.buffer as ArrayBuffer]) : value;
  },

  firstStatement({ sql }) {
    const iterator = current().iterateStatements(sql);
    const step = iterator.next();
    if (step.done) return "";
    const text = step.value.getSQL().trim();
    step.value.free();
    return text;
  },

  rows({ statement, offset, limit }) {
    const stored = results.get(statement);
    if (!stored) throw new Error("That result is no longer available (a newer run replaced it).");
    return stored.rows.slice(offset, offset + limit);
  },

  exportRows({ statement, format }) {
    const stored = results.get(statement);
    if (!stored) throw new Error("That result is no longer available (a newer run replaced it).");
    const chunks = [...(format === "csv" ? csvChunks(stored.columns, stored.rows) : jsonChunks(stored.columns, stored.rows))];
    return new Blob(chunks, { type: format === "csv" ? "text/csv;charset=utf-8" : "application/json" });
  },

  exportDb() {
    const bytes = current().export();
    return withTransfer(bytes, [bytes.buffer as ArrayBuffer]);
  },

  importFile({ name, tableName, buffer }, context) {
    const database = current();
    const onProgress = (rows: number, total: number) => context.progress({ phase: "inserting", rows, total });
    context.progress({ phase: "parsing", rows: 0, total: 0 });
    const text = new TextDecoder().decode(buffer);
    const imported = /\.(json|ndjson|jsonl)$/i.test(name)
      ? importJson(database, tableName, text, onProgress)
      : importDelimited(database, tableName, parseDelimited(text, detectDelimiter(text.slice(0, 4096), name)), onProgress);
    resetResults();
    const snapshot = snapshotOf(database, MAX_SNAPSHOT_BYTES);
    const value = { name: imported.name, columns: imported.columns, rows: imported.rows, state: engineState(database), snapshot };
    return snapshot ? withTransfer(value, [snapshot.buffer as ArrayBuffer]) : value;
  },

  schema() {
    return databaseSchema(current());
  },
});
