import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { takePoll, validClientId } from "@/lib/ui-bridge/store";
import { msg } from "@/lib/i18n/msg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ui/poll?client=<tab id> -> { known, events }: what MCP agents asked this (visible) tab to show; polling marks
 * it as listening. `known: false` = no presence for this id (not recorded): the tab reports and polls again.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const clientId = new URL(request.url).searchParams.get("client") ?? "";
  if (!validClientId(clientId)) return jsonError(msg("Pass ?client=<tab id>."), 422);
  return json(takePoll(auth.account.id, clientId));
}
