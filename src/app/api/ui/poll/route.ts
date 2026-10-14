import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { takePending, validClientId } from "@/lib/ui-bridge/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/ui/poll?client=<tab id>: what MCP agents asked this (visible) tab to show; polling marks it as listening. */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const clientId = new URL(request.url).searchParams.get("client") ?? "";
  if (!validClientId(clientId)) return jsonError("Pass ?client=<tab id>.", 422);
  return json({ events: takePending(auth.account.id, clientId) });
}
