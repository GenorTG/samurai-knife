import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { getOp } from "@/lib/services/ops";
import { opViewFor } from "@/lib/services/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/services/ops/<opId> -> `{ op }`: phase, percent, pull progress, log tail, error/hint once finished (log/pull/hint for admins only). Poll it. */
export async function GET(request: Request, ctx: { params: Promise<{ opId: string }> }): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const { opId } = await ctx.params;
  const op = getOp(opId);
  // Non-admins (public mode) get progress and outcome only: no log, pull details or hints.
  return op ? json({ op: opViewFor(auth.account, op) }) : jsonError("op_not_found", 404);
}
