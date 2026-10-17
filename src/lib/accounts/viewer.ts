import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isPublicMode } from "@/lib/accounts/mode";
import { accountForSessionToken, SESSION_COOKIE } from "@/lib/accounts/session";
import type { Account } from "@/lib/accounts/store";
import { safeReturnPath } from "@/lib/safe-return";

/**
 * Who is looking at a server-rendered page. Public mode gates every tool and account page behind a session: a signed-out
 * visitor sees only the welcome page and the auth pages, in the public frame (no sidebar, no assistant, no UI bridge).
 * Private mode never gates (the owner's tailnet bind is the boundary), so the owner's shell stays exactly as it was.
 */
export async function sessionAccount(): Promise<Account | null> {
  return accountForSessionToken((await cookies()).get(SESSION_COOKIE)?.value);
}

/** True only in public mode without a live session. */
export async function isGuest(): Promise<boolean> {
  return isPublicMode() && !(await sessionAccount());
}

/** Page-level gate (pages re-render on every navigation, layouts do not): a guest goes to /login and comes back after. */
export async function requireSignIn(path: string): Promise<void> {
  if (await isGuest()) redirect(`/login?next=${encodeURIComponent(safeReturnPath(path, "/"))}`);
}

/** Auth pages for somebody already signed in (public mode): straight on to where they were going. */
export async function skipIfSignedIn(next: string | undefined): Promise<void> {
  if (isPublicMode() && (await sessionAccount())) redirect(safeReturnPath(next, "/"));
}

/** Rebuilds `?a=1&b=2` from a page's searchParams so the login round trip keeps tabs and focus targets. */
export function queryString(params: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}
