import * as z from "zod/v4";
import { authenticate, json, jsonError, parseBody } from "@/lib/accounts/http";
import { requireAdmin } from "@/lib/accounts/authz";
import { rateLimitStats } from "@/lib/accounts/rate-limit";
import { alertStatus } from "@/lib/security/alerts";
import { loadSecurityHistory, recentSecurityEvents, recordSecurityEvent } from "@/lib/security/events";
import { currentGuard } from "@/lib/security/guard.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/security -> { guard: {mode, blocking, blocks[], tables, counters, budgets} | null, events[] (newest last,
 * at most 500, including the tail of the last two day files after a restart), rateLimits: per-namespace key counts,
 * alerts } (admins only). `guard` is null when the server was not started through scripts/serve.mjs (no preload).
 * docs/ACCOUNTS.md "Security events".
 */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const denied = requireAdmin(auth.account, "see security events");
  if (denied) return denied;
  await loadSecurityHistory();
  return json({ guard: currentGuard()?.snapshot() ?? null, events: recentSecurityEvents(500), rateLimits: rateLimitStats(), alerts: alertStatus() });
}

const bodySchema = z.object({ action: z.literal("unblock"), key: z.string().min(1).max(64).regex(/^[0-9a-f.:/]+$/i) }).strict();

/** POST /api/admin/security { action: "unblock", key: "<blocked prefix>" } -> { ok, removed }. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const denied = requireAdmin(auth.account, "lift blocks");
  if (denied) return denied;
  const parsed = await parseBody(request, bodySchema, '{ action: "unblock", key }');
  if ("response" in parsed) return parsed.response;
  const guard = currentGuard();
  if (!guard) return jsonError("The abuse guard is not running in this server process (start it with npm run start).", 503);
  const removed = guard.unblock(parsed.data.key);
  recordSecurityEvent({ kind: "unblock", ipPrefix: parsed.data.key, account: auth.account.id, detail: removed ? "block lifted" : "no active block" });
  return json({ ok: true, removed });
}
