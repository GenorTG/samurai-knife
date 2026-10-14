import * as z from "zod/v4";
import { guard, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { attemptLogin, clientIp, sessionCookieHeader } from "@/lib/accounts/session";
import { toPublicAccount } from "@/lib/accounts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  id: z.string().min(1).max(64),
  password: z.string().max(1_024),
}).strict();

export async function POST(request: Request): Promise<Response> {
  const blocked = guard(request, true);
  if (blocked) return blocked;

  const read = await readJsonBody(request, 8 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError("Expected { id, password }.", 400);

  const result = attemptLogin(parsed.data.id, parsed.data.password, clientIp(request));
  if (!result.ok) {
    return result.reason === "rate_limited"
      ? jsonError("rate_limited", 429, { retryAfterSeconds: result.retryAfterSeconds })
      : jsonError("invalid_credentials", 401);
  }
  const response = json(toPublicAccount(result.account));
  response.headers.append("Set-Cookie", sessionCookieHeader(request, result.account));
  return response;
}
