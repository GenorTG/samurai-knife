import { msgf } from "@/lib/i18n/msg";
import pg from "pg";
import { readSecret, readState } from "@/lib/services/state";
import { COURSE_DATABASE, COURSE_SCHEMAS, LEARNER_ROLE, SEED_VERSION, seedScript } from "./seed";
import { classifyStatement, lineColumn, splitStatements } from "./statements";
import type { Cell } from "./compare";
import { clipText, guardedSocket, RESULT_LIMIT_CODE, ResultBudget, ResultLimitError, RowCollector, WireGuard } from "./limits";

/**
 * The course database from the server side (never the browser): seeding as the superuser, learner queries as the
 * low-privilege role. Contract in docs/LEARN.md.
 *
 * Every learner run: a fresh connection as `knife_learner` (so nothing a run sets survives it), BEGIN, each statement in
 * turn (plain queries through a cursor so at most `rowCap` rows ever leave the server), then ROLLBACK, always. A run
 * past `timeoutMs` is stopped by the server (`statement_timeout`) and, as a backstop the learner cannot SET away, its
 * backend is terminated from a superuser connection. What a run may send back is bounded in `limits.ts`: rows are
 * streamed (never buffered whole), cells cut, and a run whose result is too large on the wire is stopped.
 */

export const SERVICE_ID = "learn-db";
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_ROW_CAP = 500;
const MAX_STATEMENTS = 25;
const MAX_SQL_CHARS = 20_000;

export interface ConnectionInfo {
  host: string;
  port: number;
  adminPassword: string;
  learnerPassword: string;
  /** Cache key for "this database is seeded" (changes when the container/volume does). */
  key: string;
}

export class LearnDbError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Connection details from the sidecar's state and secrets; throws `not_installed` when it is not installed. */
export function sidecarConnection(): ConnectionInfo {
  const state = readState(SERVICE_ID);
  const adminPassword = readSecret(SERVICE_ID, "POSTGRES_PASSWORD");
  const learnerPassword = readSecret(SERVICE_ID, "LEARNER_PASSWORD");
  if (!state || !adminPassword || !learnerPassword) {
    throw new LearnDbError("not_installed", "The course database is not installed. Install it from the course page or Sidecar services.");
  }
  return { host: state.bindHost, port: state.hostPort, adminPassword, learnerPassword, key: `${state.hostPort}|${state.installedAt}|${state.lastStartedAt ?? ""}` };
}

/* --------------------------------------------------------------------------------------------- clients */

const RAW_TEXT_TYPES = new Set([1082, 1083, 1114, 1184, 1186, 1266]);

/** Dates/times stay the server's text (no timezone shifts, no Date objects); int8 becomes a number when exact. */
const types = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (RAW_TEXT_TYPES.has(oid)) return (value: string) => value;
    if (oid === 20) {
      return (value: string) => {
        const n = Number(value);
        return Number.isSafeInteger(n) ? n : value;
      };
    }
    return pg.types.getTypeParser(oid, format ?? "text");
  },
} as unknown as pg.CustomTypesConfig;

function client(info: ConnectionInfo, role: "admin" | "learner", timeoutMs = DEFAULT_TIMEOUT_MS, guard?: WireGuard): pg.Client {
  return new pg.Client({
    host: info.host,
    port: info.port,
    database: COURSE_DATABASE,
    user: role === "admin" ? "postgres" : LEARNER_ROLE,
    password: role === "admin" ? info.adminPassword : info.learnerPassword,
    application_name: role === "admin" ? "knife-learn-admin" : "knife-learn",
    connectionTimeoutMillis: 5000,
    statement_timeout: role === "learner" ? timeoutMs : undefined,
    types,
    // The guard reads the plain protocol: never TLS on this socket (the sidecar is bound to this host).
    ...(guard ? { ssl: false, stream: () => guardedSocket(guard) } : {}),
  });
}

function connectError(error: unknown): LearnDbError {
  const err = error as NodeJS.ErrnoException & { code?: string };
  if (err.code === "ECONNREFUSED" || err.code === "ECONNRESET" || err.code === "57P03" || /timeout/i.test(err.message ?? "")) {
    return new LearnDbError("not_running", "The course database is not running (or still starting). Start it and try again.");
  }
  return new LearnDbError("connect_failed", msgf("Could not connect to the course database: {message}", { message: err.message }), 502);
}

async function withAdmin<T>(info: ConnectionInfo, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = client(info, "admin");
  try {
    await c.connect();
  } catch (error) {
    throw connectError(error);
  }
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

/* ---------------------------------------------------------------------------------------------- seeding */

// Versioned global key: the PM2 dev server keeps globalThis across HMR (AGENTS.md).
const SEEDED_KEY = Symbol.for("samurai-knife.learn-seeded.v1");

function seededCache(): Map<string, Promise<SeedInfo>> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Promise<SeedInfo>> | undefined>;
  holder[SEEDED_KEY] ??= new Map();
  return holder[SEEDED_KEY];
}

export interface SeedInfo {
  version: number;
  /** This call (re)built the data. */
  built: boolean;
  ms: number;
}

async function storedVersion(c: pg.Client): Promise<number | null> {
  const exists = await c.query<{ ok: boolean }>("SELECT to_regclass('knife_admin.meta') IS NOT NULL AS ok");
  if (!exists.rows[0]?.ok) return null;
  const result = await c.query<{ value: string }>("SELECT value FROM knife_admin.meta WHERE key = 'seed_version'");
  const role = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = '${LEARNER_ROLE}'`);
  return result.rows[0] && role.rowCount ? Number(result.rows[0].value) : null;
}

async function seed(info: ConnectionInfo, force: boolean): Promise<SeedInfo> {
  const t0 = Date.now();
  return withAdmin(info, async (c) => {
    if (!force && (await storedVersion(c)) === SEED_VERSION) return { version: SEED_VERSION, built: false, ms: Date.now() - t0 };
    await c.query("BEGIN");
    try {
      await c.query(seedScript(info.learnerPassword));
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK").catch(() => {});
      throw new LearnDbError("seed_failed", msgf("Building the course data failed: {message}", { message: (error as Error).message }), 500);
    }
    return { version: SEED_VERSION, built: true, ms: Date.now() - t0 };
  });
}

/** Builds the course data when missing or from an older SEED_VERSION (idempotent; cached per container start). */
export function ensureSeeded(info: ConnectionInfo, force = false): Promise<SeedInfo> {
  const cache = seededCache();
  const cached = cache.get(info.key);
  if (cached && !force) return cached;
  const pending = seed(info, force);
  cache.set(info.key, pending);
  pending.catch(() => cache.delete(info.key));
  return pending;
}

export function forgetSeeded(info: ConnectionInfo): void {
  seededCache().delete(info.key);
}

/* ---------------------------------------------------------------------------------------------- running */

export interface StatementResult {
  /** Postgres command tag (SELECT, INSERT, EXPLAIN…). */
  command: string;
  columns: string[];
  rows: Cell[][];
  /** Rows affected (writes) or returned. */
  rowCount: number;
  /** More rows existed than `rowCap`, or rows were dropped because the run's result budget was spent. */
  truncated: boolean;
  /** At least one cell was cut (it ends with "… [truncated: N characters]"). */
  clipped?: boolean;
}

export interface SqlErrorInfo {
  message: string;
  code?: string;
  detail?: string;
  hint?: string;
  /** Index of the failing statement. */
  statement: number;
  /** Where in the learner's text (1-based line/column; offset 0-based). */
  position?: { offset: number; line: number; column: number };
}

export interface RunOutput {
  results: StatementResult[];
  notices: string[];
  durationMs: number;
  error: SqlErrorInfo | null;
  /** Always true: the run's transaction was rolled back. */
  rolledBack: boolean;
}

export interface RunOptions {
  rowCap?: number;
  timeoutMs?: number;
}

function cellValue(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return `\\x${value.toString("hex")}`;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

interface Streamed {
  command: string;
  columns: string[];
  rowCount: number | null;
}

/** Runs one statement as a streaming query: rows go to the collector one by one, node-postgres never accumulates them. */
function streamQuery(c: pg.Client, text: string, collector: RowCollector): Promise<Streamed> {
  return new Promise((resolve, reject) => {
    const config: pg.QueryArrayConfig = { text, rowMode: "array" };
    const query = new pg.Query(config);
    query.on("row", (row: unknown) => collector.add(row as unknown[]));
    query.on("error", reject);
    query.on("end", (result) => resolve({ command: result.command ?? "", columns: (result.fields ?? []).map((field) => field.name), rowCount: result.rowCount }));
    c.query(query);
  });
}

function toResult(streamed: Streamed, collector: RowCollector, command?: string): StatementResult {
  return {
    command: command ?? streamed.command,
    columns: streamed.columns,
    rows: collector.rows,
    rowCount: streamed.command === "SELECT" || command ? collector.seen : (streamed.rowCount ?? collector.seen),
    truncated: collector.truncated,
    ...(collector.clipped ? { clipped: true } : {}),
  };
}

interface PgError extends Error {
  code?: string;
  detail?: string;
  hint?: string;
  position?: string;
}

function errorInfo(sql: string, error: unknown, statement: number, offsetInSql: number, prefixLength = 0): SqlErrorInfo {
  const err = error as PgError;
  const info: SqlErrorInfo = { message: clipText(err.message), code: err.code, detail: clipText(err.detail), hint: clipText(err.hint), statement };
  if (err.code === "57014") info.message = "The query ran longer than the time limit and was cancelled. Add a WHERE clause or a LIMIT, or check for a missing join condition.";
  if (err.code === "57P01" || err.code === "57P02") info.message = "The query ran past the time limit and was stopped.";
  if (err.code === "42501") info.hint = info.hint ?? "The course role can read the course tables and write (rolled back) to the shop tables only. Copy data into a TEMP table to experiment.";
  const pos = Number(err.position);
  if (Number.isInteger(pos) && pos > prefixLength) {
    const offset = offsetInSql + (pos - prefixLength) - 1;
    info.position = { offset, ...lineColumn(sql, offset + 1) };
  }
  return info;
}

/** The run was stopped because its result passed a wire limit (the connection is gone, the server rolled back). */
function limitInfo(error: ResultLimitError, statement: number): SqlErrorInfo {
  return { message: error.message, code: RESULT_LIMIT_CODE, statement };
}

/** Splits, vets and runs learner SQL in one rolled-back transaction. Refusals and SQL errors come back in `error`. */
export async function runLearnerSql(info: ConnectionInfo, sql: string, options: RunOptions = {}): Promise<RunOutput> {
  const rowCap = options.rowCap ?? DEFAULT_ROW_CAP;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const output: RunOutput = { results: [], notices: [], durationMs: 0, error: null, rolledBack: true };
  const done = () => ({ ...output, durationMs: Date.now() - started });
  if (sql.length > MAX_SQL_CHARS) {
    output.error = { message: msgf("The query is longer than {MAX_SQL_CHARS} characters.", { MAX_SQL_CHARS }), statement: 0 };
    return done();
  }
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    output.error = { message: "Write a query first.", statement: 0 };
    return done();
  }
  if (statements.length > MAX_STATEMENTS) {
    output.error = { message: `At most ${MAX_STATEMENTS} statements per run.`, statement: 0 };
    return done();
  }
  const verdicts = statements.map(classifyStatement);
  const refused = verdicts.findIndex((verdict) => !verdict.ok);
  if (refused >= 0) {
    const verdict = verdicts[refused];
    const offset = statements[refused].start;
    output.error = { message: verdict.ok ? "" : verdict.reason, statement: refused, code: "knife_refused", position: { offset, ...lineColumn(sql, offset + 1) } };
    return done();
  }

  const guard = new WireGuard();
  const budget = new ResultBudget();
  const c = client(info, "learner", timeoutMs, guard);
  c.on("notice", (notice) => {
    if (output.notices.length < 50) output.notices.push(clipText(`${notice.severity ?? "NOTICE"}: ${notice.message}`));
  });
  c.on("error", () => {
    /* a terminated backend also surfaces on the pending query */
  });
  try {
    await c.connect();
  } catch (error) {
    throw connectError(error);
  }
  let backendPid = 0;
  let killer: ReturnType<typeof setTimeout> | null = null;
  try {
    backendPid = (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? 0;
    killer = setTimeout(() => {
      void withAdmin(info, (admin) => admin.query("SELECT pg_terminate_backend($1)", [backendPid])).catch(() => {});
    }, timeoutMs + 1500);
    await c.query("BEGIN");
    await c.query(`SET LOCAL search_path = ${COURSE_SCHEMAS.join(", ")}, public`);
    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index];
      const verdict = verdicts[index];
      if (verdict.ok && verdict.cursor) {
        const prefix = "DECLARE knife_cursor NO SCROLL CURSOR FOR ";
        await c.query("SAVEPOINT knife_run");
        try {
          await c.query(prefix + statement.text);
          const collector = new RowCollector(rowCap, budget, cellValue);
          const fetched = await streamQuery(c, `FETCH FORWARD ${rowCap + 1} FROM knife_cursor`, collector);
          await c.query("CLOSE knife_cursor");
          await c.query("RELEASE SAVEPOINT knife_run");
          output.results.push(toResult(fetched, collector, "SELECT"));
          continue;
        } catch (error) {
          if (guard.tripped) throw guard.tripped;
          await c.query("ROLLBACK TO SAVEPOINT knife_run").catch(() => {});
          // Not every query fits a cursor (e.g. SELECT ... INTO): run it directly, Postgres explains what is wrong.
          if ((error as PgError).code !== "0A000" && (error as PgError).code !== "42601") {
            output.error = errorInfo(sql, error, index, statement.start, prefix.length);
            break;
          }
        }
      }
      try {
        const collector = new RowCollector(rowCap, budget, cellValue);
        output.results.push(toResult(await streamQuery(c, statement.text, collector), collector));
      } catch (error) {
        output.error = guard.tripped ? limitInfo(guard.tripped, index) : errorInfo(sql, error, index, statement.start);
        break;
      }
    }
  } catch (error) {
    output.error = guard.tripped ? limitInfo(guard.tripped, output.results.length) : errorInfo(sql, error, output.results.length, 0);
  } finally {
    if (killer) clearTimeout(killer);
    await c.query("ROLLBACK").catch(() => {});
    await c.end().catch(() => {});
  }
  return done();
}

/* ---------------------------------------------------------------------------------------------- schema */

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  references?: string;
}

export interface SchemaTable {
  schema: string;
  name: string;
  comment: string | null;
  approxRows: number;
  columns: SchemaColumn[];
}

/** Tables and columns of the course schemas as the learner sees them. */
export async function courseSchema(info: ConnectionInfo): Promise<SchemaTable[]> {
  const c = client(info, "learner");
  try {
    await c.connect();
  } catch (error) {
    throw connectError(error);
  }
  try {
    const result = await c.query<{
      schema: string; table: string; comment: string | null; reltuples: number; column: string; type: string; nullable: boolean; pk: boolean; ref: string | null;
    }>(`
      SELECT n.nspname AS schema, c.relname AS table, obj_description(c.oid, 'pg_class') AS comment, c.reltuples::float8 AS reltuples,
             a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
             EXISTS (SELECT 1 FROM pg_constraint p WHERE p.conrelid = c.oid AND p.contype = 'p' AND a.attnum = ANY (p.conkey)) AS pk,
             (SELECT rn.nspname || '.' || rc.relname || '.' || ra.attname
                FROM pg_constraint f JOIN pg_class rc ON rc.oid = f.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
                JOIN pg_attribute ra ON ra.attrelid = f.confrelid AND ra.attnum = f.confkey[1]
               WHERE f.conrelid = c.oid AND f.contype = 'f' AND f.conkey = ARRAY[a.attnum] LIMIT 1) AS ref
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE n.nspname = ANY ($1) AND c.relkind IN ('r', 'v', 'p')
       ORDER BY n.nspname, c.relname, a.attnum`, [COURSE_SCHEMAS]);
    const tables = new Map<string, SchemaTable>();
    for (const row of result.rows) {
      const key = `${row.schema}.${row.table}`;
      let table = tables.get(key);
      if (!table) {
        table = { schema: row.schema, name: row.table, comment: row.comment, approxRows: Math.max(0, Math.round(row.reltuples)), columns: [] };
        tables.set(key, table);
      }
      table.columns.push({ name: row.column, type: row.type, nullable: row.nullable, primaryKey: row.pk, ...(row.ref ? { references: row.ref } : {}) });
    }
    return [...tables.values()];
  } finally {
    await c.end().catch(() => {});
  }
}
