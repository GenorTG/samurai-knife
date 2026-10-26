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
import { msg, msgf } from "@/lib/i18n/msg";

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
  // `openClawResponses` in accounts written before 2026-10-25 (the removed Responses continuation) is stripped on read.
});

/**
 * A saved provider profile (endpoint, key, model…) with a name. The account's `provider` is always the active profile's
 * config (every existing caller keeps reading `provider`); the workflow AI node can pick any profile by id.
 */
export const PROFILE_ID = /^[a-z0-9]{1,24}$/;
const profileSchema = z.object({
  id: z.string().regex(PROFILE_ID),
  name: z.string().min(1).max(60),
  config: providerSchema,
});
export const MAX_PROVIDER_PROFILES = 20;

/** A single-use link token: only its SHA-256 (hex) is stored. */
const tokenSchema = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), expiresAt: z.string() });

const accountSchema = z.object({
  id: z.string().regex(ACCOUNT_ID_PATTERN),
  displayName: z.string().min(1).max(80),
  passwordHash: z.string().optional(),
  provider: providerSchema.nullable(),
  /** Saved provider profiles; `activeProviderProfile` names the one `provider` mirrors (null: none saved yet). */
  providerProfiles: z.array(profileSchema).max(MAX_PROVIDER_PROFILES).default([]),
  activeProviderProfile: z.string().regex(PROFILE_ID).nullable().default(null),
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
  /**
   * Public mode: a provider base URL outside the known provider hosts that an administrator approved for this account
   * (exact, normalized). null = known providers only. `src/lib/net/outbound.ts`; CLI `approve-provider`, admin API.
   */
  approvedProviderUrl: z.string().max(2_048).nullable().default(null),
  /**
   * Public mode: a website an administrator approved this account to audit when it cannot be verified through GitHub
   * (origin). null = verified sites only. `src/lib/site/ownership.ts`; CLI `approve-site`, admin API `site-url`.
   */
  approvedSiteUrl: z.string().max(2_048).nullable().default(null),
  /** The GitHub identity linked to this account ("Sign in with GitHub", docs/GITHUB.md); one account per GitHub user. */
  github: z.object({ id: z.number().int().positive(), login: z.string().max(100), linkedAt: z.string() }).nullable().default(null),
  /** Pending accounts only: keyed hash of the client address prefix that registered it (`ip-prefix.ts`), for the caps. */
  pendingIpp: z.string().max(32).optional(),
  /**
   * Public mode: when this account accepted the Terms of Service and privacy notice, and which version
   * (`src/lib/legal/legal.ts` legalVersion). null = created before the legal pages existed, or by the owner's CLI.
   */
  termsAcceptedAt: z.string().nullable().default(null),
  termsVersion: z.string().max(64).nullable().default(null),
  /** Interface language the user picked (src/lib/i18n): follows them to every device; null = the browser decides. */
  language: z.enum(["en", "pl"]).nullable().default(null),
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
export type ProviderProfile = z.infer<typeof profileSchema>;
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
      const sealConfig = (provider: ProviderConfig, profileId?: string): ProviderConfig => {
        const headers = provider.extraHeaders
          ? Object.fromEntries(Object.entries(provider.extraHeaders).map(([name, value]) => [name, sealValue(value, secretContext(account.id, { header: name }, profileId))]))
          : undefined;
        return { ...provider, apiKey: sealValue(provider.apiKey, secretContext(account.id, "apiKey", profileId)), ...(headers ? { extraHeaders: headers } : {}) };
      };
      return {
        ...account,
        provider: account.provider ? sealConfig(account.provider) : null,
        providerProfiles: (account.providerProfiles ?? []).map((profile) => ({ ...profile, config: sealConfig(profile.config, profile.id) })),
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
  const openConfig = (accountId: string, provider: ProviderConfig, profileId?: string) => {
    provider.apiKey = openValue(provider.apiKey, secretContext(accountId, "apiKey", profileId));
    if (provider.extraHeaders) {
      for (const name of Object.keys(provider.extraHeaders)) provider.extraHeaders[name] = openValue(provider.extraHeaders[name], secretContext(accountId, { header: name }, profileId));
    }
  };
  for (const account of store.accounts) {
    if (account.provider) openConfig(account.id, account.provider);
    for (const profile of account.providerProfiles ?? []) openConfig(account.id, profile.config, profile.id);
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

/**
 * Sets the account's provider (the active profile). With saved profiles the active one is updated too; the first
 * provider saved becomes the profile "Default", so `provider` and the profiles never disagree.
 */
export function setProvider(id: string, provider: ProviderConfig | null): Account | undefined {
  return mutateStore((store) => {
    const account = store.accounts.find((candidate) => candidate.id === id);
    if (!account) return undefined;
    account.provider = provider;
    if (!provider) {
      account.activeProviderProfile = null;
      return account;
    }
    const active = account.providerProfiles.find((profile) => profile.id === account.activeProviderProfile);
    if (active) active.config = structuredClone(provider);
    else if (account.providerProfiles.length < MAX_PROVIDER_PROFILES) {
      const profile = { id: newProfileId(account.providerProfiles), name: account.providerProfiles.length ? "Profile" : "Default", config: structuredClone(provider) };
      account.providerProfiles.push(profile);
      account.activeProviderProfile = profile.id;
    }
    return account;
  });
}

function newProfileId(existing: { id: string }[]): string {
  for (;;) {
    const id = randomBytes(6).toString("hex");
    if (!existing.some((profile) => profile.id === id)) return id;
  }
}

/**
 * The account's provider profiles. An account that set a provider before profiles existed shows it as "Default"
 * (materialized on its next profile change), so every caller sees the same list.
 */
export function providerProfilesOf(account: Account): ProviderProfile[] {
  if (account.providerProfiles.length) return account.providerProfiles;
  return account.provider ? [{ id: "default", name: "Default", config: account.provider }] : [];
}

export function activeProfileIdOf(account: Account): string | null {
  if (account.providerProfiles.length) return account.activeProviderProfile;
  return account.provider ? "default" : null;
}

export class ProfileError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function materializeProfiles(account: Account): void {
  if (!account.providerProfiles.length && account.provider) {
    account.providerProfiles = [{ id: "default", name: "Default", config: structuredClone(account.provider) }];
    account.activeProviderProfile = "default";
  }
}

/** Creates (no id) or replaces a profile; `activate` also makes it the account's provider. Returns the account and the id. */
export function saveProviderProfile(id: string, input: { profileId?: string; name: string; config: ProviderConfig; activate?: boolean }): { account: Account; profileId: string } {
  return mutateStore((store) => {
    const account = store.accounts.find((candidate) => candidate.id === id);
    if (!account) throw new ProfileError("account_not_found", 404);
    materializeProfiles(account);
    let profile = input.profileId ? account.providerProfiles.find((candidate) => candidate.id === input.profileId) : undefined;
    if (input.profileId && !profile) throw new ProfileError(msg("Unknown profile."), 404);
    if (!profile) {
      if (account.providerProfiles.length >= MAX_PROVIDER_PROFILES) throw new ProfileError(msgf("At most {maxProviderProfiles} profiles.", { maxProviderProfiles: MAX_PROVIDER_PROFILES }), 409);
      profile = { id: newProfileId(account.providerProfiles), name: input.name, config: structuredClone(input.config) };
      account.providerProfiles.push(profile);
    } else {
      profile.name = input.name;
      profile.config = structuredClone(input.config);
    }
    if (input.activate || account.activeProviderProfile === profile.id || !account.provider) {
      account.activeProviderProfile = profile.id;
      account.provider = structuredClone(profile.config);
    }
    return { account, profileId: profile.id };
  });
}

/** Makes a saved profile the account's provider (the assistant uses it from the next message on). */
export function activateProviderProfile(id: string, profileId: string): Account {
  return mutateStore((store) => {
    const account = store.accounts.find((candidate) => candidate.id === id);
    if (!account) throw new ProfileError("account_not_found", 404);
    materializeProfiles(account);
    const profile = account.providerProfiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw new ProfileError(msg("Unknown profile."), 404);
    account.activeProviderProfile = profile.id;
    account.provider = structuredClone(profile.config);
    return account;
  });
}

/** Deletes a profile; deleting the active one activates the next saved profile, or leaves no provider. */
export function deleteProviderProfile(id: string, profileId: string): Account {
  return mutateStore((store) => {
    const account = store.accounts.find((candidate) => candidate.id === id);
    if (!account) throw new ProfileError("account_not_found", 404);
    materializeProfiles(account);
    const index = account.providerProfiles.findIndex((candidate) => candidate.id === profileId);
    if (index < 0) throw new ProfileError(msg("Unknown profile."), 404);
    account.providerProfiles.splice(index, 1);
    if (account.activeProviderProfile === profileId) {
      const next = account.providerProfiles[0];
      account.activeProviderProfile = next?.id ?? null;
      account.provider = next ? structuredClone(next.config) : null;
    }
    return account;
  });
}

/** One profile's config (server-side only: holds the key), or undefined. */
export function providerProfileConfig(account: Account, profileId: string): ProviderConfig | undefined {
  return providerProfilesOf(account).find((profile) => profile.id === profileId)?.config;
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
}

export interface PublicProviderProfile extends PublicProvider {
  id: string;
  name: string;
  active: boolean;
}

export interface PublicAccount {
  id: string;
  displayName: string;
  requiresPassword: boolean;
  provider: PublicProvider | null;
  /** Saved provider profiles (no keys: hints only), the active one marked. */
  providerProfiles: PublicProviderProfile[];
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
  /** Interface language the user picked, or null (the browser decides). */
  language: "en" | "pl" | null;
}

export function maskKey(key: string): string | null {
  if (!key) return null;
  return key.length >= 12 ? `…${key.slice(-4)}` : "…";
}

export function toPublicProvider(provider: ProviderConfig): PublicProvider {
  return {
    baseUrl: provider.baseUrl,
    model: provider.model,
    hasKey: provider.apiKey.length > 0,
    keyHint: maskKey(provider.apiKey),
    extraHeaderNames: Object.keys(provider.extraHeaders ?? {}),
    reasoningEffort: provider.reasoningEffort ?? null,
  };
}

/** The only account shape that may leave the server. Never includes the key, the hash or a token. */
export function toPublicAccount(account: Account, mode: "private" | "public" = "private"): PublicAccount {
  const { provider } = account;
  const change = account.emailChange;
  const active = activeProfileIdOf(account);
  return {
    id: account.id,
    displayName: account.displayName,
    requiresPassword: Boolean(account.passwordHash),
    provider: provider ? toPublicProvider(provider) : null,
    providerProfiles: providerProfilesOf(account).map((profile) => ({ ...toPublicProvider(profile.config), id: profile.id, name: profile.name, active: profile.id === active })),
    email: account.email,
    emailVerified: account.emailVerifiedAt !== null,
    pendingEmail: change && Date.parse(change.expiresAt) > Date.now() ? change.email : null,
    role: account.role,
    isAdmin: mode === "private" || account.role === "admin",
    authMode: mode,
    github: account.github?.login ?? null,
    language: account.language ?? null,
  };
}

/** Saves the account's interface language (null: follow the browser). */
export function setAccountLanguage(id: string, language: "en" | "pl" | null): void {
  mutateStore((store) => {
    const account = store.accounts.find((candidate) => candidate.id === id);
    if (account) account.language = language;
  });
}
