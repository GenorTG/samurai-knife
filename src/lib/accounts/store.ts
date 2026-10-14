import * as z from "zod/v4";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Account store. Lives outside the repo (KNIFE_DATA_DIR or
 * ~/.local/share/samurai-knife) in `accounts.json` (0600, atomic writes).
 * scripts/accounts.mjs shares this file format. Accounts are created manually
 * only; there is no registration path.
 */

export const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const providerSchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string(),
  model: z.string().min(1),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  openClawResponses: z.boolean().optional(),
});

const accountSchema = z.object({
  id: z.string().regex(ACCOUNT_ID_PATTERN),
  displayName: z.string().min(1).max(80),
  passwordHash: z.string().optional(),
  provider: providerSchema.nullable(),
  createdAt: z.string(),
});

const storeSchema = z.object({
  defaultAccountId: z.string(),
  accounts: z.array(accountSchema).min(1),
}).refine((store) => store.accounts.some((account) => account.id === store.defaultAccountId), {
  message: "defaultAccountId does not match any account",
});

export type ProviderConfig = z.infer<typeof providerSchema>;
export type Account = z.infer<typeof accountSchema>;
export type AccountStore = z.infer<typeof storeSchema>;

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

function writeStore(store: AccountStore): void {
  writePrivateFile(accountsPath(), `${JSON.stringify(store, null, 2)}\n`);
}

export function readStore(): AccountStore {
  const path = accountsPath();
  if (!existsSync(path)) {
    const initial: AccountStore = {
      defaultAccountId: "genor",
      accounts: [{
        id: "genor",
        displayName: "Genor",
        provider: null,
        createdAt: new Date().toISOString(),
      }],
    };
    writeStore(initial);
    return initial;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`accounts.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = storeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`accounts.json is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

export function getAccount(id: string): Account | undefined {
  return readStore().accounts.find((account) => account.id === id);
}

export function getDefaultAccount(): Account {
  const store = readStore();
  const found = store.accounts.find((account) => account.id === store.defaultAccountId);
  if (!found) throw new Error("accounts.json has no default account");
  return found;
}

export function setProvider(id: string, provider: ProviderConfig | null): Account | undefined {
  const store = readStore();
  const account = store.accounts.find((candidate) => candidate.id === id);
  if (!account) return undefined;
  account.provider = provider;
  writeStore(store);
  return account;
}

/** Accounts that can sign in (have a password). Safe to show on a login form. */
export function loginChoices(): { id: string; displayName: string }[] {
  return readStore().accounts
    .filter((account) => account.passwordHash)
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
}

export function maskKey(key: string): string | null {
  if (!key) return null;
  return key.length >= 12 ? `…${key.slice(-4)}` : "…";
}

/** The only account shape that may leave the server. Never includes the key. */
export function toPublicAccount(account: Account): PublicAccount {
  const { provider } = account;
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
  };
}
