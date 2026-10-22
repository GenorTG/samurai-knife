import { handleHook } from "@/lib/workflows/server/hooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Production webhook URLs of active workflows: `/api/hooks/<token>/<path>`. No session, no Origin guard: the token and
 * the Webhook node's own auth decide (src/lib/workflows/server/hooks.ts, docs/WORKFLOWS.md "Triggers").
 */
async function handle(request: Request, ctx: { params: Promise<{ token: string; path?: string[] }> }): Promise<Response> {
  const { token, path } = await ctx.params;
  return handleHook(request, token, (path ?? []).join("/"), false);
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD };
