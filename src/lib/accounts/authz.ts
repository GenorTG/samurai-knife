import type { NextResponse } from "next/server";
import { jsonError } from "@/lib/accounts/http";
import { isPublicMode } from "@/lib/accounts/mode";
import type { Account } from "@/lib/accounts/store";
import { msgf } from "@/lib/i18n/msg";

/**
 * The one authorization rule. Private mode: every account manages everything (the owner's toolbox, unchanged). Public
 * mode: only `role: "admin"` manages what is shared by everyone on the server: sidecar services (install, start, stop,
 * update, remove, configure, lazy start), server-wide stats, user management and global settings. docs/ACCOUNTS.md "Roles".
 */
export function isAdmin(account: Account): boolean {
  return !isPublicMode() || account.role === "admin";
}

/** null when allowed, else the 403 to return. `what` names the action for the message ("start Office editor"). */
export function requireAdmin(account: Account, what = "do this"): NextResponse | null {
  if (isAdmin(account)) return null;
  return jsonError(msgf("An administrator has to {what}.", { what }), 403, { code: "admin_required" });
}

/** The caller identity every `knife_*` tool runs with (src/lib/mcp/define.ts): the account and its admin right. */
export function toolContextFor(account: Account): { accountId: string; admin: boolean } {
  return { accountId: account.id, admin: isAdmin(account) };
}
