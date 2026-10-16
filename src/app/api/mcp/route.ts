import {
  hostHeaderValidationResponse,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { allowedHosts, loginRequired } from "@/lib/accounts/http";
import { isPublicMode } from "@/lib/accounts/mode";
import { resolveAccount } from "@/lib/accounts/session";
import { getDefaultAccount } from "@/lib/accounts/store";
import { knifeMcpHandler } from "@/lib/mcp/server";

async function handle(request: Request): Promise<Response> {
  const hosts = allowedHosts();
  const rejected =
    hostHeaderValidationResponse(request, hosts) ??
    originValidationResponse(request, hosts);
  if (rejected) return rejected;
  const account = isPublicMode() ? resolveAccount(request) : getDefaultAccount();
  if (!account) return loginRequired();
  return knifeMcpHandler(account.id).fetch(request);
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
