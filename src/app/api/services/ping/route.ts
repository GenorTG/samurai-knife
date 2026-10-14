import { json } from "@/lib/accounts/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/services/ping -> `{ ok: true }`. Called from INSIDE a sidecar container to prove it can reach this app (the
 * app URL check after start). No guard on purpose: the container's Host header may be host.docker.internal, and the
 * answer carries nothing.
 */
export function GET(): Response {
  return json({ ok: true, app: "samurai-knife" });
}
