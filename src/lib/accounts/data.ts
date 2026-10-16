import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_ID_PATTERN, dataDir } from "@/lib/accounts/store";

/**
 * Every place under $KNIFE_DATA_DIR that belongs to one account. Account deletion removes all of them; the admin list sums
 * their size. A new per-account store must be added here (docs/ACCOUNTS.md "Data an account owns").
 *
 *   cv/<id>.json, cv/<id>.snapshots/, cv/<id>.photo.jpg (and any other cv/<id>.* file)   CV studio
 *   conversations/<id>/                                                                 assistant transcripts
 *   docs/<id>/                                                                          office documents
 *   learn/<id>.json                                                                     course progress
 *   usage/<id>.json                                                                     token ledger
 * plus the account record in accounts.json and its sessions in sessions.json (removed by the caller).
 */
export function accountDataPaths(accountId: string): string[] {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error(`invalid account id ${accountId}`);
  const root = dataDir();
  const paths = [
    join(root, "conversations", accountId),
    join(root, "docs", accountId),
    join(root, "learn", `${accountId}.json`),
    join(root, "usage", `${accountId}.json`),
  ];
  const cv = join(root, "cv");
  if (existsSync(cv)) {
    // Ids cannot contain a dot, so `<id>.` never matches another account's files.
    for (const name of readdirSync(cv)) if (name.startsWith(`${accountId}.`)) paths.push(join(cv, name));
  }
  return paths;
}

function sizeOf(path: string, budget: { entries: number }): number {
  if (budget.entries-- <= 0) return 0;
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of readdirSync(path)) total += sizeOf(join(path, name), budget);
  return total;
}

/** Bytes on disk for one account (capped walk: at most 20k entries, so a huge library cannot stall the admin page). */
export function accountStorageBytes(accountId: string): number {
  const budget = { entries: 20_000 };
  return accountDataPaths(accountId).reduce((sum, path) => sum + sizeOf(path, budget), 0);
}

/** Removes every data location of the account; returns the paths that existed (relative to the data dir) for the log. */
export function deleteAccountData(accountId: string): string[] {
  const root = dataDir();
  const removed: string[] = [];
  for (const path of accountDataPaths(accountId)) {
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path.slice(root.length + 1));
  }
  return removed;
}
