import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { workflowError, zodMessage } from "@/lib/workflows/server/http";
import { cancelRun } from "@/lib/workflows/server/runner";
import { removeWait } from "@/lib/workflows/server/trigger-index";
import { deleteRun, getRun, requireWorkflow } from "@/lib/workflows/server/store";
import { msg } from "@/lib/i18n/msg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; runId: string }> };

/** GET /api/workflows/<id>/runs/<runId> -> `{ run }` (node data trimmed to the first items; never the waiting state). */
export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const { id, runId } = await ctx.params;
  try {
    requireWorkflow(auth.account.id, id);
    const run = getRun(auth.account.id, id, runId);
    if (!run) return jsonError(msg("Unknown run."), 404);
    const { waiting: _waiting, waitingBlobs: _blobs, resumeHash: _hash, ...visible } = run;
    void _waiting;
    void _blobs;
    void _hash;
    return json({ run: visible });
  } catch (error) {
    return workflowError(error);
  }
}

const actionSchema = z.object({ action: z.literal("cancel") }).strict();

/** POST /api/workflows/<id>/runs/<runId> { action: "cancel" } -> `{ canceled }` (a running run stops; a waiting one is dropped). */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const { id, runId } = await ctx.params;
  const read = await readJsonBody(request, 1024);
  if ("response" in read) return read.response;
  const parsed = actionSchema.safeParse(read.body);
  if (!parsed.success) return jsonError(zodMessage(parsed.error), 422);
  try {
    requireWorkflow(auth.account.id, id);
    if (cancelRun(auth.account.id, runId)) return json({ canceled: true });
    const run = getRun(auth.account.id, id, runId);
    if (run?.status === "waiting") {
      removeWait(runId);
      deleteRun(auth.account.id, id, runId);
      return json({ canceled: true });
    }
    return json({ canceled: false });
  } catch (error) {
    return workflowError(error);
  }
}

/** DELETE /api/workflows/<id>/runs/<runId> -> 204. */
export async function DELETE(request: Request, ctx: Ctx): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const { id, runId } = await ctx.params;
  try {
    requireWorkflow(auth.account.id, id);
    removeWait(runId);
    deleteRun(auth.account.id, id, runId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return workflowError(error);
  }
}
