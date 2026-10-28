import { randomBytes } from "node:crypto";
import { openValue, sealValue } from "@/lib/accounts/auth-secret";
import { isHttps } from "@/lib/accounts/session";
import { safeReturnPath } from "@/lib/safe-return";
import { msgf } from "@/lib/i18n/msg";
import { apiJson, SiteError, type NetDeps } from "./net";
import { VERCEL_API, VERCEL_WEB } from "./vercel";
import type { VercelOAuthConfig } from "./vercel-service";

/**
 * "Connect with Vercel": the external installation flow of the server's Vercel integration (docs/WEBSITE-STUDIO.md
 * "Vercel"). Like the GitHub flow (src/lib/github-app/oauth.ts) the pending flow lives only in a sealed HttpOnly cookie
 * (state, account, CV project, return path), so nothing grows on the server; the state is one-time and expires after
 * 10 minutes, and the callback must come back in the same browser and session. The code is exchanged once for a token
 * scoped to the installation (a team or the personal account), stored in the CV project's website file.
 */

export const VERCEL_STATE_COOKIE = "knife_vercel_state";
const TTL_MS = 10 * 60_000;
const KEY = Symbol.for("samurai-knife.vercel-consumed-states.v1");
const MAX_CONSUMED = 10_000;

export interface VercelFlow {
  accountId: string;
  projectId: string;
  returnTo: string;
  redirectUri: string;
}

interface Sealed {
  s: string;
  a: string;
  p: string;
  r: string;
  u: string;
  t: number;
}

function consumed(): Map<string, number> {
  const g = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  return (g[KEY] ??= new Map());
}

export function beginVercelFlow(flow: VercelFlow): { state: string; cookie: string } {
  const state = randomBytes(24).toString("base64url");
  const sealed: Sealed = { s: state, a: flow.accountId, p: flow.projectId, r: safeReturnPath(flow.returnTo), u: flow.redirectUri, t: Date.now() };
  return { state, cookie: sealValue("vercel-state", JSON.stringify(sealed)) };
}

/** One-time: null for a missing, foreign, edited, expired or already used state. */
export function takeVercelFlow(state: string | null, cookie: string | undefined, now = Date.now()): VercelFlow | null {
  if (!state || !cookie) return null;
  const plain = openValue("vercel-state", cookie);
  if (!plain) return null;
  let s: Sealed;
  try {
    s = JSON.parse(plain) as Sealed;
  } catch {
    return null;
  }
  if (s.s !== state || typeof s.a !== "string" || typeof s.p !== "string" || typeof s.u !== "string" || typeof s.t !== "number") return null;
  if (now - s.t > TTL_MS || s.t > now + 60_000) return null;
  const used = consumed();
  for (const [k, exp] of used) if (exp <= now) used.delete(k);
  if (used.has(state) || used.size >= MAX_CONSUMED) return null;
  used.set(state, s.t + TTL_MS + 60_000);
  return { accountId: s.a, projectId: s.p, returnTo: safeReturnPath(s.r), redirectUri: s.u };
}

export function vercelStateCookie(request: Request, value: string, clear = false): string {
  return [`${VERCEL_STATE_COOKIE}=${clear ? "" : value}`, "Path=/api/vercel", "HttpOnly", "SameSite=Lax", `Max-Age=${clear ? 0 : TTL_MS / 1000}`, ...(isHttps(request) ? ["Secure"] : [])].join("; ");
}

export function installUrl(config: VercelOAuthConfig, state: string): string {
  return `${VERCEL_WEB()}/integrations/${config.slug}/new?${new URLSearchParams({ state })}`;
}

/** The redirect URL registered on the integration: KNIFE_VERCEL_REDIRECT_URI, else <base>/api/vercel/callback. */
export function redirectUriFor(base: string): string {
  return process.env.KNIFE_VERCEL_REDIRECT_URI?.trim() || `${base}/api/vercel/callback`;
}

/** POST /v2/oauth/access_token (form-encoded, once per code). */
export async function exchangeVercelCode(config: VercelOAuthConfig, code: string, redirectUri: string, deps: NetDeps = {}): Promise<{ token: string; teamId: string | null; configurationId: string }> {
  if (!/^[A-Za-z0-9_-]{6,200}$/.test(code)) throw new SiteError("Vercel sent an invalid code", 400);
  const form = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri });
  const res = await apiJson(`${VERCEL_API()}/v2/oauth/access_token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, rawBody: form.toString() }, deps);
  const body = (res.body && typeof res.body === "object" ? res.body : {}) as Record<string, unknown>;
  const token = typeof body.access_token === "string" ? body.access_token : "";
  if (res.status !== 200 || !token) {
    const detail = String((body.error_description ?? body.error ?? (body.error as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`) as string).slice(0, 200);
    throw new SiteError(msgf("Vercel did not give a token: {detail}", { detail }), 502);
  }
  return { token, teamId: typeof body.team_id === "string" && body.team_id ? body.team_id : null, configurationId: typeof body.installation_id === "string" ? body.installation_id : "" };
}
