import { guard, json } from "@/lib/accounts/http";
import { clearedCookieHeader, cookieValue, revokeSessionToken } from "@/lib/accounts/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const blocked = guard(request, true);
  if (blocked) return blocked;
  revokeSessionToken(cookieValue(request));
  const response = json({ ok: true });
  response.headers.append("Set-Cookie", clearedCookieHeader(request));
  return response;
}
