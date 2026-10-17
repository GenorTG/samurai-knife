import { createHash, randomBytes } from "node:crypto";
import { openValue, sealValue } from "@/lib/accounts/auth-secret";
import { isHttps } from "@/lib/accounts/session";
import { safeReturnPath } from "@/lib/safe-return";
import { recordSecurityEvent } from "@/lib/security/events";
import { apiJson } from "@/lib/site/net";
import { gh } from "@/lib/site/github";
import { GITHUB_WEB, type GithubAppConfig } from "./config";

/**
 * "Sign in with GitHub" / account linking through the app's OAuth client (web application flow with PKCE S256). The
 * `state` is one-time, expires after 10 minutes and must come back in the same browser: an HttpOnly cookie set when the
 * flow starts carries the whole pending flow, sealed (AES-256-GCM with the auth key, `auth-secret.ts`) so the PKCE
 * verifier stays secret and nothing can be edited; a callback link opened elsewhere (login CSRF) is refused. Nothing
 * GitHub returns is trusted beyond what the user token itself proves (GET /user, GET /user/emails, GET /user/installations).
 *
 * Why stateless (audit abuse #12): the server keeps nothing per started flow, so `GET /api/github/start` without a
 * session cannot grow memory. One-time use is kept by a set of consumed states (added only for a genuine sealed cookie
 * whose state matches, expiring with the flow, at most MAX_CONSUMED; when full, callbacks are refused rather than the set
 * forgetting a live state). GitHub's codes are single-use as well, so a replay could not sign anyone in anyway.
 */

export type FlowPurpose = "login" | "register" | "link" | "install";

export interface PendingFlow {
  purpose: FlowPurpose;
  /** The signed-in account that started a link/install flow; null for login/register. */
  accountId: string | null;
  verifier: string;
  redirectUri: string;
  /** Same-site path to return to (validated). */
  returnTo: string;
  createdAt: number;
}

export const STATE_COOKIE = "knife_gh_state";
const TTL_MS = 10 * 60_000;
const MAX_CONSUMED = 10_000;
const KEY = Symbol.for("samurai-knife.github-consumed-states.v1");

function consumed(): Map<string, number> {
  const g = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  const current = g[KEY];
  if (current instanceof Map) return current;
  const fresh = new Map<string, number>();
  g[KEY] = fresh;
  return fresh;
}

/** Only a path on this site ("/x?y"), never another origin: the shared rule in `src/lib/safe-return.ts`. */
export function safeReturnTo(value: string | null | undefined, fallback = "/"): string {
  return safeReturnPath(value, fallback);
}

interface SealedFlow {
  s: string;
  p: FlowPurpose;
  a: string | null;
  v: string;
  u: string;
  r: string;
  t: number;
}

/** A new flow: the `state` for GitHub's URL, the PKCE challenge, and the sealed cookie value carrying everything else. */
export function beginFlow(flow: Omit<PendingFlow, "verifier" | "createdAt">): { state: string; challenge: string; cookie: string } {
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const sealed: SealedFlow = { s: state, p: flow.purpose, a: flow.accountId, v: verifier, u: flow.redirectUri, r: safeReturnPath(flow.returnTo), t: Date.now() };
  return { state, challenge: createHash("sha256").update(verifier).digest("base64url"), cookie: sealValue("github-state", JSON.stringify(sealed)) };
}

const PURPOSES: readonly FlowPurpose[] = ["login", "register", "link", "install"];

/** One-time: the flow is consumed when the cookie opens and its state matches; anything else is null. */
export function takeFlow(state: string | null, cookie: string | undefined, now = Date.now()): PendingFlow | null {
  if (!state || !cookie) return null;
  const plain = openValue("github-state", cookie);
  if (!plain) return null;
  let sealed: SealedFlow;
  try {
    sealed = JSON.parse(plain) as SealedFlow;
  } catch {
    return null;
  }
  if (typeof sealed.s !== "string" || sealed.s !== state || !PURPOSES.includes(sealed.p) || typeof sealed.v !== "string" || typeof sealed.u !== "string" || typeof sealed.t !== "number") return null;
  if (now - sealed.t > TTL_MS || sealed.t > now + 60_000) return null;
  const used = consumed();
  if (used.has(state)) return null;
  if (used.size >= MAX_CONSUMED) {
    for (const [key, expiry] of used) if (expiry <= now) used.delete(key);
    if (used.size >= MAX_CONSUMED) {
      recordSecurityEvent({ kind: "oauth_flow_full" });
      return null;
    }
  }
  used.set(state, sealed.t + TTL_MS + 60_000);
  return { purpose: sealed.p, accountId: typeof sealed.a === "string" ? sealed.a : null, verifier: sealed.v, redirectUri: sealed.u, returnTo: safeReturnPath(sealed.r), createdAt: sealed.t };
}

export function stateCookie(request: Request, value: string): string {
  return [`${STATE_COOKIE}=${value}`, "Path=/api/github", "HttpOnly", "SameSite=Lax", `Max-Age=${TTL_MS / 1000}`, ...(isHttps(request) ? ["Secure"] : [])].join("; ");
}

export function clearStateCookie(request: Request): string {
  return [`${STATE_COOKIE}=`, "Path=/api/github", "HttpOnly", "SameSite=Lax", "Max-Age=0", ...(isHttps(request) ? ["Secure"] : [])].join("; ");
}

export function authorizeUrl(app: GithubAppConfig, redirectUri: string, state: string, challenge: string): string {
  const q = new URLSearchParams({ client_id: app.clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: "S256", allow_signup: "true" });
  return `${GITHUB_WEB()}/login/oauth/authorize?${q}`;
}

export class GithubFlowError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GithubFlowError";
    this.code = code;
  }
}

/** code -> user access token (ghu_...), checked against the PKCE verifier by GitHub. */
export async function exchangeCode(app: GithubAppConfig, code: string, flow: PendingFlow): Promise<string> {
  const res = await apiJson(`${GITHUB_WEB()}/login/oauth/access_token`, {
    method: "POST",
    body: { client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier },
  });
  const body = (res.body ?? {}) as Record<string, unknown>;
  if (res.status !== 200 || typeof body.access_token !== "string") {
    throw new GithubFlowError("exchange_failed", `GitHub did not accept the sign-in (${String(body.error_description ?? body.error ?? `HTTP ${res.status}`).slice(0, 200)})`);
  }
  return body.access_token;
}

export interface GithubIdentity {
  id: number;
  login: string;
  name: string;
  /** The primary address, only when GitHub has verified it. */
  verifiedEmail: string | null;
}

export async function identity(userToken: string): Promise<GithubIdentity> {
  const user = await gh<Record<string, unknown>>(userToken, "GET", "/user");
  let verifiedEmail: string | null = null;
  try {
    const emails = await gh<{ email: string; primary: boolean; verified: boolean }[]>(userToken, "GET", "/user/emails");
    verifiedEmail = emails.find((e) => e.primary && e.verified)?.email.toLowerCase() ?? null;
  } catch {
    /* the app has no Email addresses permission, or the user hides them: no verified address */
  }
  const id = Number(user.id);
  if (!Number.isInteger(id) || id <= 0) throw new GithubFlowError("bad_user", "GitHub returned no user id");
  return { id, login: String(user.login ?? ""), name: String(user.name ?? ""), verifiedEmail };
}

/** The app's installations this GitHub user can reach (installed on their account, or on an org they belong to). */
export async function userInstallations(userToken: string): Promise<{ id: number; account: string; accountType: string }[]> {
  const res = await gh<{ installations?: Record<string, unknown>[] }>(userToken, "GET", "/user/installations?per_page=100");
  return (res.installations ?? []).map((i) => {
    const account = (i.account ?? {}) as Record<string, unknown>;
    return { id: Number(i.id), account: String(account.login ?? ""), accountType: String(account.type ?? "User") };
  });
}
