import { lstatSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFile } from "@/lib/accounts/store";
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
