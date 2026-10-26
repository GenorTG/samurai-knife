import type { Database, SqlJsStatic, SqlValue, Statement } from "sql.js";
import type { RunProgress } from "./sqlite-protocol";
import type { SqlSchema } from "./types";
import { msg, msgf } from "@/lib/i18n/msg";

/**
 * SQLite helpers around sql.js (SQLite compiled to WebAssembly). Pure: no DOM, no globals. They run inside
 * `sqlite.worker.ts`; the page never touches a database object. The wasm is served same-origin from /sql/
 * (copied by scripts/prepare-sql-assets.mjs), so no file or query ever leaves the browser.
 */

export const MAX_DB_BYTES = 64 * 1024 * 1024;
/** Counting past this many rows stops: the notice then says "N+". */
const MAX_COUNTED_ROWS = 1_000_000;
/** How often (rows) runScript checks the clock to report progress. */
const PROGRESS_EVERY_ROWS = 2048;

const SQLITE_MAGIC = "SQLite format 3\0";

export function looksLikeSqlite(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i += 1) if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  return true;
}

export function openDatabase(sql: SqlJsStatic, bytes: Uint8Array): Database {
  if (!looksLikeSqlite(bytes)) throw new Error(msg("That file is not a SQLite database (missing the \"SQLite format 3\" header)."));
  const db = new sql.Database(bytes);
  try {
    db.exec("select count(*) from sqlite_master");
  } catch (e) {
    db.close();
    throw new Error(msgf("The database could not be read: {value} (encrypted or corrupt files are not supported).", { value: e instanceof Error ? e.message : String(e) }));
  }
  return db;
}

/* ----------------------------------------------------------------- running SQL */

export interface StatementResult {
  index: number;
  sql: string;
  kind: string;
  columns: string[];
  rows: SqlValue[][];
  /** Rows the statement produced (may exceed `rows.length`; `countCapped` when counting stopped early). */
  total: number;
  countCapped: boolean;
  /** Rows changed by INSERT/UPDATE/DELETE. */
  changes: number | null;
  ms: number;
}

export interface ScriptResult {
  results: StatementResult[];
  error: { index: number; sql: string; message: string } | null;
  ms: number;
}

function statementKind(sql: string): string {
  const stripped = sql.replace(/^(\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/g, "");
  const word = stripped.match(/^[A-Za-z]+/)?.[0]?.toUpperCase();
  return word ?? "STATEMENT";
}

export interface RunScriptOptions {
  /** Rows kept per statement; the rest are only counted. */
  maxStored: number;
  /** Called every few thousand rows with how far the current statement is. */
  onProgress?: (progress: RunProgress) => void;
}

/** Run every statement in `sql`. Statements before a failing one stay applied (SQLite autocommit), later ones are skipped. */
export function runScript(db: Database, sql: string, { maxStored, onProgress }: RunScriptOptions): ScriptResult {
  const started = performance.now();
  const results: StatementResult[] = [];
  let error: ScriptResult["error"] = null;
  let index = 0;
  const iterator = db.iterateStatements(sql);
  for (;;) {
    // Preparing the next statement is where syntax errors and unknown tables/columns surface.
    let step: { done: boolean; value: Statement };
    try {
      step = iterator.next();
    } catch (e) {
      error = { index: index + 1, sql: iterator.getRemainingSQL().trim().slice(0, 400), message: e instanceof Error ? e.message : String(e) };
      break;
    }
    if (step.done) break;
    const stmt = step.value;
    index += 1;
    const text = stmt.getSQL().trim();
    const t0 = performance.now();
    const columns = stmt.getColumnNames();
    const rows: SqlValue[][] = [];
    let total = 0;
    let countCapped = false;
    try {
      while (stmt.step()) {
        total += 1;
        if (rows.length < maxStored) rows.push(stmt.get());
        if (onProgress && total % PROGRESS_EVERY_ROWS === 0) onProgress({ statement: index, rows: total, ms: performance.now() - started });
        if (total >= MAX_COUNTED_ROWS) {
          countCapped = true;
          break;
        }
      }
    } catch (e) {
      error = { index, sql: text, message: e instanceof Error ? e.message : String(e) };
      break;
    } finally {
      stmt.free();
    }
    const kind = statementKind(text);
    const changes = columns.length === 0 && /^(INSERT|UPDATE|DELETE|REPLACE)$/.test(kind) ? db.getRowsModified() : null;
    results.push({ index, sql: text, kind, columns, rows, total, countCapped, changes, ms: performance.now() - t0 });
  }
  return { results, error, ms: performance.now() - started };
}

/** Run one statement for its rows; used by introspection helpers. */
function query(db: Database, sql: string): { columns: string[]; values: SqlValue[][] } {
  const [first] = db.exec(sql);
  return first ?? { columns: [], values: [] };
}

/* ----------------------------------------------------------------- introspection */

export interface TableInfo {
  name: string;
  columns: { name: string; type: string; pk: boolean; notNull: boolean }[];
  rows: number;
  isView: boolean;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function listTables(db: Database): TableInfo[] {
  const master = query(db, "select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name");
  return master.values.map(([nameValue, typeValue]) => {
    const name = String(nameValue);
    const info = query(db, `pragma table_info(${quoteIdent(name)})`);
    const columns = info.values.map((row) => ({ name: String(row[1]), type: String(row[2] ?? ""), notNull: Number(row[3]) === 1, pk: Number(row[5]) > 0 }));
    let rows = 0;
    try {
      rows = Number(query(db, `select count(*) from ${quoteIdent(name)}`).values[0]?.[0] ?? 0);
    } catch {
      rows = 0;
    }
    return { name, columns, rows, isView: typeValue === "view" };
  });
}

/** Structured schema of the open database (tables only), in the shape the Validate/Build tabs and the assistant use. */
export function databaseSchema(db: Database): SqlSchema {
  const tables = listTables(db).filter((t) => !t.isView);
  return {
    tables: tables.map((table) => {
      const pk = table.columns.filter((c) => c.pk).map((c) => c.name);
      const fk = query(db, `pragma foreign_key_list(${quoteIdent(table.name)})`);
      const byId = new Map<number, { columns: string[]; refTable: string; refColumns: string[] }>();
      for (const row of fk.values) {
        const id = Number(row[0]);
        const entry = byId.get(id) ?? { columns: [], refTable: String(row[2]), refColumns: [] };
        entry.columns.push(String(row[3]));
        entry.refColumns.push(String(row[4] ?? ""));
        byId.set(id, entry);
      }
      return {
        name: table.name,
        columns: table.columns.map((c) => ({ name: c.name, ...(c.type ? { type: c.type } : {}), nullable: !c.notNull && !c.pk, ...(c.pk ? { primaryKey: true } : {}) })),
        ...(pk.length ? { primaryKey: pk } : {}),
        ...(byId.size ? { foreignKeys: [...byId.values()] } : {}),
      };
    }),
  };
}

/** SQLite DDL for a structured schema (types are passed through; SQLite accepts any type name). */
export function schemaToSqliteDdl(schema: SqlSchema): string {
  return schema.tables
    .map((table) => {
      const lines = table.columns.map((c) => {
        const single = table.primaryKey?.length === 1 && table.primaryKey[0] === c.name;
        return `  ${quoteIdent(c.name)}${c.type ? ` ${c.type}` : ""}${c.primaryKey || single ? " PRIMARY KEY" : ""}${c.nullable === false && !c.primaryKey ? " NOT NULL" : ""}${c.default ? ` DEFAULT ${c.default}` : ""}`;
      });
      if ((table.primaryKey?.length ?? 0) > 1) lines.push(`  PRIMARY KEY (${table.primaryKey!.map(quoteIdent).join(", ")})`);
      for (const fk of table.foreignKeys ?? []) {
        lines.push(`  FOREIGN KEY (${fk.columns.map(quoteIdent).join(", ")}) REFERENCES ${quoteIdent(fk.refTable)} (${fk.refColumns.map(quoteIdent).join(", ")})`);
      }
      return `CREATE TABLE IF NOT EXISTS ${quoteIdent(table.name)} (\n${lines.join(",\n")}\n);`;
    })
    .join("\n\n");
}

/* ----------------------------------------------------------------- importing */

export function detectDelimiter(sample: string, filename: string): string {
  if (/\.tsv$/i.test(filename)) return "\t";
  const firstLine = sample.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t", "|"].map((d) => [d, firstLine.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

export interface ImportedTable {
  name: string;
  columns: string[];
  rows: number;
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  let n = 2;
  while (taken.has(name.toLowerCase())) {
    name = `${base}_${n}`;
    n += 1;
  }
  return name;
}

export function tableNameFromFile(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const name = base || "data";
  return /^\d/.test(name) ? `t_${name}` : name;
}

function normalizeHeaders(headers: string[]): string[] {
  const seen = new Set<string>();
  return headers.map((raw, i) => {
    const name = uniqueName(raw.trim() || `column_${i + 1}`, seen);
    seen.add(name.toLowerCase());
    return name;
  });
}

function inferType(values: (string | number | boolean | null)[]): "INTEGER" | "REAL" | "TEXT" {
  let integer = true;
  let real = true;
  let seen = false;
  for (const v of values) {
    if (v === null || v === "") continue;
    seen = true;
    const s = String(v).trim();
    // Leading zeros ("007", ZIP codes) are identifiers, not numbers: keep them TEXT.
    const leadingZero = /^-?0\d/.test(s);
    if (!/^-?\d+$/.test(s) || s.length > 15 || leadingZero) integer = false;
    if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) || leadingZero) real = false;
    if (!integer && !real) return "TEXT";
  }
  if (!seen) return "TEXT";
  return integer ? "INTEGER" : real ? "REAL" : "TEXT";
}

/** Called with (rows inserted, total rows) while a table is filled. */
export type ImportProgressFn = (inserted: number, total: number) => void;
const IMPORT_PROGRESS_EVERY = 5000;

function insertTable(db: Database, requested: string, headers: string[], rows: (string | number | boolean | null)[][], onProgress?: ImportProgressFn): ImportedTable {
  const taken = new Set(listTables(db).map((t) => t.name.toLowerCase()));
  const name = uniqueName(requested, taken);
  const columns = normalizeHeaders(headers);
  const types = columns.map((_, i) => inferType(rows.map((r) => r[i] ?? null)));
  db.run("begin");
  try {
    db.run(`create table ${quoteIdent(name)} (${columns.map((c, i) => `${quoteIdent(c)} ${types[i]}`).join(", ")})`);
    const stmt = db.prepare(`insert into ${quoteIdent(name)} values (${columns.map(() => "?").join(", ")})`);
    try {
      for (let r = 0; r < rows.length; r += 1) {
        const row = rows[r];
        if (onProgress && r % IMPORT_PROGRESS_EVERY === 0) onProgress(r, rows.length);
        stmt.run(
          columns.map((_, i): SqlValue => {
            const v = row[i] ?? null;
            if (v === null || v === "") return null;
            if (typeof v === "boolean") return v ? 1 : 0;
            if (types[i] === "INTEGER" || types[i] === "REAL") return Number(v);
            return String(v);
          }),
        );
      }
    } finally {
      stmt.free();
    }
    db.run("commit");
  } catch (e) {
    db.run("rollback");
    throw e;
  }
  return { name, columns, rows: rows.length };
}

/** Import parsed CSV/TSV (first row = header) as a new table with inferred INTEGER/REAL/TEXT columns. */
export function importDelimited(db: Database, tableName: string, parsed: string[][], onProgress?: ImportProgressFn): ImportedTable {
  if (parsed.length === 0) throw new Error(msg("The file has no rows."));
  const [header, ...rows] = parsed;
  return insertTable(db, tableName, header, rows, onProgress);
}

/** Import a JSON array of objects (or NDJSON lines, or one object) as a new table; nested values are stored as JSON text. */
export function importJson(db: Database, tableName: string, text: string, onProgress?: ImportProgressFn): ImportedTable {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    try {
      data = lines.map((l) => JSON.parse(l) as unknown);
    } catch {
      throw new Error(msg("The file is neither valid JSON nor NDJSON (one JSON object per line)."));
    }
  }
  const list = Array.isArray(data) ? data : [data];
  const objects = list.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v));
  if (objects.length === 0 || objects.length !== list.length) throw new Error(msg("Expected a JSON array of objects (one object per row)."));
  const headers: string[] = [];
  for (const o of objects) for (const k of Object.keys(o)) if (!headers.includes(k)) headers.push(k);
  const rows = objects.map((o) =>
    headers.map((h) => {
      const v = o[h];
      if (v === undefined || v === null) return null;
      if (typeof v === "object") return JSON.stringify(v);
      return v as string | number | boolean;
    }),
  );
  return insertTable(db, tableName, headers, rows, onProgress);
}

/* ----------------------------------------------------------------- exporting */

export function csvCell(value: SqlValue): string {
  if (value === null) return "";
  const text = value instanceof Uint8Array ? `<blob ${value.length} bytes>` : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function displayValue(value: SqlValue): string {
  if (value === null) return "NULL";
  if (value instanceof Uint8Array) return `<blob ${value.length} bytes>`;
  const text = String(value);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/* ----------------------------------------------------------------- state, change detection, snapshots */

function pragmaNumber(db: Database, sql: string): number {
  return Number(db.exec(sql)[0]?.values[0]?.[0] ?? 0);
}

export interface EngineState {
  tables: TableInfo[];
  /** Database size in bytes (page_count * page_size); null when unknown. */
  bytes: number | null;
}

export function engineState(db: Database): EngineState {
  let bytes: number | null = null;
  try {
    bytes = pragmaNumber(db, "pragma page_count") * pragmaNumber(db, "pragma page_size");
  } catch {
    bytes = null;
  }
  return { tables: listTables(db), bytes };
}

/** total_changes() moves on every INSERT/UPDATE/DELETE (also inside CTEs), schema_version on every DDL statement. */
export function changeMarker(db: Database): string {
  return `${pragmaNumber(db, "select total_changes()")}:${pragmaNumber(db, "pragma schema_version")}`;
}

/** Whole-database bytes for a restore point, or null when the database is larger than `maxBytes`. */
export function snapshotOf(db: Database, maxBytes: number): Uint8Array | null {
  const bytes = db.export();
  return bytes.length <= maxBytes ? bytes : null;
}
