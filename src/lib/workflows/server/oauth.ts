/**
 * OAuth2 for workflow credentials with the user's own app (docs/WORKFLOWS.md "Rules"): authorization code + PKCE,
 * redirect URI `<app>/api/workflows/oauth/callback`, one-time state bound to the account and the credential (10 min),
 * token exchange through the SSRF-safe transport with the account's outbound policy.
 */
import { createHash, randomBytes } from "node:crypto";
import { readTextCapped, safeFetch } from "@/lib/net/safe-fetch";
import { getAccount } from "@/lib/accounts/store";
import { oauthPreset } from "../credential-types";
import { toOutboundPolicy } from "../worker/http";
import { appBaseUrl, workflowPolicy } from "./runner";
import { getCredential, updateCredentialData, WorkflowStoreError } from "./store";

interface PendingAuth {
  account: string;
  credentialId: string;
  verifier: string;
  expires: number;
}

const KEY = Symbol.for("samurai-knife.workflow-oauth.v1");

function pending(): Map<string, PendingAuth> {
  const holder = globalThis as unknown as Record<symbol, Map<string, PendingAuth> | undefined>;
  return (holder[KEY] ??= new Map());
}

export const redirectUri = () => `${appBaseUrl()}/api/workflows/oauth/callback`;

function endpoints(data: Record<string, unknown>) {
  const preset = oauthPreset(data.preset);
  const authUrl = String(data.authUrl || preset?.authUrl || "");
  const tokenUrl = String(data.tokenUrl || preset?.tokenUrl || "");
  const scope = String(data.scope ?? preset?.scope ?? "");
  return { preset, authUrl, tokenUrl, scope };
}

/** The provider's authorization URL to send the browser to. */
export function authorizationUrl(account: string, credentialId: string): string {
  const credential = getCredential(account, credentialId);
  if (!credential || credential.type !== "oAuth2Api") throw new WorkflowStoreError("Unknown OAuth2 credential.", 404);
  const { preset, authUrl, scope } = endpoints(credential.data);
  if (!/^https:\/\//i.test(authUrl)) throw new WorkflowStoreError("Set an https authorization URL first.");
  if (!credential.data.clientId) throw new WorkflowStoreError("Set the client ID first.");
  const now = Date.now();
  for (const [state, entry] of pending()) if (entry.expires < now) pending().delete(state);
  if (pending().size > 10_000) throw new WorkflowStoreError("Too many connections are in progress; try again in a few minutes.", 503);
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  pending().set(state, { account, credentialId, verifier, expires: now + 10 * 60_000 });
  const url = new URL(authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", String(credential.data.clientId));
  url.searchParams.set("redirect_uri", redirectUri());
  if (scope) url.searchParams.set("scope", scope.replace(/,\s*/g, preset?.id === "meta" ? "," : " ").trim());
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  for (const [name, value] of Object.entries(preset?.authQuery ?? {})) url.searchParams.set(name, value);
  return url.toString();
}

/** Finishes the flow: exchanges the code and stores the token on the credential. Returns the credential's name. */
export async function finishAuthorization(account: string, state: string, code: string): Promise<string> {
  const entry = pending().get(state);
  pending().delete(state);
  if (!entry || entry.expires < Date.now() || entry.account !== account) throw new WorkflowStoreError("This sign-in link expired or belongs to another session; press Connect again.", 400);
  const credential = getCredential(account, entry.credentialId);
  const owner = getAccount(account);
  if (!credential || !owner) throw new WorkflowStoreError("The credential no longer exists.", 404);
  const { tokenUrl } = endpoints(credential.data);
  if (!/^https:\/\//i.test(tokenUrl)) throw new WorkflowStoreError("Set an https token URL first.");
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: entry.verifier });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (credential.data.authentication === "header") {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(String(credential.data.clientId))}:${encodeURIComponent(String(credential.data.clientSecret ?? ""))}`).toString("base64")}`;
  } else {
    form.set("client_id", String(credential.data.clientId));
    form.set("client_secret", String(credential.data.clientSecret ?? ""));
  }
  const response = await safeFetch(tokenUrl, { method: "POST", headers, body: form.toString(), policy: toOutboundPolicy(workflowPolicy(owner)), signal: AbortSignal.timeout(30_000) });
  const text = (await readTextCapped(response, 256 * 1024)) ?? "";
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = Object.fromEntries(new URLSearchParams(text));
  }
  if (!response.ok || typeof body.access_token !== "string") {
    const reason = typeof body.error_description === "string" ? body.error_description : typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    throw new WorkflowStoreError(`The provider refused the sign-in: ${reason.slice(0, 200)}`, 502);
  }
  const expiresIn = Number(body.expires_in);
  updateCredentialData(account, credential.id, {
    accessToken: body.access_token,
    tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
    ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: String(Date.now() + expiresIn * 1000) } : {}),
    connectedAt: new Date().toISOString(),
    // Fill the endpoints the preset chose, so a refresh during a run knows where to go.
    tokenUrl,
  });
  return credential.name;
}
