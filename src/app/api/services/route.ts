import { authenticate, json } from "@/lib/accounts/http";
import { SIDECARS } from "@/lib/services/definitions";
import { ensureReaper, status } from "@/lib/services/manager";
import { runningOp } from "@/lib/services/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/services -> `{ services: [status + running op] }` for every sidecar definition (installed or not). */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  ensureReaper();
  const services = await Promise.all(SIDECARS.map(async (def) => ({ ...(await status(def.id)), op: runningOp(def.id) })));
  return json({ services });
}
