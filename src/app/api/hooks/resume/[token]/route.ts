import { handleResume } from "@/lib/workflows/server/hooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `$execution.resumeUrl` of a run waiting in a Wait node ("on webhook call"): GET or POST continues it once. */
async function handle(request: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  return handleResume(request, token);
}

export { handle as GET, handle as POST };
