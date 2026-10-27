import { authenticate, json } from "@/lib/accounts/http";
import { requireAdmin } from "@/lib/accounts/authz";
import { sidecarBackend } from "@/lib/services/backend";
import { refreshSyncChecks } from "@/lib/services/sync-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/sidecars -> { backend, syncNeeded: [{ id, name, reason, message, command, checkedAt }] } (admins only):
 * installed sidecars whose root bundle differs from what this release renders, checked now (src/lib/services/sync-check.ts).
 * Empty with the docker backend (nothing to sync). docs/DEPLOY.md "Sidecars without the docker group".
 */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const denied = requireAdmin(auth.account, "see sidecar status");
  if (denied) return denied;
  const syncNeeded = await refreshSyncChecks();
  return json({
    backend: sidecarBackend().kind,
    syncNeeded: syncNeeded.map(({ id, name, reason, message, command, checkedAt }) => ({ id, name, reason, message, command, checkedAt })),
  });
}
