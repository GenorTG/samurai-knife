import { authenticate, json } from "@/lib/accounts/http";
import { liveRun, type RunEvent } from "@/lib/workflows/server/runner";
import { getRun } from "@/lib/workflows/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/workflows/<id>/runs/<runId>/events?after=N -> `{ events, next, done }`: the run's progress events after
 * index N, held open up to 20 s while nothing new happened (long poll). A run no longer in memory answers from storage.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string; runId: string }> }): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const { id, runId } = await ctx.params;
  const after = Math.max(0, Number.parseInt(new URL(request.url).searchParams.get("after") ?? "0", 10) || 0);
  const live = liveRun(auth.account.id, runId);
  if (!live || live.workflowId !== id) {
    const stored = /^[0-9a-f]{16}$/.test(runId) ? getRun(auth.account.id, id, runId) : null;
    if (!stored) return json({ events: [], next: after, done: false, unknown: true });
    return json({ events: after === 0 ? [{ type: "done", status: stored.status, ...(stored.error ? { error: stored.error } : {}) }] : [], next: Math.max(after, 1), done: true });
  }
  if (live.events.length <= after && !live.done) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, 20_000);
      function finish() {
        clearTimeout(timer);
        live?.emitter.off("event", finish);
        request.signal.removeEventListener("abort", finish);
        resolve();
      }
      live.emitter.on("event", finish);
      request.signal.addEventListener("abort", finish, { once: true });
    });
  }
  const events: RunEvent[] = live.events.slice(after);
  return json({ events, next: after + events.length, done: live.done || events.some((event) => event.type === "done") });
}
