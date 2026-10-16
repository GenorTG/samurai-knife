import {
  hostHeaderValidationResponse,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { allowedHosts, loginRequired, withCappedBody } from "@/lib/accounts/http";
import { isPublicMode } from "@/lib/accounts/mode";
import { resolveAccount } from "@/lib/accounts/session";
import { getDefaultAccount } from "@/lib/accounts/store";
import { knifeMcpHandler } from "@/lib/mcp/server";

/** JSON-RPC calls are small; the largest tool inputs (a CV import, a document) stay well under this. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

async function handle(request: Request): Promise<Response> {
  const hosts = allowedHosts();
  const rejected =
    hostHeaderValidationResponse(request, hosts) ??
    originValidationResponse(request, hosts);
  if (rejected) return rejected;
  const account = isPublicMode() ? resolveAccount(request) : getDefaultAccount();
  if (!account) return loginRequired();
  const capped = await withCappedBody(request, MAX_BODY_BYTES);
  if ("response" in capped) return capped.response;
  return knifeMcpHandler(account.id).fetch(capped.request);
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
