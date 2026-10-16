import * as z from "zod/v4";
import { authenticate, json, parseBody } from "@/lib/accounts/http";
import { clearedCookieHeader, revokeAllSessions, sessionCount } from "@/lib/accounts/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ action: z.literal("revoke-all") }).strict();

/** GET /api/account/sessions -> { count } of this account's live sessions. */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  return json({ count: sessionCount(auth.account.id) });
}

/** POST /api/account/sessions { action: "revoke-all" } -> "log out everywhere", this browser included. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(request, bodySchema, '{ action: "revoke-all" }');
  if ("response" in parsed) return parsed.response;
  const revoked = revokeAllSessions(auth.account.id);
  const response = json({ ok: true, revoked });
  response.headers.append("Set-Cookie", clearedCookieHeader(request));
  return response;
}
