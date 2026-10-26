/**
 * Provider differences shared by the callback and worker refresh path.
 * Sources: Slack oauth.v2.access; Notion create-a-token; RFC 6749 section 2.3.1.
 * No transport here: callers retain their account-specific safe HTTP policy.
 */
import { oauthPreset } from "./credential-types";

export function oauthScope(data: Record<string, unknown>): string {
  const preset = oauthPreset(data.preset);
  const separator = preset?.scopeSeparator ?? (preset?.id === "meta" ? "," : " ");
  return String(data.scope ?? preset?.scope ?? "").trim().split(/[\s,]+/).filter(Boolean).join(separator);
}

export function oauthTokenRequest(data: Record<string, unknown>, grant: Record<string, string>): { headers: Record<string, string>; body: string } {
  const preset = oauthPreset(data.preset);
  const fields = { ...grant };
  const headers: Record<string, string> = { accept: "application/json" };
  const authentication = data.authentication ?? preset?.authentication ?? "body";
  if (authentication === "header") {
    // RFC 6749: URL-encode each component before constructing Basic credentials.
    const basic = `${encodeURIComponent(String(data.clientId ?? ""))}:${encodeURIComponent(String(data.clientSecret ?? ""))}`;
    headers.authorization = `Basic ${Buffer.from(basic).toString("base64")}`;
  } else {
    fields.client_id = String(data.clientId ?? "");
    fields.client_secret = String(data.clientSecret ?? "");
  }
  if (preset?.tokenBody === "json") {
    headers["content-type"] = "application/json";
    return { headers, body: JSON.stringify(fields) };
  }
  headers["content-type"] = "application/x-www-form-urlencoded";
  return { headers, body: new URLSearchParams(fields).toString() };
}

/** Never put raw provider replies (which can contain credentials) in a thrown error. */
export function oauthTokenUpdate(body: unknown, now: number, preset?: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("The provider did not return an OAuth token.");
  const token = body as Record<string, unknown>;
  if (token.error || token.ok === false || typeof token.access_token !== "string" || !token.access_token.trim()) {
    throw new Error("The provider did not return an OAuth token.");
  }
  // Slack's `token_type: bot` describes the app identity, not the HTTP authentication scheme.
  const tokenType = preset === "slack" ? "Bearer" : typeof token.token_type === "string" ? token.token_type : "Bearer";
  if (!/^[A-Za-z][A-Za-z0-9._~-]*$/.test(tokenType) || /[\r\n\0]/.test(token.access_token)) {
    throw new Error("The provider returned an invalid OAuth token.");
  }
  const lifetime = Number(token.expires_in);
  return {
    accessToken: token.access_token,
    tokenType,
    ...(typeof token.refresh_token === "string" && token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    // Clear a previous expiry when a replacement token has no expiry (e.g. Slack non-rotating tokens).
    expiresAt: Number.isFinite(lifetime) && lifetime > 0 ? now + lifetime * 1000 : "",
  };
}
