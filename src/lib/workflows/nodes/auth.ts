/**
 * Applies a saved credential to an outgoing request (HTTP Request, GraphQL and every integration). OAuth2: the access
 * token goes in `Authorization`; an expired token (by `expiresAt`, or a 401 answer) is refreshed once with the refresh
 * token at the credential's token URL, and the new token is saved back through `services.updateCredential`.
 */
import { NodeError, type CredentialData, type ExecuteContext, type HttpRequest, type HttpResponse } from "../engine/node-api";
import { isPlainObject, jsonParam } from "./util";
import { oauthTokenRequest, oauthTokenUpdate } from "../oauth-protocol";

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const MANAGED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "upgrade", "te", "trailer", "keep-alive", "proxy-connection"]);

export function checkHeader(name: string, value: string): void {
  if (!HEADER_NAME.test(name)) throw new NodeError(`"${name}" is not a valid header name.`);
  if (MANAGED_HEADERS.has(name.toLowerCase())) throw new NodeError(`The ${name} header is set by the transport.`);
  if (/[\r\n\0]/.test(value)) throw new NodeError(`The ${name} header holds a line break.`);
}

const str = (value: unknown) => (value === undefined || value === null ? "" : String(value));

/** Mutates `request` (headers, URL query). Returns the credential's body fields to merge (custom auth only). */
export function applyCredential(request: HttpRequest, credential: CredentialData): Record<string, unknown> | null {
  const data = credential.data;
  const url = new URL(request.url);
  switch (credential.type) {
    case "httpHeaderAuth": {
      const name = str(data.name).trim();
      checkHeader(name, str(data.value));
      request.headers[name] = str(data.value);
      return null;
    }
    case "httpBasicAuth":
      request.headers.authorization = `Basic ${Buffer.from(`${str(data.user)}:${str(data.password)}`).toString("base64")}`;
      return null;
    case "httpBearerAuth":
      request.headers.authorization = `Bearer ${str(data.token)}`;
      return null;
    case "httpQueryAuth":
      url.searchParams.set(str(data.name), str(data.value));
      request.url = url.toString();
      return null;
    case "httpCustomAuth": {
      const spec = jsonParam(data.json ?? "{}", "The custom auth JSON");
      if (!isPlainObject(spec)) throw new NodeError("The custom auth JSON must be an object.");
      if (isPlainObject(spec.headers)) for (const [name, value] of Object.entries(spec.headers)) {
        checkHeader(name, str(value));
        request.headers[name] = str(value);
      }
      if (isPlainObject(spec.qs)) for (const [name, value] of Object.entries(spec.qs)) url.searchParams.set(name, str(value));
      request.url = url.toString();
      return isPlainObject(spec.body) ? spec.body : null;
    }
    case "oAuth2Api":
      if (!str(data.accessToken)) throw new NodeError(`The credential "${credential.name}" is not connected yet.`, { description: "Open it in Credentials and press Connect." });
      request.headers.authorization = `${str(data.tokenType) || "Bearer"} ${str(data.accessToken)}`;
      return null;
    default:
      throw new NodeError(`A "${credential.type}" credential cannot be used for HTTP requests.`);
  }
}

/** Refreshes an OAuth2 credential in place; returns false when it cannot be refreshed. */
export async function refreshOAuth2(ctx: ExecuteContext, credential: CredentialData): Promise<boolean> {
  const data = credential.data;
  const refreshToken = str(data.refreshToken);
  const tokenUrl = str(data.tokenUrl);
  if (!refreshToken || !tokenUrl) return false;
  const request = oauthTokenRequest(data, { grant_type: "refresh_token", refresh_token: refreshToken });
  const response = await ctx.services.http({ url: tokenUrl, method: "POST", ...request, followRedirects: false, timeoutMs: 30_000, maxBytes: 1024 * 1024 });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
  } catch {
    body = {};
  }
  let update: Record<string, unknown>;
  try {
    if (response.status < 200 || response.status >= 300) throw new Error("OAuth refused");
    update = oauthTokenUpdate(body, ctx.now(), credential.data.preset);
  } catch {
    throw new NodeError(`Refreshing the "${credential.name}" connection failed (HTTP ${response.status}).`, { description: "Reconnect the credential in Credentials.", httpCode: response.status });
  }
  Object.assign(credential.data, update);
  await ctx.services.updateCredential?.(credential.id, update);
  return true;
}

/** Sends with the credential applied; OAuth2 refreshes before an expired token and retries once after a 401. */
export async function sendAuthorized(ctx: ExecuteContext, build: () => HttpRequest, credential: CredentialData | null): Promise<HttpResponse> {
  if (!credential) return ctx.services.http(build());
  if (credential.type === "oAuth2Api") {
    const expiresAt = Number(credential.data.expiresAt);
    if (expiresAt > 0 && Number.isFinite(expiresAt) && expiresAt - 60_000 < ctx.now()) await refreshOAuth2(ctx, credential);
  }
  const first = build();
  applyCredential(first, credential);
  const response = await ctx.services.http(first);
  if (response.status === 401 && credential.type === "oAuth2Api" && (await refreshOAuth2(ctx, credential))) {
    const second = build();
    applyCredential(second, credential);
    return ctx.services.http(second);
  }
  return response;
}
