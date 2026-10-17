import { createHmac } from "node:crypto";
import { officeProxyUrl } from "@/lib/services/urls";
import { officeSecret } from "./editor";

/**
 * Tickets for the office editor proxy (scripts/office-proxy.mjs, which verifies them; same format, kept in sync by
 * tests/office_proxy.test.mjs). The editor config loads api.js with `?knife_ticket=<ticket>`; the proxy turns a valid one
 * into an HttpOnly cookie on the office host. Key = HMAC(JWT secret, context), so a ticket is never a Document Server token.
 */
export const TICKET_PARAM = "knife_ticket";
const TICKET_CONTEXT = "knife-office-proxy-v1";
const TICKET_TTL_SEC = 6 * 3600;

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

export function proxyTicket(accountId: string, secret: string = officeSecret(), nowSec = Math.floor(Date.now() / 1000)): string {
  const key = createHmac("sha256", secret).update(TICKET_CONTEXT).digest();
  const payload = b64(JSON.stringify({ a: accountId, e: nowSec + TICKET_TTL_SEC }));
  return `v1.${payload}.${b64(createHmac("sha256", key).update(`v1.${payload}`).digest())}`;
}

/** api.js on the proxied office host with a fresh ticket, or null when the app does not proxy the editor. */
export function proxiedApiUrl(accountId: string): string | null {
  const base = officeProxyUrl();
  if (!base) return null;
  return `${base}/web-apps/apps/api/documents/api.js?${TICKET_PARAM}=${encodeURIComponent(proxyTicket(accountId))}`;
}
