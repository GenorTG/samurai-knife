import {
  hostHeaderValidationResponse,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { allowedHosts, jsonError } from "@/lib/accounts/http";
import { toolContextFor } from "@/lib/accounts/authz";
import { accountForMcpKey, mcpCredentials } from "@/lib/accounts/mcp-keys";
import { isPublicMode } from "@/lib/accounts/mode";
import { clientIp } from "@/lib/accounts/network";
import { checkLimits, hitLimits, LIMITS } from "@/lib/accounts/rate-limit";
import { getDefaultAccount, type Account } from "@/lib/accounts/store";
import { knifeMcpHandler } from "@/lib/mcp/server";

const CHALLENGE = 'Basic realm="Samurai Knife MCP", charset="UTF-8"';

function unauthorized(error: string): Response {
  const response = jsonError(error, 401, { hint: "Send your username and an MCP key from the account page: Authorization: Basic base64(username:key), or Authorization: Bearer <key> with X-Knife-User: <username>." });
  response.headers.set("WWW-Authenticate", CHALLENGE);
  return response;
}

/**
 * Who is calling. An Authorization header always means an MCP key (both modes), and a wrong one is a 401, never a
 * fallback. Without one: private mode = the default account as before (the bind is the boundary); public mode = 401.
 */
function resolveCaller(request: Request): { account: Account } | { response: Response } {
  const ip = clientIp(request);
  const credentials = mcpCredentials(request);
  if (credentials === null) {
    return isPublicMode() ? { response: unauthorized("mcp_key_required") } : { account: getDefaultAccount() };
  }
  const limited = checkLimits([LIMITS.mcpAuthIp(ip)]);
  if (!limited.ok) {
    const response = jsonError("too_many_attempts", 429, { retryAfterSeconds: limited.retryAfterSeconds });
    response.headers.set("Retry-After", String(limited.retryAfterSeconds));
    return { response };
  }
  const account = credentials === "malformed" ? null : accountForMcpKey(credentials);
  if (!account) {
    hitLimits([LIMITS.mcpAuthIp(ip)]);
    return { response: unauthorized("invalid_mcp_key") };
  }
  return { account };
}

async function handle(request: Request): Promise<Response> {
  const hosts = allowedHosts();
  const rejected =
    hostHeaderValidationResponse(request, hosts) ??
    originValidationResponse(request, hosts);
  if (rejected) return rejected;
  const caller = resolveCaller(request);
  if ("response" in caller) return caller.response;
  return knifeMcpHandler(toolContextFor(caller.account)).fetch(request);
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
