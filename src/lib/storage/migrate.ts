import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { RESERVED } from "@/lib/accounts/flows";
import { reassignMcpKeys } from "@/lib/accounts/mcp-keys";
import { revokeAllSessions } from "@/lib/accounts/session";
import { ACCOUNT_ID_PATTERN, mutateStore, readStore, writePrivateFile } from "@/lib/accounts/store";
import { invalidateUsage, cvPaths } from "./quota";
import { isSealedBytes, openAccountBytes, sealAccountBytes } from "./sealed";
import { accountScope } from "./scope";

export interface SealReport {
  sealed: number;
  alreadySealed: number;
  files: string[];
}

function filesOf(path: string): string[] {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return [];
  }
  if (stat.isSymbolicLink()) return [];
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path).flatMap((name) => filesOf(join(path, name)));
}

/**
 * Seals every plaintext file an account owns (written before at-rest sealing), in place, keeping its mtime (conversation
 * pruning and version dates read it). Run with the server stopped: a write by the server between this read and rename
 * would be lost. Symlinks are skipped (never followed). `dryRun` only counts.
 */
export function sealAccountStorage(accountId: string, options: { dryRun?: boolean } = {}): SealReport {
  const scope = accountScope(accountId);
  const report: SealReport = { sealed: 0, alreadySealed: 0, files: [] };
  for (const path of [...scope.locations(), ...cvPaths(accountId)].flatMap(filesOf)) {
    const bytes = readFileSync(path);
    if (isSealedBytes(bytes)) {
      report.alreadySealed += 1;
      continue;
    }
    report.sealed += 1;
    report.files.push(path);
    if (options.dryRun) continue;
    const { atime, mtime } = lstatSync(path);
    writePrivateFile(path, sealAccountBytes(accountId, bytes));
    utimesSync(path, atime, mtime);
  }
  if (!options.dryRun) invalidateUsage(accountId);
  return report;
}

/**
 * The reverse, for a rollback to a build from before sealing: opens every sealed file of the account in place (same
 * rules: server stopped, mtimes kept, symlinks skipped). `sealed` counts the files opened.
 */
export function unsealAccountStorage(accountId: string, options: { dryRun?: boolean } = {}): SealReport {
  const scope = accountScope(accountId);
  const report: SealReport = { sealed: 0, alreadySealed: 0, files: [] };
  for (const path of [...scope.locations(), ...cvPaths(accountId)].flatMap(filesOf)) {
    const bytes = readFileSync(path);
    if (!isSealedBytes(bytes)) continue;
    report.sealed += 1;
    report.files.push(path);
    if (options.dryRun) continue;
    const { atime, mtime } = lstatSync(path);
    writePrivateFile(path, openAccountBytes(accountId, bytes));
    utimesSync(path, atime, mtime);
  }
  if (!options.dryRun) invalidateUsage(accountId);
  return report;
}

export interface RenameReport {
  files: number;
  sessionsRevoked: number;
  mcpKeysMoved: number;
}

/**
 * Renames an account and moves everything it owns (CV files, office library, conversations, course progress, usage,
 * drafts, website studio). Every file is opened with the old id and sealed again for the new one (the account id is
 * part of each file's key and AAD), mtimes kept. The account record keeps its fields (provider secrets are sealed again
 * under the new id by the store), MCP keys follow, sessions are revoked (sign in again). Run with the server stopped.
 */
export function renameAccount(fromId: string, toId: string): RenameReport {
  if (!ACCOUNT_ID_PATTERN.test(toId) || RESERVED.has(toId)) throw new Error(`'${toId}' is not a usable username (lowercase letters, digits, - and _; not reserved)`);
  const store = readStore();
  if (!store.accounts.some((a) => a.id === fromId)) throw new Error(`no account ${fromId}`);
  if (store.accounts.some((a) => a.id === toId)) throw new Error(`an account ${toId} already exists`);
  const from = accountScope(fromId);
  const to = accountScope(toId);
  const moves: [string, string][] = [
    [from.conversations, to.conversations],
    [from.join("docs"), to.join("docs")],
    [from.learnFile, to.learnFile],
    [from.usageFile, to.usageFile],
    [from.workspaceFile, to.workspaceFile],
    [from.siteFile, to.siteFile],
    // cv/<id>.json, cv/<id>.photo.jpg, cv/<id>.snapshots/ ...: same name with the new id in front.
    ...cvPaths(fromId).map((p): [string, string] => [p, join(dirname(p), `${toId}${basename(p).slice(fromId.length)}`)]),
  ];
  let files = 0;
  for (const [src, dst] of moves) {
    if (!existsSync(src)) continue;
    if (existsSync(dst)) throw new Error(`${dst} already exists: refusing to overwrite`);
    for (const file of filesOf(src)) {
      const target = join(dst, file.slice(src.length));
      const { atime, mtime } = lstatSync(file);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writePrivateFile(target, sealAccountBytes(toId, openAccountBytes(fromId, readFileSync(file))));
      utimesSync(target, atime, mtime);
      files += 1;
    }
  }
  mutateStore((s) => {
    const account = s.accounts.find((a) => a.id === fromId)!;
    account.id = toId;
    if (s.defaultAccountId === fromId) s.defaultAccountId = toId;
  });
  const mcpKeysMoved = reassignMcpKeys(fromId, toId);
  const sessionsRevoked = revokeAllSessions(fromId);
  for (const [src] of moves) if (existsSync(src)) rmSync(src, { recursive: true, force: true });
  invalidateUsage(fromId);
  invalidateUsage(toId);
  return { files, sessionsRevoked, mcpKeysMoved };
}
