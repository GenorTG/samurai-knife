import { authenticate, json } from "@/lib/accounts/http";
import { workflowError } from "@/lib/workflows/server/http";
import { listRuns, requireWorkflow } from "@/lib/workflows/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/workflows/<id>/runs -> `{ runs }` (newest first; kept: the last 100 / 14 days). */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  try {
    requireWorkflow(auth.account.id, id);
    return json({ runs: listRuns(auth.account.id, id) });
  } catch (error) {
    return workflowError(error);
  }
}
