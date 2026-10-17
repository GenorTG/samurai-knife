import * as z from "zod/v4";
import { flowErrorResponse, json, parseBody, publicOnly } from "@/lib/accounts/http";
import { verifyToken } from "@/lib/accounts/flows";
import { clientIp } from "@/lib/accounts/network";
import { cookieValue } from "@/lib/accounts/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ token: z.string().max(256) }).strict();

/**
 * POST /api/account/verify { token } -> { kind: "verified" | "email_changed", username }; the link works once. A confirmed
 * address change signs out the account's other sessions (this browser keeps its own).
 */
export async function POST(request: Request): Promise<Response> {
  const off = publicOnly();
  if (off) return off;
  const parsed = await parseBody(request, bodySchema, "{ token }");
  if ("response" in parsed) return parsed.response;
  const result = verifyToken(parsed.data.token, clientIp(request), cookieValue(request));
  return result.ok ? json({ ok: true, kind: result.kind, username: result.username }) : flowErrorResponse(result);
}
