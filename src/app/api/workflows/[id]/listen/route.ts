import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { listenForTestCall, stopListening } from "@/lib/workflows/server/hooks";
import { workflowError, zodMessage } from "@/lib/workflows/server/http";
import { draftWorkflow } from "@/lib/workflows/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const listenSchema = z.object({ draft: z.object({ nodes: z.array(z.unknown()).max(300), connections: z.array(z.unknown()).max(1000), settings: z.unknown().optional() }) }).strict();

/**
 * POST /api/workflows/<id>/listen { draft } -> `{ runId }` when a test URL of this workflow was called within ~110 s
 * (the call runs the posted draft), or `{ runId: null }` at the timeout. One listener per workflow: a new one replaces it.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  const read = await readJsonBody(request, 4 * 1024 * 1024);
  if ("response" in read) return read.response;
  const parsed = listenSchema.safeParse(read.body);
  if (!parsed.success) return jsonError(zodMessage(parsed.error), 422);
  try {
    const workflow = draftWorkflow(auth.account.id, id, parsed.data.draft as Parameters<typeof draftWorkflow>[2]);
    const stop = () => stopListening(auth.account.id, id);
    request.signal.addEventListener("abort", stop, { once: true });
    const runId = await listenForTestCall(auth.account.id, workflow);
    request.signal.removeEventListener("abort", stop);
    return json({ runId });
  } catch (error) {
    return workflowError(error);
  }
}

/** DELETE /api/workflows/<id>/listen -> 204 (stop listening). */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  stopListening(auth.account.id, id);
  return new Response(null, { status: 204 });
}
