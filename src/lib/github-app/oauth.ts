import { createHash, randomBytes } from "node:crypto";
import { isHttps } from "@/lib/accounts/session";
import { apiJson } from "@/lib/site/net";
import { gh } from "@/lib/site/github";
import { GITHUB_WEB, type GithubAppConfig } from "./config";

/**
 * "Sign in with GitHub" / account linking through the app's OAuth client (web application flow with PKCE S256). The
 * `state` is one-time, expires after 10 minutes and must come back in the same browser (an HttpOnly cookie set when the
 * flow starts): a callback link opened elsewhere (login CSRF) is refused. Nothing GitHub returns is trusted beyond what
 * the user token itself proves (GET /user, GET /user/emails, GET /user/installations).
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
const KEY = Symbol.for("samurai-knife.github-flows.v1");

function flows(): Map<string, PendingFlow> {
  const g = globalThis as unknown as Record<symbol, Map<string, PendingFlow> | undefined>;
  return (g[KEY] ??= new Map());
}

function gc(now = Date.now()): void {
  for (const [state, flow] of flows()) if (now - flow.createdAt > TTL_MS) flows().delete(state);
}

/** Only a path on this site ("/x?y"), never another origin ("//evil", "https://..."). */
export function safeReturnTo(value: string | null | undefined, fallback = "/"): string {
  const v = (value ?? "").trim();
  return v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") && v.length <= 300 ? v : fallback;
}

export function beginFlow(flow: Omit<PendingFlow, "verifier" | "createdAt">): { state: string; challenge: string } {
  gc();
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  flows().set(state, { ...flow, verifier, createdAt: Date.now() });
  return { state, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** One-time: the flow is removed whether or not it matches. */
export function takeFlow(state: string | null, cookieState: string | undefined): PendingFlow | null {
  gc();
  if (!state) return null;
  const flow = flows().get(state) ?? null;
  flows().delete(state);
  if (!flow || !cookieState || cookieState !== state) return null;
  return flow;
}

export function stateCookie(request: Request, state: string): string {
  return [`${STATE_COOKIE}=${state}`, "Path=/api/github", "HttpOnly", "SameSite=Lax", `Max-Age=${TTL_MS / 1000}`, ...(isHttps(request) ? ["Secure"] : [])].join("; ");
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
