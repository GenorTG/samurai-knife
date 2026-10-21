import { lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ACCOUNT_ID_PATTERN, ensureDataDir } from "@/lib/accounts/store";

/**
 * The one owner of every per-account path under `$KNIFE_DATA_DIR` (docs/ACCOUNTS.md "Data an account owns"). Stores never
 * join an account id into a path themselves: they ask `accountScope(id)` for their location, which validates the id once
 * (`ACCOUNT_ID_PATTERN`: no dot, slash or `..` possible) and builds every path through `safeJoin`, which refuses separators,
 * `..`, NUL and anything that resolves outside its base. The on-disk layout is the historical one (no migration needed):
 *
 *   cv/<id>.json, cv/<id>.snapshots/, cv/<id>.photo.jpg, cv/<id>.*   CV studio
 *   docs/<id>/                                                       office library (documents, folders, versions, trash)
 *   conversations/<id>/                                              assistant transcripts
 *   learn/<id>.json                                                  course progress
 *   usage/<id>.json                                                  token ledger
 *   workspace/<id>.json.enc                                          encrypted browser-tool drafts
 *   site/<id>.json                                                   website studio (connection, token, work branch, audits)
 *   craft-files/<id>/                                                Craft apps files saved from the apps (src/lib/craft/files.ts)
 *
 * Not on disk (so not listed): async job scratch dirs in os.tmpdir() (in-memory job store, counted by the quota while alive)
 * and the in-memory UI-bridge presence. A new per-account store gets a field here and an entry in `locations()`.
 */

export class StorageScopeError extends Error {
  readonly status = 400;
}

/** One path segment: no separators, no `.`/`..`, no NUL or control characters, at most 255 bytes. */
export function assertSegment(part: string): string {
  if (!part || part === "." || part === ".." || part.includes("/") || part.includes("\\") || /[\u0000-\u001f]/.test(part) || Buffer.byteLength(part) > 255) {
    throw new StorageScopeError(`invalid path segment ${JSON.stringify(part.slice(0, 40))}`);
  }
  return part;
}

/** `join(base, ...parts)` that can never leave `base` (each part one plain segment; the result re-checked after resolve). */
export function safeJoin(base: string, ...parts: string[]): string {
  const root = resolve(base);
  const target = resolve(root, ...parts.map(assertSegment));
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new StorageScopeError("path escapes its base");
  return target;
}

/** mkdir -p (0700) that refuses a symlink at the final component, so a planted link cannot redirect writes elsewhere. */
export function ensurePrivateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new StorageScopeError("storage directory is a symlink");
  return dir;
}

export interface AccountScope {
  readonly accountId: string;
  /** `$KNIFE_DATA_DIR` itself (created 0700). */
  readonly dataRoot: string;
  readonly cv: {
    /** `cv/` (shared directory, files prefixed by the account id). */
    dir: string;
    file: string;
    snapshots: string;
    photo: string;
    /** File-name prefix every CV file of this account starts with (`<id>.`; ids hold no dot, so no other account matches). */
    prefix: string;
  };
  /** `docs/<id>/`: the office library root. */
  readonly docs: string;
  /** `conversations/<id>/`. */
  readonly conversations: string;
  readonly learnFile: string;
  readonly usageFile: string;
  /** Encrypted account-owned drafts for browser tools. */
  readonly workspaceFile: string;
  /** Website studio: repository connection (with its token), work branch, audit history. */
  readonly siteFile: string;
  /** `craft-files/<id>/`: files the Craft apps saved to the account (index + sealed blobs). */
  readonly craftFiles: string;
  /** A path inside one of the account's directories; every part is one validated segment. */
  join(base: "docs" | "conversations", ...parts: string[]): string;
  /** Every top-level location the account owns (account deletion, storage usage). CV files are listed from disk. */
  locations(): string[];
}

export function isValidAccountId(accountId: string): boolean {
  return ACCOUNT_ID_PATTERN.test(accountId);
}

export function accountScope(accountId: string): AccountScope {
  if (!isValidAccountId(accountId)) throw new StorageScopeError("invalid account id");
  const root = ensureDataDir();
  const cvDir = safeJoin(root, "cv");
  const docs = safeJoin(root, "docs", accountId);
  const conversations = safeJoin(root, "conversations", accountId);
  const scope: AccountScope = {
    accountId,
    dataRoot: root,
    cv: {
      dir: cvDir,
      file: safeJoin(cvDir, `${accountId}.json`),
      snapshots: safeJoin(cvDir, `${accountId}.snapshots`),
      photo: safeJoin(cvDir, `${accountId}.photo.jpg`),
      prefix: `${accountId}.`,
    },
    docs,
    conversations,
    learnFile: safeJoin(root, "learn", `${accountId}.json`),
    usageFile: safeJoin(root, "usage", `${accountId}.json`),
    workspaceFile: safeJoin(root, "workspace", `${accountId}.json.enc`),
    siteFile: safeJoin(root, "site", `${accountId}.json`),
    craftFiles: safeJoin(root, "craft-files", accountId),
    join(base, ...parts) {
      return parts.length ? safeJoin(base === "docs" ? docs : conversations, ...parts) : base === "docs" ? docs : conversations;
    },
    locations() {
      return [conversations, docs, scope.learnFile, scope.usageFile, scope.workspaceFile, scope.siteFile, scope.craftFiles];
    },
  };
  return scope;
}

/** Directory of a per-account file, created 0700 (the shared `cv/`, `learn/`, `usage/` dirs). */
export function parentDir(path: string): string {
  return ensurePrivateDir(join(path, ".."));
}
