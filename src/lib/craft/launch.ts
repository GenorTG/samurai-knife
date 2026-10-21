import { createHmac } from "node:crypto";
import { findSidecar } from "@/lib/services/definitions";
import { ensureSecrets, readState } from "@/lib/services/state";
import { craftProxyUrl, publicUrl } from "@/lib/services/urls";

/**
 * Where the browser opens each ArtCraft app. Private mode: the sidecar's own address (http://<KNIFE_HOST>:<port>, an
 * origin of its own). With KNIFE_CRAFT_PUBLIC_URL the app proxies the craft host (scripts/craft-proxy.mjs) and each URL
 * carries a ticket the proxy turns into its cookie; same format and key derivation as the proxy, kept in sync by
 * tests/craft_proxy.test.mjs. Key = HMAC(TICKET_SECRET, context): the secret itself never signs anything.
 */
export const TICKET_PARAM = "knife_ticket";
const TICKET_CONTEXT = "knife-craft-proxy-v1";
const TICKET_TTL_SEC = 12 * 3600;

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

export function craftTicket(accountId: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const key = createHmac("sha256", secret).update(TICKET_CONTEXT).digest();
  const payload = b64(JSON.stringify({ a: accountId, e: nowSec + TICKET_TTL_SEC }));
  return `v1.${payload}.${b64(createHmac("sha256", key).update(`v1.${payload}`).digest())}`;
}

export interface CraftLaunch {
  /** The craft origin the iframes load from. */
  origin: string;
  /** Served through the app's proxy on KNIFE_CRAFT_PUBLIC_URL. */
  proxied: boolean;
  apps: { id: string; url: string }[];
}

/** Launch URLs for an account, or null when the sidecar is not installed. */
export function craftLaunch(accountId: string): CraftLaunch | null {
  const def = findSidecar("craft");
  const state = readState("craft");
  if (!def?.sites || !state) return null;
  const origin = publicUrl(state);
  const proxied = craftProxyUrl() !== null;
  const query = proxied ? `?${TICKET_PARAM}=${encodeURIComponent(craftTicket(accountId, ensureSecrets(def).TICKET_SECRET))}` : "";
  return { origin, proxied, apps: def.sites.apps.map((app) => ({ id: app.id, url: `${origin}/${app.id}/${query}` })) };
}
