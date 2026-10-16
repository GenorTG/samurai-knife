import { isAdmin } from "@/lib/accounts/authz";
import type { Account } from "@/lib/accounts/store";

/**
 * What an account may see of a sidecar. Admins (every account in private mode): everything. Others in public mode: whether
 * it is installed and running, nothing of its configuration (state with bind address and ports, memory, lock holder).
 * `canManage` tells the UI whether to show the lifecycle controls.
 */
export function serviceViewFor<T extends { state: unknown; memory?: unknown; busy?: unknown }>(account: Account, service: T): T & { canManage: boolean } {
  if (isAdmin(account)) return { ...service, canManage: true };
  return { ...service, state: null, memory: null, busy: null, canManage: false };
}
