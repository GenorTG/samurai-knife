import type { Account, AccountStore } from "@/lib/accounts/store";
import { holdResponseFor } from "@/lib/db/barrier";
import type { AccountsView, CoreRuntime, WriteOptions } from "@/lib/db/core/runtime";
import {
  CoreConflictError,
  StorageUnavailableError,
  type AccountCodec,
  type CoreBatch,
  type CoreLoad,
  type CoreRepo,
  type CoreSnapshot,
  type McpKeyRecord,
  type SessionRecord,
} from "@/lib/db/core/types";

/**
 * Authoritative in-process cache of the core rows for a SINGLE-WRITER app whose database is a WAN hop away
 * (docs/DB-POSTGRES.md "Latency"). Loaded once at start; every read is answered from memory (0 round trips: the session
 * check, the account, the MCP key); every write changes memory synchronously (so the old "no await between read and
 * write" rule still serialises read-modify-writes) and is committed write-through:
 * - changes are collected per tick and sent as ONE batch = one prepared statement = one round trip = one transaction;
 * - one batch in flight at a time; what changes meanwhile goes in the next batch (group commit under load);
 * - the HTTP response that made a change is held until its batch is committed (barrier.ts + scripts/db-barrier.mjs),
 *   except `background` bookkeeping (lastSeenAt / lastUsedAt);
 * - a failed or conflicting commit rejects every waiting response (503), refuses writes while it reloads the state from
 *   the database (the source of truth) and then carries on;
 * - another writer's change (the accounts CLI, announced by NOTIFY) is merged by reloading when this writer is idle.
 * Optimistic concurrency: each account row has a version; a batch updates only the versions it read (CoreConflictError).
 */

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  promise.catch(() => undefined); // observed by the barrier / flushed(); never an unhandled rejection
  return { promise, resolve, reject };
}

export interface CoreCacheOptions {
  origin: string;
  codec: AccountCodec;
  log?: (line: string) => void;
  /** After every successful commit and every reload: the cache equals the database (verify mode mirrors the files). */
  onSynced?: () => void;
  /** First retry delay of the reload after a failed commit (doubles up to 30 s). */
  retryMs?: number;
}

export interface CoreCacheStats {
  commits: number;
  failures: number;
  conflicts: number;
  rows: number;
  lastCommitMs: number;
  state: "ready" | "recovering" | "fenced";
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class CoreCache implements CoreRuntime {
  readonly backend = "pg" as const;
  private view: AccountsView = { store: { version: 2, defaultAccountId: "", accounts: [] }, byId: new Map(), byEmail: new Map() };
  private sessionList: SessionRecord[] = [];
  private keyList: McpKeyRecord[] = [];
  /** What is committed: account versions, stored session hashes, stored key ids. */
  private accountVersions = new Map<string, string>();
  private storedSessions = new Set<string>();
  private storedKeys = new Set<string>();
  private storedDefault: string | null = null;
  private dirtyAccounts = new Set<string>();
  private dirtySessions = new Set<string>();
  private dirtyKeys = new Set<string>();
  private building = 1;
  private inflight: Promise<void> | null = null;
  private waiters = new Map<number, Deferred>();
  private flushScheduled = false;
  private state: CoreCacheStats["state"] = "ready";
  private readonly statsData = { commits: 0, failures: 0, conflicts: 0, rows: 0, lastCommitMs: 0 };

  private readonly repo: CoreRepo;
  private readonly options: CoreCacheOptions;

  constructor(repo: CoreRepo, options: CoreCacheOptions) {
    this.repo = repo;
    this.options = options;
  }

  // -- start ----------------------------------------------------------------------------------------------------------

  /** Loads the state (one round trip). An empty database gets the initial store (committed before this resolves). */
  async start(preloaded?: CoreLoad): Promise<void> {
    const loaded = preloaded ?? await this.repo.load();
    if (loaded.defaultAccountId === null && loaded.accounts.length === 0) {
      this.replace({ store: this.options.codec.initial(), sessions: loaded.sessions, keys: loaded.keys }, new Map(), null);
      for (const account of this.view.store.accounts) this.dirtyAccounts.add(account.id);
      this.changed(true);
      await this.flushed();
      return;
    }
    this.apply(loaded);
  }

  stats(): CoreCacheStats {
    return { ...this.statsData, state: this.state };
  }

  /** The state as the app sees it (copies). */
  snapshot(): CoreSnapshot {
    return { store: structuredClone(this.view.store), sessions: structuredClone(this.sessionList), keys: structuredClone(this.keyList) };
  }

  /** Decodes and installs a repository load, replacing everything (nothing may be dirty). */
  private apply(loaded: CoreLoad): void {
    const { codec } = this.options;
    const store = codec.parse({ defaultAccountId: loaded.defaultAccountId ?? "", accounts: loaded.accounts.map((row) => row.doc) }, loaded.legacyV1);
    const plaintext = codec.openSecrets(store);
    const versions = new Map(store.accounts.map((account, index) => [account.id, loaded.accounts[index].version]));
    this.replace({ store, sessions: loaded.sessions, keys: loaded.keys }, versions, loaded.defaultAccountId);
    if (plaintext) {
      // Rows holding a plaintext provider secret (hand-written): reseal them with the next commit.
      for (const account of store.accounts) this.dirtyAccounts.add(account.id);
      this.changed(true);
    } else {
      this.synced();
    }
  }

  private synced(): void {
    try {
      this.options.onSynced?.();
    } catch (error) {
      this.log(`after-sync hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private replace(snapshot: CoreSnapshot, versions: Map<string, string>, storedDefault: string | null): void {
    this.setView(snapshot.store);
    this.sessionList = snapshot.sessions;
    this.keyList = snapshot.keys;
    this.accountVersions = versions;
    this.storedSessions = new Set(snapshot.sessions.map((session) => session.hash));
    this.storedKeys = new Set(snapshot.keys.map((key) => key.id));
    this.storedDefault = storedDefault;
    this.dirtyAccounts.clear();
    this.dirtySessions.clear();
    this.dirtyKeys.clear();
  }

  private setView(store: AccountStore): void {
    this.view = {
      store,
      byId: new Map(store.accounts.map((account) => [account.id, account])),
      byEmail: new Map(store.accounts.filter((account) => account.email).map((account) => [account.email as string, account])),
    };
  }

  // -- reads ----------------------------------------------------------------------------------------------------------

  accountsView(): AccountsView {
    return this.view;
  }

  sessions(): readonly SessionRecord[] {
    return this.sessionList;
  }

  keys(): readonly McpKeyRecord[] {
    return this.keyList;
  }

  // -- writes ---------------------------------------------------------------------------------------------------------

  private assertWritable(): void {
    if (this.state === "fenced") throw new StorageUnavailableError("this server lost the database writer lock; writes are refused until it restarts");
    if (this.state === "recovering") throw new StorageUnavailableError("the database is reloading after a failed commit; try again in a moment");
  }

  mutateAccounts<T>(fn: (store: AccountStore) => T): T {
    this.assertWritable();
    const draft = structuredClone(this.view.store);
    const result = fn(draft);
    const next = this.options.codec.parse({ defaultAccountId: draft.defaultAccountId, accounts: draft.accounts }, false);
    let changed = false;
    const ids = new Set<string>();
    for (const account of next.accounts) {
      ids.add(account.id);
      const old = this.view.byId.get(account.id);
      if (!old || !same(old, account)) {
        this.dirtyAccounts.add(account.id);
        changed = true;
      }
    }
    for (const id of this.view.byId.keys()) {
      if (!ids.has(id)) {
        this.dirtyAccounts.add(id);
        changed = true;
      }
    }
    if (next.defaultAccountId !== this.view.store.defaultAccountId) changed = true;
    this.setView(next);
    if (changed) this.changed(false);
    return result;
  }

  setSessions(next: SessionRecord[], options: WriteOptions = {}): void {
    this.assertWritable();
    const changed = this.diffInto(this.sessionList, next, (session) => session.hash, this.dirtySessions);
    this.sessionList = next;
    if (changed) this.changed(options.background === true);
  }

  setKeys(next: McpKeyRecord[], options: WriteOptions = {}): void {
    this.assertWritable();
    const changed = this.diffInto(this.keyList, next, (key) => key.id, this.dirtyKeys);
    this.keyList = next;
    if (changed) this.changed(options.background === true);
  }

  private diffInto<T>(before: readonly T[], after: readonly T[], idOf: (row: T) => string, dirty: Set<string>): boolean {
    const old = new Map(before.map((row) => [idOf(row), row]));
    let changed = false;
    for (const row of after) {
      const id = idOf(row);
      const previous = old.get(id);
      old.delete(id);
      if (!previous || !same(previous, row)) {
        dirty.add(id);
        changed = true;
      }
    }
    for (const id of old.keys()) {
      dirty.add(id);
      changed = true;
    }
    return changed;
  }

  private waiterFor(gen: number): Deferred {
    let waiter = this.waiters.get(gen);
    if (!waiter) {
      waiter = deferred();
      this.waiters.set(gen, waiter);
    }
    return waiter;
  }

  private changed(background: boolean): void {
    const waiter = this.waiterFor(this.building);
    if (!background) holdResponseFor(waiter.promise);
    this.scheduleFlush();
  }

  private hasDirty(): boolean {
    return this.dirtyAccounts.size > 0 || this.dirtySessions.size > 0 || this.dirtyKeys.size > 0 || this.view.store.defaultAccountId !== this.storedDefault;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.inflight) return;
    this.flushScheduled = true;
    // After the current tick: everything one request changes synchronously goes into the same batch.
    setImmediate(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  flushed(): Promise<void> {
    if (this.hasDirty()) {
      const waiter = this.waiterFor(this.building);
      this.scheduleFlush();
      return waiter.promise;
    }
    if (this.inflight) return this.waiterFor(this.building - 1).promise;
    return Promise.resolve();
  }

  private buildBatch(): { batch: CoreBatch; rows: number } {
    const { codec, origin } = this.options;
    const batch: CoreBatch = { origin };
    let rows = 0;
    if (this.view.store.defaultAccountId !== this.storedDefault) {
      batch.defaultAccountId = this.view.store.defaultAccountId;
      rows += 1;
    }
    const upsert: { doc: Account; expect: string | null }[] = [];
    const remove: { id: string; expect: string }[] = [];
    for (const id of this.dirtyAccounts) {
      const current = this.view.byId.get(id);
      const version = this.accountVersions.get(id);
      if (current) upsert.push({ doc: codec.sealAccount(current), expect: version ?? null });
      else if (version !== undefined) remove.push({ id, expect: version });
    }
    if (upsert.length || remove.length) batch.accounts = { upsert, delete: remove };
    const pick = <T>(dirty: Set<string>, list: readonly T[], idOf: (row: T) => string, stored: Set<string>) => {
      const byId = new Map(list.map((row) => [idOf(row), row]));
      const up: T[] = [];
      const down: string[] = [];
      for (const id of dirty) {
        const row = byId.get(id);
        if (row) up.push(structuredClone(row));
        else if (stored.has(id)) down.push(id);
      }
      return up.length || down.length ? { upsert: up, delete: down } : undefined;
    };
    const sessions = pick(this.dirtySessions, this.sessionList, (session) => session.hash, this.storedSessions);
    const keys = pick(this.dirtyKeys, this.keyList, (key) => key.id, this.storedKeys);
    if (sessions) batch.sessions = sessions;
    if (keys) batch.keys = keys;
    rows += upsert.length + remove.length + (sessions ? sessions.upsert.length + sessions.delete.length : 0) + (keys ? keys.upsert.length + keys.delete.length : 0);
    this.dirtyAccounts.clear();
    this.dirtySessions.clear();
    this.dirtyKeys.clear();
    return { batch, rows };
  }

  private settle(upTo: number, error: Error | null): void {
    for (const [gen, waiter] of this.waiters) {
      if (gen > upTo) continue;
      this.waiters.delete(gen);
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  private flush(): void {
    if (this.inflight || this.state !== "ready") return;
    if (!this.hasDirty()) {
      this.settle(this.building - 1, null);
      return;
    }
    const gen = this.building;
    this.building += 1;
    const { batch, rows } = this.buildBatch();
    const started = performance.now();
    const committedDefault = batch.defaultAccountId;
    this.inflight = this.repo.commit(batch).then((result) => {
      for (const { doc } of batch.accounts?.upsert ?? []) this.accountVersions.set(doc.id, result.versions[doc.id]);
      for (const { id } of batch.accounts?.delete ?? []) this.accountVersions.delete(id);
      for (const session of batch.sessions?.upsert ?? []) this.storedSessions.add(session.hash);
      for (const hash of batch.sessions?.delete ?? []) this.storedSessions.delete(hash);
      for (const key of batch.keys?.upsert ?? []) this.storedKeys.add(key.id);
      for (const id of batch.keys?.delete ?? []) this.storedKeys.delete(id);
      if (committedDefault !== undefined) this.storedDefault = committedDefault;
      this.statsData.commits += 1;
      this.statsData.rows += rows;
      this.statsData.lastCommitMs = performance.now() - started;
      this.inflight = null;
      this.settle(gen, null);
      this.synced();
      if (this.hasDirty()) this.flush();
      else this.settle(this.building - 1, null);
    }, (error: unknown) => {
      this.inflight = null;
      this.failed(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private failed(error: Error): void {
    this.statsData.failures += 1;
    if (error instanceof CoreConflictError) this.statsData.conflicts += 1;
    this.log(`commit failed (${error.name}: ${error.message}); reloading from the database`);
    this.state = "recovering";
    this.settle(Number.POSITIVE_INFINITY, new StorageUnavailableError(`the change was not saved: ${error.message}`));
    void this.recover();
  }

  private async recover(): Promise<void> {
    let delay = this.options.retryMs ?? 500;
    for (;;) {
      try {
        const loaded = await this.repo.load();
        if (this.state === "fenced") return;
        this.apply(loaded);
        this.state = "ready";
        this.log("reloaded after a failed commit");
        if (this.hasDirty()) this.scheduleFlush();
        return;
      } catch (error) {
        this.log(`reload failed (${error instanceof Error ? error.message : String(error)}); retrying in ${delay} ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  /** Another writer changed rows (NOTIFY): reload once this writer is idle, so no local change is overwritten. */
  async refresh(): Promise<boolean> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await this.flushed().catch(() => undefined);
      if (this.state !== "ready") return false;
      const loaded = await this.repo.load();
      if (this.state === "ready" && !this.inflight && !this.hasDirty()) {
        this.apply(loaded);
        return true;
      }
    }
    this.log("could not reload: this writer stayed busy; the next notification tries again");
    return false;
  }

  /** The writer lock is gone (another instance may write): refuse every write until `unfence`. */
  fence(reason: string): void {
    this.state = "fenced";
    this.log(`FENCED: ${reason}`);
    this.settle(Number.POSITIVE_INFINITY, new StorageUnavailableError(reason));
  }

  /** The writer lock is held again: reload (changes made meanwhile by others) and take writes again. */
  async unfence(): Promise<void> {
    if (this.state !== "fenced") return;
    this.state = "recovering";
    await this.recover();
  }

  private log(line: string): void {
    (this.options.log ?? ((text: string) => console.warn(`[db] ${text}`)))(line);
  }
}
