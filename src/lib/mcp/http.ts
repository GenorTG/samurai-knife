import {
  hostHeaderValidationResponse,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { allowedHosts, jsonError, withCappedBody } from "@/lib/accounts/http";
import { toolContextFor } from "@/lib/accounts/authz";
import { bearerKey, callerForMcpKey, mcpCredentials, mcpKeyRequired, type McpCaller } from "@/lib/accounts/mcp-keys";
import { isPublicMode } from "@/lib/accounts/mode";
import { clientIp } from "@/lib/accounts/network";
import { checkLimits, hitLimits, LIMITS } from "@/lib/accounts/rate-limit";
import { ACCOUNT_ID_PATTERN, getDefaultAccount } from "@/lib/accounts/store";
import { knifeMcpHandler } from "@/lib/mcp/server";

/**
 * The MCP endpoints (docs/MCP.md "Connecting"): `POST /api/mcp` (username + key, or in private mode no key = the default
 * account) and `POST /api/mcp/u/<username>` (the account's own URL: only `Authorization: Bearer <key>`, and the key must
 * belong to that username). Same handler, same rate limit, same generic 401.
 */

const CHALLENGE = 'Basic realm="Smart Knife MCP", charset="UTF-8"';
const BEARER_CHALLENGE = 'Bearer realm="Smart Knife MCP"';
/** JSON-RPC calls are small; the largest tool inputs (a CV import, a document) stay well under this. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function unauthorized(error: string, personal: boolean): Response {
  const response = jsonError(error, 401, {
    hint: personal
      ? "Send an MCP key of this account from the account page: Authorization: Bearer <key>."
      : "Send your username and an MCP key from the account page: Authorization: Basic base64(username:key), or Authorization: Bearer <key> with X-Knife-User: <username>.",
  });
  response.headers.set("WWW-Authenticate", personal ? BEARER_CHALLENGE : CHALLENGE);
  return response;
}

/** 429 while this address has failed too often; else null. Checked before any key is looked at. */
function limitedResponse(ip: string): Response | null {
  const limited = checkLimits([LIMITS.mcpAuthIp(ip)]);
  if (limited.ok) return null;
  const response = jsonError("too_many_attempts", 429, { retryAfterSeconds: limited.retryAfterSeconds });
  response.headers.set("Retry-After", String(limited.retryAfterSeconds));
  return response;
}

/**
 * Who is calling `/api/mcp`. An Authorization header always means an MCP key (both modes), and a wrong one is a 401,
 * never a fallback. Without one: private mode = the default account as before (the bind is the boundary) unless
 * KNIFE_MCP_REQUIRE_KEY is set; public mode = 401.
 */
function sharedCaller(request: Request): McpCaller | { response: Response } {
  const ip = clientIp(request);
  const credentials = mcpCredentials(request);
  if (credentials === null) {
    return mcpKeyRequired(isPublicMode()) ? { response: unauthorized("mcp_key_required", false) } : { account: getDefaultAccount(), scope: "full" };
  }
  const limited = limitedResponse(ip);
  if (limited) return { response: limited };
  const caller = credentials === "malformed" ? null : callerForMcpKey(credentials);
  if (!caller) {
    hitLimits([LIMITS.mcpAuthIp(ip)]);
    return { response: unauthorized("invalid_mcp_key", false) };
  }
  return caller;
}

/**
 * Who is calling `/api/mcp/u/<username>`: the key alone decides, in both modes, and it must be one of exactly that
 * account's keys (the id as stored: lowercase, no decoding tricks; anything else is the same 401 as a wrong key).
 */
function personalCaller(request: Request, username: string): McpCaller | { response: Response } {
  const ip = clientIp(request);
  const limited = limitedResponse(ip);
  if (limited) return { response: limited };
  const key = bearerKey(request);
  const caller = typeof key === "string" && ACCOUNT_ID_PATTERN.test(username) ? callerForMcpKey({ username, key }) : null;
  if (!caller) {
    hitLimits([LIMITS.mcpAuthIp(ip)]);
    return { response: unauthorized(key === null ? "mcp_key_required" : "invalid_mcp_key", true) };
  }
  return caller;
}

export async function handleMcpRequest(request: Request, personal?: { username: string }): Promise<Response> {
  const hosts = allowedHosts();
  const rejected =
    hostHeaderValidationResponse(request, hosts) ??
    originValidationResponse(request, hosts);
  if (rejected) return rejected;
  const caller = personal ? personalCaller(request, personal.username) : sharedCaller(request);
  if ("response" in caller) return caller.response;
  const capped = await withCappedBody(request, MAX_BODY_BYTES);
  if ("response" in capped) return capped.response;
  return knifeMcpHandler({ ...toolContextFor(caller.account), readOnly: caller.scope === "read-only" }).fetch(capped.request);
}
