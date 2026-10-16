import { isAdmin } from "@/lib/accounts/authz";
import type { Account } from "@/lib/accounts/store";
import type { OpView } from "./ops";

/**
 * What an account may see of a sidecar. Admins (every account in private mode): everything. Others in public mode: whether
 * it is installed and running, nothing of its configuration (state with bind address and ports, memory, lock holder).
 * `canManage` tells the UI whether to show the lifecycle controls.
 */
export function serviceViewFor<T extends { state: unknown; memory?: unknown; busy?: unknown; op?: OpView | null }>(account: Account, service: T): T & { canManage: boolean } {
  if (isAdmin(account)) return { ...service, canManage: true };
  return { ...service, state: null, memory: null, busy: null, op: service.op ? opViewFor(account, service.op) : service.op, canManage: false };
}

/**
 * A running or finished sidecar op as a non-admin may see it: kind, progress and outcome, not the log, pull details or
 * hints (host paths, image names, ports). Lets a user's office/course page wait for a start an admin began.
 */
export function opViewFor<T extends { log: string[]; pull?: unknown; hint?: string; error?: string }>(account: Account, op: T): T {
  if (isAdmin(account)) return op;
  return { ...op, log: [], pull: undefined, hint: undefined, error: op.error ? "The service could not be started. An administrator can see why." : undefined };
}
