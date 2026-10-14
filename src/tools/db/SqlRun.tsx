"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { SqlValue } from "sql.js";
import { Button, Dropzone, Field, Notice, Panel, StatGrid, Stat, TextArea, TextInput } from "@/components/ui";
import { cx, downloadBlob, formatBytes, formatInt, plural, safeFilename } from "@/lib/format";
import { saveSchema, useStoredSchema } from "@/lib/sql/schema-store";
import { RUN_EXAMPLE_QUERY, SAMPLE_RUN_SQL } from "@/lib/sql/samples";
import { MAX_STORED_ROWS, type EngineState, type RunOutput, type StatementMeta } from "@/lib/sql/sqlite-protocol";
import { isAbortError, SqlEngine } from "@/lib/sql/sqlite-client";
import { WorkerCrashError } from "@/lib/workers/errors";
import { displayValue, looksLikeSqlite, MAX_DB_BYTES, quoteIdent, schemaToSqliteDdl, tableNameFromFile, type TableInfo } from "@/lib/sql/sqlite-runtime";
import { CurrentSchemaRegion } from "./sql-shared";

interface Flash {
  tone: "info" | "good" | "error";
  text: string;
}
interface HistoryEntry {
  id: number;
  sql: string;
  ms: number;
  ok: boolean;
  note?: string;
}
/** Work in flight in the SQLite worker. Cancel terminates it and restores the last snapshot. */
interface Busy {
  kind: "query" | "import" | "open" | "task";
  startedAt: number;
  detail: string;
}

const DB_EXTENSIONS = /\.(sqlite3?|db3?|s3db)$/i;
const ROW_H = 28;
const BLOCK = 200;
const OVERSCAN = 20;
const MAX_CACHED_BLOCKS = 60;

function formatMs(ms: number): string {
  return ms < 10 ? `${ms.toFixed(2)} ms` : ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const BUSY_LABEL: Record<Busy["kind"], { running: string; cancel: string }> = {
  query: { running: "Running query", cancel: "Cancel running query" },
  import: { running: "Importing file", cancel: "Cancel import" },
  open: { running: "Opening database", cancel: "Cancel opening database" },
  task: { running: "Working", cancel: "Cancel" },
};

export default function SqlRun() {
  // Constructing the engine starts nothing: the worker spawns on first use (or when the SQL box is focused), so merely opening
  // the tab leaves no live worker request behind.
  const [engine] = useState(() => new SqlEngine());
  const mounted = useRef(true);
  const [runId, setRunId] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const [dbName, setDbName] = useState("memory");
  const [dbBytes, setDbBytes] = useState<number | null>(null);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [sqlText, setSqlText] = useState("SELECT sqlite_version() AS sqlite_version;");
  const [importName, setImportName] = useState("");
  const [flash, setFlash] = useState<Flash | null>(null);
  const [outcome, setOutcome] = useState<RunOutput | null>(null);
  const [outcomeLabel, setOutcomeLabel] = useState("Results");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [now, setNow] = useState(0);
  const historyId = useRef(0);
  const stored = useStoredSchema();

  const applyState = useCallback((state: EngineState) => {
    setTables(state.tables);
    setDbBytes(state.bytes);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      engine.dispose();
    };
  }, [engine]);

  // Elapsed-time text only needs a re-render while something runs.
  const working = busy !== null;
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(timer);
  }, [working]);

  /**
   * Run one worker job with progress, a Cancel path and error handling. Cancel terminates the worker (the only way to stop
   * a running SQLite statement) and reopens the last snapshot, so the database is never left half-modified.
   */
  const work = useCallback(
    async <T,>(kind: Busy["kind"], job: (engine: SqlEngine, signal: AbortSignal, detail: (text: string) => void) => Promise<T>): Promise<T | undefined> => {
      if (abortRef.current) return undefined;
      const controller = new AbortController();
      abortRef.current = controller;
      const startedAt = performance.now();
      setBusy({ kind, startedAt, detail: "" });
      try {
        return await job(engine, controller.signal, (text) => setBusy((b) => (b ? { ...b, detail: text } : b)));
      } catch (e) {
        if (!mounted.current) return undefined; // the tab was closed
        const cancelled = isAbortError(e);
        const message = e instanceof Error ? e.message : String(e);
        if (!cancelled && !(e instanceof WorkerCrashError)) {
          setFlash({ tone: "error", text: message });
          return undefined;
        }
        // Cancel or a crash killed the worker: reopen the last snapshot in a fresh one.
        const point = engine.restorePoint;
        try {
          applyState(await engine.restore());
        } catch {
          // restore failed too: the previous state stays on screen, the message below says what happened
        }
        setOutcome(null);
        const restored = `The database was restored from its ${point.label} snapshot (${formatBytes(point.bytes ?? 0)}, taken ${formatElapsed(Date.now() - point.takenAt)} ago).`;
        setFlash(
          cancelled
            ? {
                tone: "info",
                text: `Cancelled ${BUSY_LABEL[kind].running.toLowerCase()} after ${formatElapsed(performance.now() - startedAt)}. ${restored} Changes made by the cancelled work are gone.${point.stale ? " The database has since outgrown the snapshot limit, so this snapshot predates your latest writes." : ""}`,
              }
            : { tone: "error", text: `${message} ${restored}` },
        );
        return undefined;
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setBusy(null);
      }
    },
    [applyState, engine],
  );

  const cancel = () => abortRef.current?.abort();

  const execute = useCallback(
    (sql: string, label = "Results") => {
      if (!sql.trim()) {
        setFlash({ tone: "error", text: "Write some SQL first." });
        return;
      }
      const startedAt = performance.now();
      void work("query", async (engine, signal, detail) => {
        let out: RunOutput;
        try {
          out = await engine.run(sql, {
            signal,
            onProgress: (p) => detail(`statement ${p.statement}, ${formatInt(p.rows)} rows so far`),
          });
        } catch (e) {
          if (isAbortError(e)) setHistory((h) => [{ id: (historyId.current += 1), sql, ms: performance.now() - startedAt, ok: false, note: "cancelled" }, ...h].slice(0, 25));
          throw e;
        }
        setOutcome(out);
        setRunId((n) => n + 1);
        setOutcomeLabel(label);
        applyState(out.state);
        setFlash(null);
        setHistory((h) => [{ id: (historyId.current += 1), sql, ms: out.ms, ok: !out.error }, ...h].slice(0, 25));
      });
    },
    [applyState, work],
  );

  const handleFiles = async (files: File[]) => {
    for (const file of files) {
      if (file.size > MAX_DB_BYTES) {
        setFlash({ tone: "error", text: `${file.name} is ${formatBytes(file.size)}; files over ${formatBytes(MAX_DB_BYTES)} are refused so the tab stays responsive.` });
        return;
      }
      const buffer = await file.arrayBuffer();
      const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 16));
      if (DB_EXTENSIONS.test(file.name) || looksLikeSqlite(head)) {
        const ok = await work("open", async (engine, signal) => {
          if (!looksLikeSqlite(head)) throw new Error(`${file.name}: that file is not a SQLite database (missing the "SQLite format 3" header).`);
          try {
            applyState(await engine.open(new Uint8Array(buffer), `opened file ${file.name}`, { signal }));
          } catch (e) {
            throw isAbortError(e) || !(e instanceof Error) ? e : new Error(`${file.name}: ${e.message}`);
          }
          setDbName(file.name);
          setOutcome(null);
          setFlash({ tone: "good", text: `Opened ${file.name} (${formatBytes(file.size)}). It is held in memory; nothing was uploaded.` });
          return true;
        });
        if (!ok) return;
        continue;
      }
      const base = importName.trim() ? importName.trim() : tableNameFromFile(file.name);
      const imported = await work("import", async (engine, signal, detail) => {
        const out = await engine.importFile({ name: file.name, buffer }, base, {
          signal,
          onProgress: (p) => detail(p.phase === "parsing" ? `reading ${file.name}` : `${formatInt(p.rows)} of ${formatInt(p.total)} rows inserted`),
        });
        applyState(out.state);
        setOutcome(null);
        setImportName("");
        setSqlText(`SELECT * FROM ${quoteIdent(out.name)} LIMIT 100;`);
        setFlash({
          tone: "good",
          text: `Imported ${file.name} as table ${out.name}: ${plural(out.rows, "row")}, ${plural(out.columns.length, "column")} (${out.columns.join(", ")}). Column types were inferred (INTEGER, REAL or TEXT).`,
        });
        return true;
      });
      if (!imported) return;
    }
  };

  const newDatabase = () => {
    void work("open", async (engine, signal) => {
      applyState(await engine.open(null, "empty database", { signal }));
      setDbName("memory");
      setOutcome(null);
      setFlash({ tone: "info", text: "Started a new empty in-memory database." });
    });
  };

  const loadSample = () => {
    void work("open", async (engine, signal) => {
      await engine.open(null, "empty database", { signal });
      const out = await engine.run(SAMPLE_RUN_SQL, { signal, keepResults: true });
      applyState(out.state);
      if (out.error) {
        setFlash({ tone: "error", text: `Sample failed: ${out.error.message}` });
        return;
      }
      setDbName("shop-sample");
      setOutcome(null);
      setSqlText(RUN_EXAMPLE_QUERY);
      setFlash({ tone: "good", text: "Loaded the sample shop database (customers, products, orders, order_items). Press Run query." });
    });
  };

  const createFromSchema = () => {
    if (!stored) return;
    void work("query", async (engine, signal) => {
      const out = await engine.run(schemaToSqliteDdl(stored.schema), { signal, keepResults: true });
      applyState(out.state);
      setFlash(
        out.error
          ? { tone: "error", text: `Could not create tables: ${out.error.message}` }
          : { tone: "good", text: `Created ${plural(stored.schema.tables.length, "table")} from the current schema (existing tables were left alone).` },
      );
    });
  };

  const useAsSchema = () => {
    void work("task", async (engine) => {
      const schema = await engine.schema();
      saveSchema(schema, `Run tab: ${dbName}`);
      setFlash({ tone: "good", text: `Saved ${plural(schema.tables.length, "table")} from ${dbName} as the current schema (used by Validate and Build).` });
    });
  };

  const exportDb = () => {
    void work("task", async (engine) => {
      const bytes = await engine.exportDb();
      const base = safeFilename(dbName.replace(/\.[^.]+$/, "")) || "database";
      downloadBlob(new Blob([bytes.slice().buffer], { type: "application/vnd.sqlite3" }), `${base}.sqlite`);
      setFlash({ tone: "good", text: `Exported ${base}.sqlite (${formatBytes(bytes.length)}).` });
    });
  };

  const explain = () => {
    void work("task", async (engine, signal) => {
      let first: string;
      try {
        first = (await engine.firstStatement(sqlText)).replace(/;\s*$/, "");
      } catch (e) {
        setFlash({ tone: "error", text: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (!first) {
        setFlash({ tone: "error", text: "Write a statement to explain first." });
        return;
      }
      const sql = `EXPLAIN QUERY PLAN ${first}`;
      const out = await engine.run(sql, { signal });
      setOutcome(out);
      setRunId((n) => n + 1);
      setOutcomeLabel("Query plan");
      applyState(out.state);
      setFlash(null);
      setHistory((h) => [{ id: (historyId.current += 1), sql, ms: out.ms, ok: !out.error }, ...h].slice(0, 25));
    });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      if (!busy) execute(sqlText);
    }
  };

  const idle = !busy;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <div className="min-w-0 lg:col-span-2" role="status" aria-live="polite" data-agent-region="run-status">
        {busy && now - busy.startedAt > 300 ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line-strong bg-raised/60 px-3 py-2 text-sm text-muted">
            <span className="min-w-0 flex-1">
              {BUSY_LABEL[busy.kind].running}… {formatElapsed(now - busy.startedAt)} elapsed{busy.detail ? `, ${busy.detail}` : ""}. The page stays usable; Cancel stops it and restores the last snapshot.
            </span>
            <Button size="sm" variant="danger" onClick={cancel}>{BUSY_LABEL[busy.kind].cancel}</Button>
          </div>
        ) : null}
      </div>

      <div className="min-w-0 space-y-4">
        <Panel title="Database">
          <div className="space-y-3">
            <div role="status" aria-live="polite" data-agent-region="database-status">
              <StatGrid>
                <Stat label="Open" value={<span className="break-all text-[13px]">{dbName}</span>} />
                <Stat label="Tables" value={formatInt(tables.length)} />
                <Stat label="Size" value={dbBytes === null ? "—" : formatBytes(dbBytes)} />
              </StatGrid>
            </div>
            <Dropzone
              multiple
              disabled={!idle}
              accept=".sqlite,.sqlite3,.db,.db3,.csv,.tsv,.txt,.json,.ndjson,.jsonl"
              hint="Choose a SQLite database to open, or CSV / TSV / JSON to import as a table (max 64 MB, stays in this tab)"
              onFiles={handleFiles}
            />
            <Field label="Table name for the next CSV/JSON import" hint="Leave empty to use the file name.">
              <TextInput value={importName} onChange={(e) => setImportName(e.target.value)} placeholder="orders" spellCheck={false} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={loadSample} disabled={!idle}>Load sample database</Button>
              <Button size="sm" onClick={newDatabase} disabled={!idle}>New empty database</Button>
              <Button size="sm" onClick={exportDb} disabled={!idle}>Export database (.sqlite)</Button>
            </div>
            <p className="text-xs text-faint">
              Queries and imports run in a background worker. A snapshot of the database is kept when it opens and after every batch that changes it
              (up to {formatBytes(64 * 1024 * 1024)}); Cancel restores it.
            </p>
            {flash ? (
              <div role={flash.tone === "error" ? "alert" : "status"}>
                <Notice tone={flash.tone}>{flash.text}</Notice>
              </div>
            ) : null}
          </div>
        </Panel>

        <Panel title="Tables" right={<span className="text-xs text-faint">{plural(tables.length, "table")}</span>}>
          <div className="space-y-3" data-agent-region="table-list">
            {tables.length === 0 ? <p className="text-sm text-faint">No tables yet. Load the sample, import a CSV or JSON file, or run CREATE TABLE.</p> : null}
            <ul className="space-y-2">
              {tables.map((table) => (
                <li key={table.name} className="rounded-lg border border-line bg-raised/40 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-mono text-[13px] font-medium text-ink">{table.name}{table.isView ? " (view)" : ""}</span>
                    <span className="shrink-0 text-xs text-faint">{formatInt(table.rows)} rows</span>
                  </div>
                  <p className="mt-0.5 font-mono text-[11.5px] leading-relaxed break-words text-muted">
                    {table.columns.map((c) => `${c.name}${c.type ? ` ${c.type}` : ""}${c.pk ? " PK" : ""}`).join(", ")}
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-1 -ml-2"
                    disabled={!idle}
                    onClick={() => {
                      const sql = `SELECT * FROM ${quoteIdent(table.name)} LIMIT 100;`;
                      setSqlText(sql);
                      execute(sql);
                    }}
                  >
                    {`Preview ${table.name}`}
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={useAsSchema} disabled={!idle || tables.length === 0}>Use this database as current schema</Button>
              <Button size="sm" onClick={createFromSchema} disabled={!idle || !stored}>Create tables from current schema</Button>
            </div>
            <CurrentSchemaRegion />
          </div>
        </Panel>
      </div>

      <div className="min-w-0 space-y-4">
        <Panel
          title="SQL"
          right={
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setSqlText(RUN_EXAMPLE_QUERY)}>Example query</Button>
              <Button size="sm" variant="ghost" onClick={() => setSqlText("")} disabled={!sqlText}>Clear SQL</Button>
            </div>
          }
        >
          <div className="space-y-3">
            <Field label="SQL to run" hint="Multiple statements are fine. Ctrl/Cmd+Enter runs. Statements run in a background worker in your browser against the open database.">
              <TextArea rows={9} spellCheck={false} value={sqlText} onChange={(e) => setSqlText(e.target.value)} onKeyDown={onKey} onFocus={() => engine.warm()} placeholder="SELECT * FROM my_table LIMIT 10;" />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => execute(sqlText)} disabled={!idle}>Run query</Button>
              <Button onClick={explain} disabled={!idle}>EXPLAIN QUERY PLAN (first statement)</Button>
            </div>
          </div>
        </Panel>

        <Panel title={outcomeLabel} right={outcome ? <span className="text-xs text-faint">{formatMs(outcome.ms)} total</span> : null}>
          <div className="space-y-4" data-agent-region="query-results" aria-live="polite">
            {!outcome ? <p className="text-sm text-faint">Run a query to see results here.</p> : null}
            {engine && outcome?.results.map((result) => <ResultCard key={`${runId}-${result.index}`} result={result} engine={engine} />)}
            {outcome?.error ? (
              <div role="alert">
                <Notice tone="error">
                  Statement {outcome.error.index} failed: {outcome.error.message}
                  {outcome.results.length ? ` ${outcome.results.length === 1 ? "Statement 1 ran" : `Statements 1–${outcome.results.length} ran`} before the error and stays applied (SQLite autocommit); later statements were skipped.` : ""}
                </Notice>
                <pre className="mt-2 sk-input overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap">{outcome.error.sql}</pre>
              </div>
            ) : null}
            {outcome && !outcome.error && outcome.results.length === 0 ? <Notice>Done: no statements produced results.</Notice> : null}
          </div>
        </Panel>

        <Panel title="Query history" right={<span className="text-xs text-faint">This session only, kept in memory</span>}>
          {history.length === 0 ? <p className="text-sm text-faint">Nothing run yet.</p> : null}
          <ul className="space-y-1.5" data-agent-region="query-history">
            {history.map((entry) => (
              <li key={entry.id} className="flex items-center gap-2">
                <Button size="sm" variant="ghost" className="min-w-0 flex-1 justify-start" onClick={() => setSqlText(entry.sql)} aria-label={`Load query ${entry.id} into the editor`}>
                  <span className={cx("shrink-0 text-xs", entry.ok ? "text-good" : "text-danger")}>{entry.ok ? "ok" : entry.note ?? "failed"}</span>
                  <span className="truncate font-mono text-xs">{entry.sql.replace(/\s+/g, " ")}</span>
                </Button>
                <span className="shrink-0 text-xs text-faint">{formatMs(entry.ms)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function ResultCard({ result, engine }: { result: StatementMeta; engine: SqlEngine }) {
  const [exporting, setExporting] = useState<"csv" | "json" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const hasGrid = result.columns.length > 0;
  const totalText = `${formatInt(result.total)}${result.countCapped ? "+" : ""}`;
  const summary = hasGrid
    ? `${result.kind}: ${totalText} ${result.total === 1 ? "row" : "rows"} in ${formatMs(result.ms)}`
    : result.changes !== null
      ? `${result.kind}: ${plural(result.changes, "row")} affected in ${formatMs(result.ms)}`
      : `${result.kind}: done in ${formatMs(result.ms)}`;
  const base = `result-${result.index}`;
  const windowed = result.stored > result.inline.length;

  const exportAs = async (format: "csv" | "json") => {
    setExporting(format);
    setExportError(null);
    try {
      downloadBlob(await engine.exportRows(result.index, format), `${base}.${format}`);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(null);
    }
  };

  return (
    <section aria-label={`Statement ${result.index} result`} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-ink">Statement {result.index}: <span className="font-normal text-muted">{summary}</span></h3>
        {hasGrid ? (
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" disabled={exporting !== null} onClick={() => void exportAs("csv")}>
              {`Export statement ${result.index} as CSV`}
            </Button>
            <Button size="sm" disabled={exporting !== null} onClick={() => void exportAs("json")}>
              {`Export statement ${result.index} as JSON`}
            </Button>
          </div>
        ) : null}
      </div>
      {exporting ? <p role="status" className="text-xs text-muted">Preparing the {exporting.toUpperCase()} export of {formatInt(result.stored)} rows…</p> : null}
      {exportError ? <p role="alert" className="text-xs text-danger">{exportError}</p> : null}
      <pre className="overflow-auto rounded-md bg-raised/60 px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap text-muted">{result.sql}</pre>
      {hasGrid ? (
        <>
          {windowed ? (
            <WindowedGrid result={result} engine={engine} />
          ) : (
            <div className="max-h-[60vh] overflow-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label={`Statement ${result.index} rows`}>
              <table className="w-full border-collapse font-mono text-[12.5px]">
                <thead className="sticky top-0 bg-raised">
                  <tr>
                    {result.columns.map((c, i) => (
                      <th key={`${c}-${i}`} scope="col" className="border-b border-line-strong px-3 py-1.5 text-left font-semibold whitespace-nowrap text-ink">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.inline.map((row, r) => (
                    <tr key={r} className="odd:bg-raised/30">
                      {row.map((value, c) => (
                        <td key={c} className={cx("max-w-[28rem] border-b border-line px-3 py-1 align-top break-words whitespace-pre-wrap", value === null ? "text-faint italic" : "text-ink")}>
                          {displayValue(value)}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {result.inline.length === 0 ? (
                    <tr><td colSpan={result.columns.length} className="px-3 py-3 text-faint">No rows.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}
          {result.total > result.stored ? (
            <Notice tone="warn">
              Only the first {formatInt(result.stored)} of {totalText} rows are kept for the grid and exports (limit {formatInt(MAX_STORED_ROWS)}); add LIMIT/WHERE to narrow the query.
            </Notice>
          ) : windowed ? (
            <Notice>
              All {formatInt(result.stored)} rows are in the scrolling grid above (only the visible rows are drawn); exports contain every row.
            </Notice>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** Row-windowed grid: draws only the visible rows and pulls blocks of rows from the worker as the user scrolls. */
function WindowedGrid({ result, engine }: { result: StatementMeta; engine: SqlEngine }) {
  const { index, columns, stored } = result;
  const scroller = useRef<HTMLDivElement>(null);
  const pending = useRef(new Set<number>());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(480);
  const [blocks, setBlocks] = useState<Map<number, SqlValue[][]>>(() => {
    const seeded = new Map<number, SqlValue[][]>();
    for (let b = 0; b * BLOCK < result.inline.length; b += 1) seeded.set(b, result.inline.slice(b * BLOCK, (b + 1) * BLOCK));
    return seeded;
  });

  const firstVisible = Math.min(stored - 1, Math.floor(scrollTop / ROW_H));
  const lastVisible = Math.min(stored - 1, Math.ceil((scrollTop + viewH) / ROW_H) - 1);
  const from = Math.max(0, firstVisible - OVERSCAN);
  const to = Math.min(stored - 1, lastVisible + OVERSCAN);

  useEffect(() => {
    const first = Math.floor(from / BLOCK);
    const last = Math.floor(to / BLOCK);
    for (let b = first; b <= last; b += 1) {
      if (blocks.has(b) || pending.current.has(b)) continue;
      pending.current.add(b);
      engine.rows(index, b * BLOCK, BLOCK).then(
        (rows) =>
          setBlocks((previous) => {
            const next = new Map(previous).set(b, rows);
            if (next.size > MAX_CACHED_BLOCKS) {
              const centre = Math.floor(from / BLOCK);
              const far = [...next.keys()].sort((x, y) => Math.abs(y - centre) - Math.abs(x - centre));
              for (const key of far.slice(0, next.size - MAX_CACHED_BLOCKS)) next.delete(key);
            }
            return next;
          }),
        () => undefined, // a newer run replaced this result; the card is about to unmount
      ).finally(() => pending.current.delete(b));
    }
  }, [blocks, engine, from, index, to]);

  useEffect(() => {
    if (scroller.current) setViewH(scroller.current.clientHeight);
  }, []);

  const rows: { n: number; cells: SqlValue[] | null }[] = [];
  for (let n = from; n <= to; n += 1) rows.push({ n, cells: blocks.get(Math.floor(n / BLOCK))?.[n % BLOCK] ?? null });

  return (
    <div className="space-y-1.5" data-agent-region={`statement-${index}-grid`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          Rows {formatInt(firstVisible + 1)}–{formatInt(lastVisible + 1)} of {formatInt(stored)}
        </span>
        <label className="flex items-center gap-1.5">
          <span>Jump to row</span>
          <input
            type="number"
            min={1}
            max={stored}
            aria-label={`Jump to row in statement ${index}`}
            className="sk-input h-7 w-28 px-2 text-xs"
            onChange={(e) => {
              const n = Number(e.target.value);
              if (scroller.current && Number.isFinite(n) && n >= 1) scroller.current.scrollTop = (Math.min(n, stored) - 1) * ROW_H;
            }}
          />
        </label>
      </div>
      <div
        ref={scroller}
        className="h-[60vh] overflow-auto rounded-lg border border-line"
        tabIndex={0}
        role="region"
        aria-label={`Statement ${index} rows`}
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          setViewH(e.currentTarget.clientHeight);
        }}
      >
        <table className="border-collapse font-mono text-[12.5px]" style={{ tableLayout: "fixed", width: Math.max(100, columns.length * 176) }} aria-rowcount={stored + 1}>
          <thead className="sticky top-0 z-10 bg-raised">
            <tr aria-rowindex={1}>
              {columns.map((c, i) => (
                <th key={`${c}-${i}`} scope="col" className="truncate border-b border-line-strong px-3 py-1.5 text-left font-semibold text-ink" style={{ width: 176, height: ROW_H }} title={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {from > 0 ? (
              <tr aria-hidden style={{ height: from * ROW_H }}><td colSpan={columns.length} /></tr>
            ) : null}
            {rows.map(({ n, cells }) => (
              <tr key={n} aria-rowindex={n + 2} className="odd:bg-raised/30" style={{ height: ROW_H }}>
                {columns.map((_, c) => {
                  const value = cells ? cells[c] : undefined;
                  const text = cells ? displayValue(value as SqlValue) : "…";
                  return (
                    <td key={c} title={cells ? text : undefined} className={cx("truncate border-b border-line px-3", !cells || value === null ? "text-faint italic" : "text-ink")} style={{ height: ROW_H }}>
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
            {to < stored - 1 ? (
              <tr aria-hidden style={{ height: (stored - 1 - to) * ROW_H }}><td colSpan={columns.length} /></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

