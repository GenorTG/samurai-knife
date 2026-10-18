import * as z from "zod/v4";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ensureKey, isSealed, open, readKey, seal, secretContext } from "@/lib/accounts/secret-box";

/**
 * Account store. Lives outside the repo (KNIFE_DATA_DIR or ~/.local/share/samurai-knife) in `accounts.json` (0600, atomic
 * writes). scripts/accounts.mjs shares this file format and the lock. Contract: docs/ACCOUNTS.md.
 *
 * Concurrency: every read-modify-write runs inside `mutateStore`, synchronously (no await between read and write), so two
 * requests in this server process can never interleave (Node runs one at a time); the lock file `accounts.json.lock`
 * (O_EXCL, stale after 10 s) serialises the server against the CLI. Expensive work (password hashing) happens before the
 * lock is taken. One file is fine at this scale (hundreds of accounts, a few KB each); per-account files would need an
 * index for the unique email/username checks, which is exactly what the single file gives for free.
 *
 * Format v2 (`version: 2`) adds email, role, status, quota and login times. v1 files (no `version`) are migrated in memory on
 * read and written back as v2 by the next mutation; every v1 account becomes an active admin (the owner's own accounts),
 * explicitly in `parseStore`. In a v2 file the defaults fail closed: a record without `role` is a user, one without
 * `status` is disabled (a hand edit or an import that forgets a field never creates an active admin).
 *
 * Reads are cached by the file's identity (path, inode, mtime, size), the same rule as sessions.json: a request that only
 * reads never parses or decrypts the file again; any write (ours or the CLI's) changes the identity. Callers get copies,
 * so mutating a returned account never touches the cache.
 *
 * Provider secrets (API key, extra-header values) are sealed on disk (`secret-box.ts`, AES-256-GCM, key file
 * `provider-keys.key`) and opened on read, so everything in this module sees plaintext. A file with plaintext secrets
 * (written before sealing, or hand-edited) is resealed by the first read.
 */

export const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const STORE_VERSION = 2;
/**
 * Storage quota a NEW registered account gets (registration, GitHub sign-up): KNIFE_USER_QUOTA_MB, default 1024 (1 GiB).
 * Read once at startup; stored per account, so changing it never touches existing accounts (the admin page does).
 */
export const DEFAULT_USER_QUOTA_BYTES = (() => {
  const parsed = Number.parseInt(process.env.KNIFE_USER_QUOTA_MB ?? "", 10);
  return (Number.isInteger(parsed) && parsed > 0 ? parsed : 1024) * 1024 ** 2;
})();

const providerSchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string(),
  model: z.string().min(1),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  openClawResponses: z.boolean().optional(),
});

/** A single-use link token: only its SHA-256 (hex) is stored. */
const tokenSchema = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), expiresAt: z.string() });

const accountSchema = z.object({
  id: z.string().regex(ACCOUNT_ID_PATTERN),
  displayName: z.string().min(1).max(80),
  passwordHash: z.string().optional(),
  provider: providerSchema.nullable(),
  createdAt: z.string(),
  email: z.string().nullable().default(null),
  emailVerifiedAt: z.string().nullable().default(null),
  role: z.enum(["admin", "user"]).default("user"),
  status: z.enum(["pending", "active", "disabled"]).default("disabled"),
  /** null = unlimited. Enforcement is a later phase; the value is stored and editable now. */
  storageQuotaBytes: z.number().int().nonnegative().nullable().default(null),
  lastLoginAt: z.string().nullable().default(null),
  verifyToken: tokenSchema.optional(),
  resetToken: tokenSchema.optional(),
  /** A requested address change; `email` changes only when the link sent to `emailChange.email` is opened. */
  emailChange: tokenSchema.extend({ email: z.string() }).optional(),
  /**
   * Public mode: this account's provider requests may reach loopback/LAN/Tailscale addresses (the owner's local models).
   * Honoured for admins only (`src/lib/net/outbound.ts`); set with `npm run accounts -- set-network` or the admin API.
   */
  privateNetwork: z.boolean().default(false),
  /** The GitHub identity linked to this account ("Sign in with GitHub", docs/GITHUB.md); one account per GitHub user. */
  github: z.object({ id: z.number().int().positive(), login: z.string().max(100), linkedAt: z.string() }).nullable().default(null),
  /** Pending accounts only: keyed hash of the client address prefix that registered it (`ip-prefix.ts`), for the caps. */
  pendingIpp: z.string().max(32).optional(),
});

const storeSchema = z.object({
  version: z.number().int().optional(),
  defaultAccountId: z.string(),
  accounts: z.array(accountSchema),
}).refine((store) => store.accounts.length === 0 || store.accounts.some((account) => account.id === store.defaultAccountId), {
  message: "defaultAccountId does not match any account",
}).refine((store) => new Set(store.accounts.map((account) => account.id)).size === store.accounts.length, {
  message: "two accounts share an id",
}).refine((store) => {
  const emails = store.accounts.map((account) => account.email).filter((email): email is string => email !== null);
  return new Set(emails).size === emails.length;
}, { message: "two accounts share an email address" }).refine((store) => {
  const ids = store.accounts.map((account) => account.github?.id).filter((id): id is number => typeof id === "number");
  return new Set(ids).size === ids.length;
}, { message: "two accounts are linked to the same GitHub user" });

export type ProviderConfig = z.infer<typeof providerSchema>;
export type Account = z.infer<typeof accountSchema>;
export type AccountStore = z.infer<typeof storeSchema>;
export type AccountRole = Account["role"];
export type AccountStatus = Account["status"];

export function dataDir(): string {
  const configured = process.env.KNIFE_DATA_DIR?.trim();
  return configured || join(homedir(), ".local", "share", "samurai-knife");
}

export function ensureDataDir(): string {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Not owned by us (e.g. a shared mount); best effort only.
  }
  return dir;
}

/** Atomic 0600 write: temp file in the same directory, then rename. */
export function writePrivateFile(path: string, contents: string | Uint8Array): void {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, contents, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function accountsPath(): string {
  return join(ensureDataDir(), "accounts.json");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Fills the v2 defaults for a new account record (the CLI writes the same shape). */
export function newAccountRecord(fields: Pick<Account, "id" | "displayName"> & Partial<Account>): Account {
  return accountSchema.parse({ provider: null, createdAt: new Date().toISOString(), ...fields });
}

function initialStore(): AccountStore {
  return {
    version: STORE_VERSION,
    defaultAccountId: "genor",
    accounts: [newAccountRecord({ id: "genor", displayName: "Genor", role: "admin", status: "active" })],
  };
}

/** A copy of `store` with every non-empty provider secret sealed (the key file is created on the first one). */
function sealSecrets(store: AccountStore): AccountStore {
  let key: Buffer | null = null;
  const sealValue = (value: string, context: string): string => {
    if (!value || isSealed(value)) return value;
    key ??= ensureKey(ensureDataDir(), writePrivateFile);
    return seal(key, value, context);
  };
  return {
    ...store,
    accounts: store.accounts.map((account) => {
      const provider = account.provider;
      if (!provider) return account;
      const headers = provider.extraHeaders
        ? Object.fromEntries(Object.entries(provider.extraHeaders).map(([name, value]) => [name, sealValue(value, secretContext(account.id, { header: name }))]))
        : undefined;
      return {
        ...account,
        provider: { ...provider, apiKey: sealValue(provider.apiKey, secretContext(account.id, "apiKey")), ...(headers ? { extraHeaders: headers } : {}) },
      };
    }),
  };
}

/** Opens sealed secrets in place; true when a plaintext secret was found (the file needs resealing). */
function openSecrets(store: AccountStore): boolean {
  let key: Buffer | null | undefined;
  let plaintext = false;
  const openValue = (value: string, context: string): string => {
    if (!value) return value;
    if (!isSealed(value)) {
      plaintext = true;
      return value;
    }
    key ??= readKey(dataDir());
    if (!key) throw new Error("accounts.json holds sealed provider keys but provider-keys.key is missing from the data directory");
    try {
      return open(key, value, context);
    } catch {
      throw new Error(`accounts.json: a provider secret (${context}) does not decrypt with provider-keys.key`);
    }
  };
  for (const account of store.accounts) {
    const provider = account.provider;
    if (!provider) continue;
    provider.apiKey = openValue(provider.apiKey, secretContext(account.id, "apiKey"));
    if (provider.extraHeaders) {
      for (const name of Object.keys(provider.extraHeaders)) provider.extraHeaders[name] = openValue(provider.extraHeaders[name], secretContext(account.id, { header: name }));
    }
  }
  return plaintext;
}

function writeStore(store: AccountStore): void {
  writePrivateFile(accountsPath(), `${JSON.stringify({ ...sealSecrets(store), version: STORE_VERSION }, null, 2)}\n`);
  cache = null;
}

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Exclusive lock shared with scripts/accounts.mjs (same file name and staleness rule). */
function withLock<T>(fn: () => T): T {
  const lock = `${accountsPath()}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch {
        // Removed by its owner meanwhile.
      }
      if (Date.now() > deadline) throw new Error("accounts.json is locked by another process (accounts.json.lock)");
      Atomics.wait(sleeper, 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}

/** v1 (no `version`): every record is the owner's, an active admin. Done explicitly, never through the schema defaults. */
function migrateV1(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const file = raw as { version?: unknown; accounts?: unknown };
  if (typeof file.version === "number" || !Array.isArray(file.accounts)) return raw;
  return {
    ...file,
    accounts: file.accounts.map((account: unknown) => (typeof account === "object" && account !== null
      ? { role: "admin", status: "active", ...(account as Record<string, unknown>) }
      : account)),
  };
}

function parseStore(raw: unknown): AccountStore {
  const parsed = storeSchema.safeParse(migrateV1(raw));
  if (!parsed.success) {
    throw new Error(`accounts.json is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  // Lowercase any hand-edited address.
  for (const account of parsed.data.accounts) if (account.email) account.email = normalizeEmail(account.email);
  return parsed.data;
}

/** Reads the file (secrets opened), or creates the initial one. Caller holds the lock when `locked`. */
function load(locked: boolean): AccountStore {
  return loadWithFlags(locked).store;
}

type FileIdentity = { path: string; ino: number; mtimeMs: number; size: number };

interface StoreCache extends FileIdentity {
  store: AccountStore;
  byId: Map<string, Account>;
  byEmail: Map<string, Account>;
}

let cache: StoreCache | null = null;

function identity(path: string): FileIdentity | null {
  try {
    const stat = statSync(path);
    return { path, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

const sameFile = (a: FileIdentity, b: FileIdentity): boolean => a.path === b.path && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size;

/** The cached parse of accounts.json (never handed out directly: callers get copies). */
function cachedStore(): StoreCache {
  const path = accountsPath();
  const before = identity(path);
  if (cache && before && sameFile(cache, before)) return cache;
  const { store, plaintext } = loadWithFlags(false);
  if (plaintext) {
    // Transparent migration: the next write seals them; do it now so plaintext keys do not wait for an unrelated change.
    try {
      mutateStore(() => undefined);
    } catch (error) {
      console.warn(`[accounts] could not reseal provider keys: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const after = identity(path);
  const fresh: StoreCache = {
    ...(after ?? { path, ino: -1, mtimeMs: -1, size: -1 }),
    store,
    byId: new Map(store.accounts.map((account) => [account.id, account])),
    byEmail: new Map(store.accounts.filter((account) => account.email).map((account) => [account.email as string, account])),
  };
  // Only cache what is known to match the file on disk now (a write between our read and this stat is re-read next time).
  cache = after && before && !plaintext && sameFile(before, after) ? fresh : null;
  return fresh;
}

/** Tests and the CLI interop suite: drop the cache (the next read parses the file). */
export function invalidateStoreCache(): void {
  cache = null;
}

function loadWithFlags(locked: boolean): { store: AccountStore; plaintext: boolean } {
  const path = accountsPath();
  if (!existsSync(path)) {
    const create = (): AccountStore => {
      if (existsSync(path)) return load(true);
      const initial = initialStore();
      writeStore(initial);
      return initial;
    };
    return { store: locked ? create() : withLock(create), plaintext: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`accounts.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const store = parseStore(raw);
  return { store, plaintext: openSecrets(store) };
}

/** A copy of the whole store (cheap reads: see the cache above). */
export function readStore(): AccountStore {
  return structuredClone(cachedStore().store);
}

/**
 * The one way to change accounts: lock, re-read, mutate, validate (unique ids and emails, default account), write. `fn`
 * must be synchronous and cheap; its return value is passed through. Throwing inside `fn` writes nothing.
 */
export function mutateStore<T>(fn: (store: AccountStore) => T): T {
  return withLock(() => {
    const store = load(true);
    const result = fn(store);
    writeStore(parseStore(store));
    return result;
  });
}

export function getAccount(id: string): Account | undefined {
  const found = cachedStore().byId.get(id);
  return found ? structuredClone(found) : undefined;
}

export function findByEmail(email: string): Account | undefined {
  const found = cachedStore().byEmail.get(normalizeEmail(email));
  return found ? structuredClone(found) : undefined;
}

/** Login identifier: a username, or an email address (anything with an @). */
export function findByIdentifier(identifier: string): Account | undefined {
  const value = identifier.trim();
  return value.includes("@") ? findByEmail(value) : getAccount(value.toLowerCase());
}

export function getDefaultAccount(): Account {
  const { store, byId } = cachedStore();
  const found = byId.get(store.defaultAccountId);
  if (!found) throw new Error("accounts.json has no default account");
  return structuredClone(found);
}

export function setProvider(id: string, provider: ProviderConfig | null): Account | undefined {
  return mutateStore((store) => {
    const account = store.accounts.find((candidate) => candidate.id === id);
    if (!account) return undefined;
    account.provider = provider;
    return account;
  });
}

/** Accounts that can sign in (have a password). Safe to show on a login form; empty in public mode (no user list leaks). */
export function loginChoices(publicMode: boolean): { id: string; displayName: string }[] {
  if (publicMode) return [];
  return readStore().accounts
    .filter((account) => account.passwordHash && account.status !== "disabled")
    .map((account) => ({ id: account.id, displayName: account.displayName }));
}

export interface PublicProvider {
  baseUrl: string;
  model: string;
  hasKey: boolean;
  keyHint: string | null;
  extraHeaderNames: string[];
  reasoningEffort: "low" | "medium" | "high" | null;
  openClawResponses: boolean;
}

export interface PublicAccount {
  id: string;
  displayName: string;
  requiresPassword: boolean;
  provider: PublicProvider | null;
  /** The signed-in user's own address (only ever returned to that user). */
  email: string | null;
  emailVerified: boolean;
  pendingEmail: string | null;
  role: AccountRole;
  /** May manage sidecars, users and server settings: every account in private mode, admins only in public mode. */
  isAdmin: boolean;
  authMode: "private" | "public";
  /** Linked GitHub login, or null. */
  github: string | null;
}

export function maskKey(key: string): string | null {
  if (!key) return null;
  return key.length >= 12 ? `…${key.slice(-4)}` : "…";
}

/** The only account shape that may leave the server. Never includes the key, the hash or a token. */
export function toPublicAccount(account: Account, mode: "private" | "public" = "private"): PublicAccount {
  const { provider } = account;
  const change = account.emailChange;
  return {
    id: account.id,
    displayName: account.displayName,
    requiresPassword: Boolean(account.passwordHash),
    provider: provider
      ? {
          baseUrl: provider.baseUrl,
          model: provider.model,
          hasKey: provider.apiKey.length > 0,
          keyHint: maskKey(provider.apiKey),
          extraHeaderNames: Object.keys(provider.extraHeaders ?? {}),
          reasoningEffort: provider.reasoningEffort ?? null,
          openClawResponses: provider.openClawResponses === true,
        }
      : null,
    email: account.email,
    emailVerified: account.emailVerifiedAt !== null,
    pendingEmail: change && Date.parse(change.expiresAt) > Date.now() ? change.email : null,
    role: account.role,
    isAdmin: mode === "private" || account.role === "admin",
    authMode: mode,
    github: account.github?.login ?? null,
  };
}
