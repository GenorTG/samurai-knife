import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { jobStore } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/jobs/<id> -> { jobId, status: queued|running|done|failed|cancelled, position?, queuedMs, runMs, result?, error? } */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  const record = jobStore().get(id, auth.account.id);
  if (!record) return jobError();
  return json({ ok: true, ...jobStore().view(record) });
}

/**
 * DELETE /api/jobs/<id>: cancel a queued/running job (answers once its process group is gone) or remove a finished
 * one together with its result file.
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  const store = jobStore();
  const record = store.get(id, auth.account.id);
  if (!record) return jobError();
  const status = await store.cancelOrDelete(record);
  return json({ ok: true, jobId: id, status });
}

function jobError(): Response {
  return jsonError("job_not_found", 404, { ok: false });
}
