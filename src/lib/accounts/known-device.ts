import { randomBytes } from "node:crypto";
import { signValue, verifySigned } from "@/lib/accounts/auth-secret";

/**
 * "Known device" cookie (public mode): set on every successful password login, it lets this browser keep logging in to
 * that account while strangers hammer the account's failure bucket (audit #9: anyone could keep a known user locked out
 * by sending 20 wrong passwords every 15 minutes). The device still has its own failure bucket (LIMITS.loginDevice).
 * Signed with the auth key (`auth-secret.ts`, purpose "device"); each entry is pinned to the account's password
 * fingerprint, so a password change or reset turns every known device of that account back into a stranger.
 * HttpOnly, SameSite=Strict, sent to /api/account/login only, 180 days; up to 4 accounts per browser.
 */

export const DEVICE_COOKIE = "knife_device";
const MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
const MAX_ENTRIES = 4;
const COOKIE_PATH = "/api/account/login";

interface DeviceEntry {
  /** account id */
  a: string;
  /** password fingerprint at login */
  pf: string;
}

interface DevicePayload {
  v: 1;
  /** random device id (its failure bucket key) */
  d: string;
  t: number;
  e: DeviceEntry[];
}

function decode(cookie: string | undefined): DevicePayload | null {
  const encoded = verifySigned("device", cookie);
  if (!encoded) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<DevicePayload>;
    if (value.v !== 1 || typeof value.d !== "string" || typeof value.t !== "number" || !Array.isArray(value.e)) return null;
    if (Date.now() - value.t > MAX_AGE_SECONDS * 1000) return null;
    const entries = value.e.filter((x): x is DeviceEntry => typeof x?.a === "string" && typeof x?.pf === "string").slice(0, MAX_ENTRIES);
    return { v: 1, d: value.d, t: value.t, e: entries };
  } catch {
    return null;
  }
}

/** The device id when this cookie vouches for `accountId` at its current password fingerprint, else null. */
export function knownDeviceFor(cookie: string | undefined, accountId: string, fingerprint: string): string | null {
  const payload = decode(cookie);
  return payload && payload.e.some((entry) => entry.a === accountId && entry.pf === fingerprint) ? payload.d : null;
}

/** The cookie after a successful login of `accountId` (same device id when the browser already had one). */
export function deviceCookieHeader(previous: string | undefined, accountId: string, fingerprint: string, secure: boolean): string {
  const old = decode(previous);
  const entries = [{ a: accountId, pf: fingerprint }, ...(old?.e ?? []).filter((entry) => entry.a !== accountId)].slice(0, MAX_ENTRIES);
  const payload: DevicePayload = { v: 1, d: old?.d ?? randomBytes(16).toString("base64url"), t: Date.now(), e: entries };
  const value = signValue("device", Buffer.from(JSON.stringify(payload)).toString("base64url"));
  return [`${DEVICE_COOKIE}=${value}`, `Path=${COOKIE_PATH}`, "HttpOnly", "SameSite=Strict", `Max-Age=${MAX_AGE_SECONDS}`, ...(secure ? ["Secure"] : [])].join("; ");
}
