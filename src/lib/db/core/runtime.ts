import type { Account, AccountStore } from "@/lib/accounts/store";
import { StorageUnavailableError, type McpKeyRecord, type SessionRecord } from "@/lib/db/core/types";

/**
 * The hook the account, session and MCP-key modules use to reach the Postgres-backed core cache (cache.ts). Lives on
 * globalThis: Next loads instrumentation (which starts the cache) and the route handlers as separate module graphs.
 * File mode (KNIFE_DB_URL unset): `coreRuntime()` is null and those modules keep their file code unchanged.
 */

export interface AccountsView {
  store: AccountStore;
  byId: Map<string, Account>;
  byEmail: Map<string, Account>;
}

export interface WriteOptions {
  /**
   * Bookkeeping that may be lost on a crash (a session's lastSeenAt, an MCP key's lastUsedAt): committed with the next
   * batch, the HTTP answer never waits for it.
   */
  background?: boolean;
}

export interface CoreRuntime {
  readonly backend: "pg";
  /** The authoritative cached state. Never mutate it: callers copy (store.ts hands out structuredClone). */
  accountsView(): AccountsView;
  /** Same contract as store.ts mutateStore: synchronous, `fn` mutates a copy, validation errors write nothing. */
  mutateAccounts<T>(fn: (store: AccountStore) => T): T;
  sessions(): readonly SessionRecord[];
  setSessions(next: SessionRecord[], options?: WriteOptions): void;
  keys(): readonly McpKeyRecord[];
  setKeys(next: McpKeyRecord[], options?: WriteOptions): void;
  /** Resolves when everything changed so far is committed (rejects if that commit failed). */
  flushed(): Promise<void>;
}

const KEY = Symbol.for("samurai-knife.db.core.v1");
type Holder = Record<symbol, CoreRuntime | undefined>;

export function installCoreRuntime(runtime: CoreRuntime | null): void {
  const holder = globalThis as unknown as Holder;
  if (runtime) holder[KEY] = runtime;
  else delete holder[KEY];
}

export function dbConfigured(): boolean {
  return Boolean(process.env.KNIFE_DB_URL?.trim());
}

/**
 * The Postgres core cache, or null in file mode. Throws when KNIFE_DB_URL is set but the cache is not loaded: a script
 * or a build that would otherwise silently read (or create) accounts.json instead of the database.
 */
export function coreRuntime(): CoreRuntime | null {
  const runtime = (globalThis as unknown as Holder)[KEY];
  if (runtime) return runtime;
  if (dbConfigured()) {
    throw new StorageUnavailableError("KNIFE_DB_URL is set but the Postgres core store is not loaded (the server loads it at start; scripts use npm run accounts / db:*)");
  }
  return null;
}
