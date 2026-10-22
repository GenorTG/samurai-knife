import { authenticate, json, readJsonBody } from "@/lib/accounts/http";
import { hookUrls } from "@/lib/workflows/server/hooks";
import { workflowError } from "@/lib/workflows/server/http";
import { rotateHookToken } from "@/lib/workflows/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/workflows/<id>/token {} -> `{ workflow, hooks }`: new webhook URLs (the old ones stop working at once). */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 1024);
  if ("response" in read) return read.response;
  const { id } = await ctx.params;
  try {
    const workflow = rotateHookToken(auth.account.id, id);
    return json({ workflow, hooks: hookUrls(workflow) });
  } catch (error) {
    return workflowError(error);
  }
}
