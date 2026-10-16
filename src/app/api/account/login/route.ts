import * as z from "zod/v4";
import { guard, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { authMode } from "@/lib/accounts/mode";
import { attemptLogin, clientIp, rotateSession } from "@/lib/accounts/session";
import { toPublicAccount } from "@/lib/accounts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// `id` = username, or (public mode) the account's email address.
const bodySchema = z.object({
  id: z.string().min(1).max(320),
  password: z.string().max(1_024),
}).strict();

const MESSAGES = {
  email_not_verified: "Confirm your email address first: open the link we sent you (or ask for a new one).",
  account_disabled: "This account is disabled. Contact the administrator.",
} as const;

export async function POST(request: Request): Promise<Response> {
  const blocked = guard(request, true);
  if (blocked) return blocked;

  const read = await readJsonBody(request, 8 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError("Expected { id, password }.", 400);

  const result = await attemptLogin(parsed.data.id, parsed.data.password, clientIp(request));
  if (!result.ok) {
    if (result.reason === "rate_limited") return jsonError("rate_limited", 429, { retryAfterSeconds: result.retryAfterSeconds });
    if (result.reason === "invalid_credentials") return jsonError("invalid_credentials", 401);
    return jsonError(result.reason, 403, { message: MESSAGES[result.reason] });
  }
  const response = json(toPublicAccount(result.account, authMode()));
  // Rotation: whatever session this browser had is revoked and a fresh one issued.
  response.headers.append("Set-Cookie", rotateSession(request, result.account));
  return response;
}
