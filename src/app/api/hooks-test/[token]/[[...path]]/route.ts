import { handleHook } from "@/lib/workflows/server/hooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Test webhook URLs: `/api/hooks-test/<token>/<path>`, answered only while the editor listens (one call per Listen). */
async function handle(request: Request, ctx: { params: Promise<{ token: string; path?: string[] }> }): Promise<Response> {
  const { token, path } = await ctx.params;
  return handleHook(request, token, (path ?? []).join("/"), true);
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD };
