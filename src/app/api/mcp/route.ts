import {
  hostHeaderValidationResponse,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { allowedHosts } from "@/lib/accounts/http";
import { knifeMcpHandler } from "@/lib/mcp/server";

async function handle(request: Request): Promise<Response> {
  const hosts = allowedHosts();
  const rejected =
    hostHeaderValidationResponse(request, hosts) ??
    originValidationResponse(request, hosts);
  return rejected ?? knifeMcpHandler.fetch(request);
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
