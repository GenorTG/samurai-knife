import { handleMcpRequest } from "@/lib/mcp/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/mcp/u/<username>: the account's own MCP URL; only `Authorization: Bearer <key>` of that account (docs/MCP.md). */
export async function POST(request: Request, ctx: { params: Promise<{ username: string }> }): Promise<Response> {
  const { username } = await ctx.params;
  return handleMcpRequest(request, { username });
}
