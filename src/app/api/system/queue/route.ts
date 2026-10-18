import { authenticate, json } from "@/lib/accounts/http";
import { requireAdmin } from "@/lib/accounts/authz";
import { jobStore } from "@/lib/jobs";
import { uploadBudgetStats } from "@/lib/upload-budget";
import { pythonQueue } from "@/lib/work-queue";
import { isolateStats } from "@/lib/isolate/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/system/queue -> per-lane work-queue stats (queued/running/completed/failed/cancelled, wait/run p50/p95), async-job
 * store totals, the isolate pool (worker threads for untrusted CPU work) and the uploads in flight (upload-budget.ts).
 */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const denied = requireAdmin(auth.account, "see server queue stats");
  if (denied) return denied;
  return json({ ok: true, lanes: pythonQueue().stats(), jobs: jobStore().stats(), isolate: isolateStats(), uploads: uploadBudgetStats() });
}
