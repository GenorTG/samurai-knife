import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { accountCodec, accountsFileIn, dataDir, mirrorAccountsFile } from "@/lib/accounts/store";
import { pgConfig } from "@/lib/db/connect.mjs";
import { CoreCache } from "@/lib/db/core/cache";
import { decodeLoad, diffDigests, digestSnapshot } from "@/lib/db/core/compare";
import { FileCoreRepo } from "@/lib/db/core/file-repo";
import { PgCoreRepo, warmPool } from "@/lib/db/core/pg-repo";
import { installCoreRuntime } from "@/lib/db/core/runtime";
import { StorageUnavailableError } from "@/lib/db/core/types";

/**
 * Starts the Postgres core store (instrumentation.ts, before the first request; docs/DB-POSTGRES.md). In order:
 * 1. pool (TLS for any non-loopback host, keepalive, small: one app instance = one writer);
 * 2. the schema must have every migration this release needs (migrations are run by db:migrate, never here);
 * 3. the writer lock: a session advisory lock on a dedicated connection, held for the process lifetime. A second
 *    server against the same database refuses to start; losing the connection pauses writes (503) until the lock is
 *    held again, and if another process took it meanwhile this one stays read-only;
 * 4. LISTEN knife_core on the same connection (changes by the accounts CLI);
 * 5. one-round-trip load of the whole core state into the cache, warm-up of the prepared statements on the pool;
 * 6. KNIFE_DB_VERIFY=1: files mirrored after every commit, both sides compared at start and every few minutes.
 * Throws (the server must not serve) when any step fails.
 */

export const REQUIRED_MIGRATION = "0001_core";
/** Same key in docs/DB-POSTGRES.md; scripts/db-migrate.mjs uses 7355608001. */
const WRITER_LOCK = 7_355_608_002;
const STATE_KEY = Symbol.for("samurai-knife.db.core-state.v1");

interface CoreState {
  pool: pg.Pool;
  listener: pg.Client | null;
  cache: CoreCache;
  origin: string;
  timers: NodeJS.Timeout[];
  stopped: boolean;
}

const log = (line: string) => console.warn(`[db] ${line}`);

async function takeWriterLock(client: pg.Client): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [WRITER_LOCK]);
  return rows[0].ok;
}

export function coreState(): CoreState | undefined {
  return (globalThis as unknown as Record<symbol, CoreState | undefined>)[STATE_KEY];
}

export async function initCoreStorage(env: NodeJS.ProcessEnv = process.env): Promise<CoreCache> {
  const existing = coreState();
  if (existing && !existing.stopped) return existing.cache;
  const config = pgConfig(env, { applicationName: "samurai-knife" });
  const pool = new pg.Pool({ ...config, max: Math.max(1, Number(env.KNIFE_DB_POOL_MAX) || 4), idleTimeoutMillis: 0 });
  pool.on("error", (error) => log(`idle connection error: ${error.message}`));
  const origin = `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
  let listener: pg.Client | null = null;
  try {
    const migrations = await pool.query<{ id: string }>("SELECT id FROM schema_migrations WHERE id = $1", [REQUIRED_MIGRATION]).catch(() => ({ rows: [] }));
    if (!migrations.rows.length) throw new Error(`the database schema lacks migration ${REQUIRED_MIGRATION}: run npm run db:migrate first`);

    listener = new pg.Client(config);
    await listener.connect();
    if (!(await takeWriterLock(listener))) {
      throw new Error("another Smart Knife server holds the writer lock on this database (one writer per database; stop it first)");
    }
    await listener.query("LISTEN knife_core");

    const repo = new PgCoreRepo(pool);
    const loaded = await repo.load();
    if (loaded.defaultAccountId === null && loaded.accounts.length === 0 && existsSync(accountsFileIn(dataDir()))) {
      throw new Error(`the database has no accounts but ${accountsFileIn(dataDir())} exists: import it first (npm run db:import), or unset KNIFE_DB_URL`);
    }
    const verify = env.KNIFE_DB_VERIFY?.trim() === "1";
    const mirror = verify ? new FileCoreRepo(dataDir()) : null;
    const cache = new CoreCache(repo, {
      origin,
      codec: accountCodec,
      onSynced: mirror ? () => {
        const snapshot = cache.snapshot();
        mirrorAccountsFile(snapshot.store);
        mirror.mirror(snapshot.sessions, snapshot.keys);
      } : undefined,
    });
    if (verify && mirror) compareSides("start", loaded, mirror);
    await cache.start(loaded);
    await warmPool(pool, Math.min(2, Math.max(1, Number(env.KNIFE_DB_POOL_MAX) || 4)));
    installCoreRuntime(cache);

    const state: CoreState = { pool, listener, cache, origin, timers: [], stopped: false };
    (globalThis as unknown as Record<symbol, CoreState | undefined>)[STATE_KEY] = state;
    attachListener(state, listener, config);
    // Keeps the TCP/TLS path and the server-side backends warm (the primary is a WAN hop away); also notices a dead pool.
    state.timers.push(setInterval(() => {
      pool.query("SELECT 1").catch((error: Error) => log(`keepalive failed: ${error.message}`));
    }, 60_000));
    if (verify && mirror) {
      const every = Math.max(30, Number(env.KNIFE_DB_VERIFY_EVERY_SEC) || 300) * 1_000;
      state.timers.push(setInterval(() => {
        void cache.flushed().then(() => repo.load()).then((dbLoad) => compareSides("periodic", dbLoad, mirror, cache)).catch((error: Error) => log(`verify failed: ${error.message}`));
      }, every));
    }
    for (const timer of state.timers) timer.unref();
    const stats = cache.stats();
    log(`core store on Postgres: ${cache.accountsView().store.accounts.length} account(s), ${cache.sessions().length} session(s), ${cache.keys().length} MCP key(s); writer ${origin}${verify ? "; verify mode (files mirrored)" : ""} (${stats.state})`);
    return cache;
  } catch (error) {
    await listener?.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }
}

/** instrumentation.ts: start, or end the process (exit 78) so it never serves without its database. */
export async function initCoreStorageOrExit(): Promise<void> {
  try {
    await initCoreStorage();
  } catch (error) {
    console.error(`[db] refusing to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(78);
  }
}

/** Verify mode: database vs files (vs the cache); logs ids that differ, never values. */
function compareSides(when: string, dbLoad: Awaited<ReturnType<PgCoreRepo["load"]>>, files: FileCoreRepo, cache?: CoreCache): void {
  const db = digestSnapshot(decodeLoad(dbLoad, accountCodec));
  const fileLoad = files.loadSync();
  if (fileLoad.defaultAccountId === null) {
    log(`verify (${when}): no accounts.json yet; the mirror writes the files from the database`);
    return;
  }
  const disk = digestSnapshot(decodeLoad(fileLoad, accountCodec));
  const problems = diffDigests(db, disk).map((line) => `db<->files ${line}`);
  if (cache) problems.push(...diffDigests(db, digestSnapshot(cache.snapshot())).map((line) => `db<->cache ${line}`));
  const verify = ((globalThis as unknown as Record<symbol, { checks: number; mismatches: number } | undefined>)[Symbol.for("samurai-knife.db.verify.v1")] ??= { checks: 0, mismatches: 0 });
  verify.checks += 1;
  verify.mismatches += problems.length;
  if (!problems.length) log(`verify (${when}): database and files match (${db.size} record(s))`);
  for (const line of problems.slice(0, 50)) log(`verify (${when}) MISMATCH ${line}`);
  if (problems.length > 50) log(`verify (${when}): ${problems.length - 50} more mismatch(es)`);
}

function attachListener(state: CoreState, client: pg.Client, config: ReturnType<typeof pgConfig>): void {
  client.on("notification", (message) => {
    if (message.channel !== "knife_core" || !message.payload) return;
    let origin = "";
    try {
      origin = String((JSON.parse(message.payload) as { origin?: unknown }).origin ?? "");
    } catch {
      return;
    }
    if (origin === state.origin) return;
    void state.cache.refresh().then((ok) => {
      if (!ok) return;
      log(`reloaded after a change by ${origin || "another writer"}`);
      // The accounts CLI waits for this before it exits, so its change is visible to the very next request.
      if (origin) state.pool.query("SELECT pg_notify('knife_core_ack', $1)", [origin]).catch((error: Error) => log(`reload ack failed: ${error.message}`));
    });
  });
  const lost = (reason: string) => {
    if (state.stopped || state.listener !== client) return;
    state.listener = null;
    state.cache.fence(`lost the writer connection (${reason}); writes paused until the lock is held again`);
    void reconnect(state, config);
  };
  client.on("error", (error) => lost(error.message));
  client.on("end", () => lost("connection ended"));
}

async function reconnect(state: CoreState, config: ReturnType<typeof pgConfig>): Promise<void> {
  let delay = 500;
  while (!state.stopped) {
    const client = new pg.Client(config);
    try {
      await client.connect();
      if (!(await takeWriterLock(client))) {
        await client.end();
        log("FENCED for good: another server took the writer lock while this one was disconnected; restart this one only after stopping the other");
        return;
      }
      await client.query("LISTEN knife_core");
      state.listener = client;
      attachListener(state, client, config);
      await state.cache.unfence();
      log("writer lock held again; writes resumed");
      return;
    } catch (error) {
      await client.end().catch(() => undefined);
      log(`reconnect failed (${error instanceof Error ? error.message : String(error)}); retrying in ${delay} ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }
}

/**
 * Scripts (npm run storage): the core state loaded ONCE, read-only, without the writer lock (the server keeps it).
 * Every write throws, so a script can list accounts but never fork the state behind the running server's back.
 */
export async function loadReadOnlyCore(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const pool = new pg.Pool({ ...pgConfig(env, { applicationName: "samurai-knife-script" }), max: 1 });
  try {
    const snapshot = decodeLoad(await new PgCoreRepo(pool).load(), accountCodec);
    const view = {
      store: snapshot.store,
      byId: new Map(snapshot.store.accounts.map((account) => [account.id, account])),
      byEmail: new Map(snapshot.store.accounts.filter((account) => account.email).map((account) => [account.email as string, account])),
    };
    const refuse = (): never => {
      throw new StorageUnavailableError("read-only: this script loaded the Postgres core store without the writer lock (change accounts with npm run accounts)");
    };
    installCoreRuntime({
      backend: "pg",
      accountsView: () => view,
      mutateAccounts: refuse,
      sessions: () => snapshot.sessions,
      setSessions: refuse,
      keys: () => snapshot.keys,
      setKeys: refuse,
      flushed: () => Promise.resolve(),
    });
  } finally {
    await pool.end();
  }
}

/** Tests: release the lock, close the connections, uninstall the runtime. */
export async function stopCoreStorage(): Promise<void> {
  const state = coreState();
  if (!state || state.stopped) return;
  state.stopped = true;
  for (const timer of state.timers) clearInterval(timer);
  await state.cache.flushed().catch(() => undefined);
  installCoreRuntime(null);
  await state.listener?.end().catch(() => undefined);
  await state.pool.end().catch(() => undefined);
}
