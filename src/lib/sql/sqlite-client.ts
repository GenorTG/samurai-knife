import type { SqlValue } from "sql.js";
import { isAbortError } from "../workers/errors";
import { WorkerPool } from "../workers/pool";
import { INLINE_ROWS, MAX_STORED_ROWS, type EngineState, type ImportOutput, type ImportProgress, type RunOutput, type RunProgress, type SqlTasks } from "./sqlite-protocol";
import type { SqlSchema } from "./types";

/** Where Cancel would take the database back to. */
export interface SnapshotInfo {
  /** "opened file" | "empty database" | "after statement batch" | "after import" */
  label: string;
  takenAt: number;
  bytes: number | null;
}

interface CallBase {
  signal?: AbortSignal;
}

/**
 * Main-thread handle on the SQLite worker. The database lives in the worker; this keeps the restore point that makes
 * Cancel safe: Cancel terminates the worker (the only way to stop a running statement) and `restore()` reopens the
 * last snapshot in a fresh one. Create it in an effect, never during render or SSR.
 */
export class SqlEngine {
  private readonly pool = new WorkerPool<SqlTasks>({
    size: 1,
    create: () => new Worker(new URL("./sqlite.worker.ts", import.meta.url)),
  });
  /** null = empty database. `stale` = the database outgrew the snapshot limit, so this snapshot is older than the live state. */
  private snapshot: Uint8Array | null = null;
  private snapshotInfo: SnapshotInfo = { label: "empty database", takenAt: Date.now(), bytes: 0 };
  private stale = false;
  /** The worker has a database open (it starts empty on first use). */
  private booted = false;
  private booting: Promise<unknown> | null = null;

  get restorePoint(): SnapshotInfo & { stale: boolean } {
    return { ...this.snapshotInfo, stale: this.stale };
  }

  dispose(): void {
    this.pool.terminateAll();
    this.booted = false;
    this.booting = null;
  }

  /** Start the worker and its empty database ahead of the first statement (SQL box focused). Never rejects. */
  warm(): void {
    void this.ensure().catch(() => undefined);
  }

  /** Every call goes through here: the first one boots the worker with an empty database. */
  private ensure(): Promise<unknown> {
    if (this.booted) return Promise.resolve();
    this.booting ??= this.pool.call("open", { bytes: null }).then(
      () => {
        this.booted = true;
      },
      (error: unknown) => {
        this.booting = null;
        throw error;
      },
    );
    return this.booting;
  }

  /** (Re)create the database from file bytes (which also become the restore point) or empty. */
  async open(bytes: Uint8Array | null, label: string, options: CallBase = {}): Promise<EngineState> {
    // The worker gets a copy: the original stays here as the restore point.
    const copy = bytes ? bytes.slice() : null;
    const state = await this.pool.call("open", { bytes: copy }, { signal: options.signal, transfer: copy ? [copy.buffer] : [] });
    this.snapshot = bytes;
    this.snapshotInfo = { label, takenAt: Date.now(), bytes: bytes ? bytes.length : 0 };
    this.stale = false;
    this.booted = true;
    return state;
  }

  /** After Cancel or a crash: bring the database back from the last snapshot. */
  restore(): Promise<EngineState> {
    const copy = this.snapshot ? this.snapshot.slice() : null;
    this.booted = true;
    return this.pool.call("open", { bytes: copy }, { transfer: copy ? [copy.buffer] : [] });
  }

  async run(sql: string, options: CallBase & { onProgress?: (p: RunProgress) => void; keepResults?: boolean } = {}): Promise<RunOutput> {
    const { keepResults, ...callOptions } = options;
    await this.ensure();
    const out = await this.pool.call("run", { sql, maxStored: MAX_STORED_ROWS, inline: INLINE_ROWS, keepResults }, callOptions);
    if (out.snapshot !== undefined) this.adoptSnapshot(out.snapshot, "after statement batch");
    return out;
  }

  async firstStatement(sql: string): Promise<string> {
    await this.ensure();
    return this.pool.call("firstStatement", { sql });
  }

  rows(statement: number, offset: number, limit: number): Promise<SqlValue[][]> {
    return this.pool.call("rows", { statement, offset, limit });
  }

  exportRows(statement: number, format: "csv" | "json"): Promise<Blob> {
    return this.pool.call("exportRows", { statement, format });
  }

  async exportDb(): Promise<Uint8Array> {
    await this.ensure();
    return this.pool.call("exportDb", null);
  }

  async schema(): Promise<SqlSchema> {
    await this.ensure();
    return this.pool.call("schema", null);
  }

  async importFile(file: { name: string; buffer: ArrayBuffer }, tableName: string, options: CallBase & { onProgress?: (p: ImportProgress) => void } = {}): Promise<ImportOutput> {
    await this.ensure();
    const out = await this.pool.call("importFile", { name: file.name, tableName, buffer: file.buffer }, { ...options, transfer: [file.buffer] });
    this.adoptSnapshot(out.snapshot, "after import");
    return out;
  }

  private adoptSnapshot(bytes: Uint8Array | null, label: string): void {
    if (bytes) {
      this.snapshot = bytes;
      this.snapshotInfo = { label, takenAt: Date.now(), bytes: bytes.length };
      this.stale = false;
    } else {
      this.stale = true;
    }
  }
}

export { isAbortError };
