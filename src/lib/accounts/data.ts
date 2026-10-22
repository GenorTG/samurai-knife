import { existsSync } from "node:fs";
import { cvPaths, removeAccountPath, invalidateUsage, storageUsage } from "@/lib/storage/quota";
import { accountScope } from "@/lib/storage/scope";
import { removeAccountTriggers } from "@/lib/workflows/server/trigger-index";

/**
 * Every place under $KNIFE_DATA_DIR that belongs to one account, as owned by `accountScope` (src/lib/storage/scope.ts).
 * Account deletion removes all of them; the admin list shows their size. A new per-account store must be added to the scope
 * (docs/ACCOUNTS.md "Data an account owns").
 *
 *   cv/<id>.json, cv/<id>.snapshots/, cv/<id>.photo.jpg (and any other cv/<id>.* file)   CV studio
 *   conversations/<id>/                                                                 assistant transcripts
 *   docs/<id>/                                                                          office library
 *   learn/<id>.json                                                                     course progress
 *   usage/<id>.json                                                                     token ledger
 *   workspace/<id>.json.enc                                                             tool drafts
 *   site/<id>.json                                                                      website studio
 *   craft-files/<id>/                                                                   Craft apps files
 *   workflows/<id>/                                                                     workflows, runs, credentials
 * plus the account record in accounts.json, its sessions in sessions.json and its MCP keys in mcp-keys.json (removed by
 * the caller, accounts/flows.ts purgeAccount), and its entries in the workflow trigger index (removed here).
 */
export function accountDataPaths(accountId: string): string[] {
  return [...accountScope(accountId).locations(), ...cvPaths(accountId)];
}

/** Bytes stored for one account (the quota's cached count, src/lib/storage/quota.ts). */
export function accountStorageBytes(accountId: string): number {
  return storageUsage(accountId).usedBytes;
}

/** Removes every data location of the account; returns the paths that existed (relative to the data dir) for the log. */
export function deleteAccountData(accountId: string): string[] {
  const root = accountScope(accountId).dataRoot;
  const removed: string[] = [];
  for (const path of accountDataPaths(accountId)) {
    if (!existsSync(path)) continue;
    removeAccountPath(accountId, path);
    removed.push(path.slice(root.length + 1));
  }
  invalidateUsage(accountId);
  removeAccountTriggers(accountId);
  return removed;
}
