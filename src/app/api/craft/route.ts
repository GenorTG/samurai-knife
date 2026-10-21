import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { craftLaunch } from "@/lib/craft/launch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/craft -> `{ origin, proxied, apps: [{id, url}] }`: where the ArtCraft page loads each app (with a fresh proxy
 * ticket when KNIFE_CRAFT_PUBLIC_URL is set). 409 `not_installed` without the sidecar. docs/SIDECARS.md "ArtCraft".
 */
export function GET(request: Request): Response {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const launch = craftLaunch(auth.account.id);
  if (!launch) return jsonError("not_installed", 409);
  return json(launch);
}
