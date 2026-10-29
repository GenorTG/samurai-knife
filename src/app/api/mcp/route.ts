import { handleMcpRequest } from "@/lib/mcp/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/mcp: username + MCP key (or, in private mode without KNIFE_MCP_REQUIRE_KEY, the default account). */
export async function POST(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}
