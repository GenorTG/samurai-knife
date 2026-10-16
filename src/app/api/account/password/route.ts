import * as z from "zod/v4";
import { authenticate, flowErrorResponse, json, parseBody, publicOnly } from "@/lib/accounts/http";
import { sessionCookieHeader, createSession } from "@/lib/accounts/session";
import { changePassword } from "@/lib/accounts/flows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ currentPassword: z.string().max(2_048), newPassword: z.string().max(2_048) }).strict();

/**
 * POST /api/account/password { currentPassword, newPassword } -> every session of the account ends (other devices are signed
 * out); this browser gets a fresh one.
 */
export async function POST(request: Request): Promise<Response> {
  const off = publicOnly();
  if (off) return off;
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(request, bodySchema, "{ currentPassword, newPassword }");
  if ("response" in parsed) return parsed.response;
  const result = await changePassword(auth.account, parsed.data.currentPassword, parsed.data.newPassword);
  if (!result.ok) return flowErrorResponse(result);
  const response = json({ ok: true, signedOut: Math.max(0, result.revoked - 1) });
  response.headers.append("Set-Cookie", sessionCookieHeader(request, createSession(result.account)));
  return response;
}
