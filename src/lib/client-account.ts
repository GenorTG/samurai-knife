"use client";

/**
 * The signed-in account as the browser knows it (GET /api/account, once per page load: signing in or out is a full
 * page load or clears this cache), and everything this browser stores for one account. Logout and account deletion
 * call `clearAccountStorage` so the next person using the browser finds nothing of the previous account in storage.
 */

export interface ClientAccount {
  id: string;
  isAdmin: boolean;
}

export const ACCOUNT_KNOWN_EVENT = "sk:account-known";

let current: ClientAccount | null | undefined;
let pending: Promise<ClientAccount | null> | null = null;

/** undefined = not loaded yet, null = signed out. */
export function knownAccount(): ClientAccount | null | undefined {
  return current;
}

export function loadAccount(): Promise<ClientAccount | null> {
  if (current !== undefined) return Promise.resolve(current);
  pending ??= fetch("/api/account", { cache: "no-store", credentials: "same-origin" })
    .then(async (response) => {
      const body = (await response.json().catch(() => null)) as { id?: unknown; isAdmin?: unknown } | null;
      current = response.ok && typeof body?.id === "string" ? { id: body.id, isAdmin: body.isAdmin === true } : null;
      window.dispatchEvent(new Event(ACCOUNT_KNOWN_EVENT));
      return current;
    })
    .catch(() => {
      pending = null;
      return null;
    });
  return pending;
}

/** Keys that hold one account's data in this browser (the agent widget, its queue and run lease, the SQL lab). */
export function accountStorageKeys(accountId: string): string[] {
  return [
    `sk.agent.chat.v1.${accountId}`,
    `sk.agent.queue.v1.${accountId}`,
    `sk.agent.lease.v1.${accountId}`,
    `sk.sql.schema.v1.${accountId}`,
    `sk.sql.dialect.v1.${accountId}`,
  ];
}

/**
 * Not per account (older builds, or a choice that must not carry over to the next person): the unscoped SQL schema and
 * dialect of earlier versions and the assistant's trust mode.
 */
const SHARED_KEYS = ["sk.sql.schema.v1", "sk.sql.dialect.v1", "sk.agent.mode.v1"];

/**
 * Removes what this browser holds for the account (call before the logout/delete request navigates away). A key also
 * matches with a `:` suffix: the widget keeps one transcript per account and provider (`sk.agent.chat.v1.<id>:<url>:<model>`).
 */
export function clearAccountStorage(accountId: string | null | undefined): void {
  try {
    const prefixes = accountId ? accountStorageKeys(accountId) : [];
    const doomed: string[] = [...SHARED_KEYS];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}:`))) doomed.push(key);
    }
    for (const key of doomed) window.localStorage.removeItem(key);
  } catch {
    /* Storage blocked: nothing was stored either. */
  }
  current = undefined;
  pending = null;
}
