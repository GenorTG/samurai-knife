import type { PublicAccount } from "@/lib/accounts/store";
import type { AdminUserRow } from "@/lib/accounts/admin";
import { safeReturnPath } from "@/lib/safe-return";

/** Browser helpers for the account pages: same-origin JSON, never throw, readable messages for every API error code. */

export type Reply<T> = { ok: true; status: number; body: T } | { ok: false; status: number; message: string; code: string };

const MESSAGES: Record<string, string> = {
  invalid_credentials: "Wrong username, email or password.",
  invalid_or_expired: "This link is invalid, was already used, or has expired. Ask for a new one.",
  wrong_password: "The current password is not right.",
  login_required: "Log in first.",
  forbidden_origin: "This page was opened from an address the server does not accept.",
  forbidden_host: "This page was opened from an address the server does not accept.",
  challenge_required: "The browser check did not finish in time. Try again.",
  challenge_invalid: "The browser check did not pass. Try again.",
  busy: "The server is busy right now. Try again in a few seconds.",
};

function messageFor(status: number, body: unknown): { message: string; code: string } {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const code = typeof record.error === "string" ? record.error : `http_${status}`;
  if (typeof record.message === "string") return { message: record.message, code };
  if (code === "rate_limited") {
    const wait = typeof record.retryAfterSeconds === "number" ? record.retryAfterSeconds : 60;
    return { message: `Too many attempts. Try again in ${wait} s.`, code };
  }
  return { message: MESSAGES[code] ?? (code.includes(" ") ? code : `Request failed (${status}).`), code };
}

export async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<Reply<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, status: 0, code: "network", message: `Network error: ${error instanceof Error ? error.message : String(error)}` };
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (!response.ok) return { ok: false, status: response.status, ...messageFor(response.status, parsed) };
  return { ok: true, status: response.status, body: parsed as T };
}

export const fetchMe = () => call<PublicAccount>("GET", "/api/account");
export const fetchUsers = () => call<{ users: AdminUserRow[]; self: string }>("GET", "/api/admin/users");

/** `next` from a query string, accepted only as a same-site path: the shared rule in `src/lib/safe-return.ts`. */
export function safeNext(value: string | undefined | null): string {
  return safeReturnPath(value, "/");
}

/** Full page load (not a client transition): the shell and the assistant read the account once per page load. */
export function hardNavigate(path: string): void {
  window.location.href = path;
}
