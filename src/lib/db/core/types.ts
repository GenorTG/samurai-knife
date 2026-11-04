import type { Account, AccountStore } from "@/lib/accounts/store";

/**
 * The core table data (accounts + provider profiles, sessions, MCP keys) behind one repository interface with two
 * implementations: FileCoreRepo (accounts.json / sessions.json / mcp-keys.json, today's format) and PgCoreRepo
 * (Postgres, db/migrations/0001_core.sql). Contract: docs/DB-POSTGRES.md. Both are async; the authoritative in-process
 * cache (cache.ts) keeps the callers synchronous. Further areas (CV, goals, conversations…) follow the same pattern:
 * a `<area>/types.ts` with Load/Batch/Repo, a file and a pg repo, and a cache or plain async calls.
 */

/** sessions.json record: the cookie's SHA-256 (hex), never the cookie. */
export interface SessionRecord {
  hash: string;
  accountId: string;
  /** Fingerprint of the password hash the session was created under (a new password ends it). */
  pf: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

export type McpKeyScope = "full" | "read-only";

/** mcp-keys.json record: the key's SHA-256 (hex), never the key. */
export interface McpKeyRecord {
  id: string;
  accountId: string;
  name: string;
  hash: string;
  /** First characters of the key, shown in the list so the owner can tell keys apart. */
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Missing on keys made before scopes existed: full. */
  scope?: McpKeyScope;
}

/** The whole core state as the app sees it (provider secrets OPEN). */
export interface CoreSnapshot {
  store: AccountStore;
  sessions: SessionRecord[];
  keys: McpKeyRecord[];
}

/** An account row as stored: provider secrets SEALED, plus the optimistic-concurrency version (opaque string). */
export interface StoredAccount {
  doc: unknown;
  version: string;
}

/** What a repository returns: rows as stored (accounts not yet validated or opened). */
export interface CoreLoad {
  /** null = no store yet (first start: the initial store is created by the cache). */
  defaultAccountId: string | null;
  /** v1 files (no `version`) are migrated by the codec; Postgres rows are always v2. */
  legacyV1: boolean;
  accounts: StoredAccount[];
  sessions: SessionRecord[];
  keys: McpKeyRecord[];
}

/** One atomic commit: the final state of every row that changed since the last commit. */
export interface CoreBatch {
  /** Writer id, echoed in change notifications so a writer ignores its own. */
  origin: string;
  defaultAccountId?: string;
  accounts?: {
    /** `doc` has provider secrets sealed; `expect` = the version read (null: the row must not exist yet). */
    upsert?: { doc: Account; expect: string | null }[];
    delete?: { id: string; expect: string }[];
  };
  sessions?: { upsert?: SessionRecord[]; delete?: string[] };
  keys?: { upsert?: McpKeyRecord[]; delete?: string[] };
}

export interface CommitResult {
  /** New version of every upserted account. */
  versions: Record<string, string>;
}

export interface CoreRepo {
  readonly kind: "files" | "pg";
  load(): Promise<CoreLoad>;
  /** All or nothing. Throws CoreConflictError when an `expect` does not match. */
  commit(batch: CoreBatch): Promise<CommitResult>;
  close(): Promise<void>;
}

/** Another writer changed a row this batch expected unchanged; nothing was written. */
export class CoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreConflictError";
  }
}

/** Storage cannot take writes right now (commit failed, reloading, or this process lost the writer lock). HTTP 503. */
export class StorageUnavailableError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

/** Parse/validate/seal rules of the account store (implemented by src/lib/accounts/store.ts, injected to avoid cycles). */
export interface AccountCodec {
  /** Validates a whole store (unique ids/emails/GitHub ids, default account), lowercases emails. Secrets untouched. */
  parse(raw: { defaultAccountId: string; accounts: unknown[] }, legacyV1: boolean): AccountStore;
  /** Opens sealed provider secrets in place; true when a plaintext secret was found. */
  openSecrets(store: AccountStore): boolean;
  /** A copy with every provider secret sealed. */
  sealAccount(account: Account): Account;
  /** The store a first start creates. */
  initial(): AccountStore;
}

/** A sessions.json row as the file code accepts it (others are dropped: fail closed, never a crash). */
export function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return ["hash", "accountId", "pf", "createdAt", "expiresAt", "lastSeenAt"].every((key) => typeof r[key] === "string");
}

/** An mcp-keys.json row as the file code accepts it. */
export function isMcpKeyRecord(value: unknown): value is McpKeyRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return ["id", "accountId", "name", "hash", "hint", "createdAt"].every((key) => typeof r[key] === "string")
    && (r.lastUsedAt === null || typeof r.lastUsedAt === "string")
    && (r.scope === undefined || r.scope === "full" || r.scope === "read-only");
}
