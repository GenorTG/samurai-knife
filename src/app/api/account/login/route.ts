import * as z from "zod/v4";
import { guard, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { authMode, isPublicMode } from "@/lib/accounts/mode";
import { deviceCookieHeader, DEVICE_COOKIE } from "@/lib/accounts/known-device";
import { powField } from "@/lib/accounts/pow";
import { attemptLogin, clientIp, cookieValue, isHttps, passwordFingerprint, rotateSession } from "@/lib/accounts/session";
import { toPublicAccount } from "@/lib/accounts/store";
import { msg } from "@/lib/i18n/msg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// `id` = username, or (public mode) the account's email address. `pow` only when a 428 asked for it.
const bodySchema = z.object({
  id: z.string().min(1).max(320),
  password: z.string().max(1_024),
  pow: powField,
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
  if (!parsed.success) return jsonError(msg("Expected { id, password }."), 400);

  const result = await attemptLogin(parsed.data.id, parsed.data.password, clientIp(request), {
    deviceCookie: cookieValue(request, DEVICE_COOKIE),
    pow: parsed.data.pow,
  });
  if (!result.ok) {
    const retry = result.retryAfterSeconds;
    let response: Response;
    if (result.reason === "rate_limited") response = jsonError("rate_limited", 429, { retryAfterSeconds: retry });
    else if (result.reason === "invalid_credentials") response = jsonError("invalid_credentials", 401);
    else if (result.reason === "challenge_required") response = jsonError("challenge_required", 428, { bits: result.bits, form: "login" });
    else if (result.reason === "busy") response = jsonError("busy", 503, { retryAfterSeconds: retry, message: "The server is busy. Try again in a few seconds." });
    else response = jsonError(result.reason, 403, { message: MESSAGES[result.reason] });
    if (retry) response.headers.set("Retry-After", String(retry));
    return response;
  }
  const response = json(toPublicAccount(result.account, authMode()));
  // Rotation: whatever session this browser had is revoked and a fresh one issued.
  response.headers.append("Set-Cookie", rotateSession(request, result.account));
  // This browser becomes a known device for the account (its logins survive a lockout by strangers).
  if (isPublicMode()) {
    response.headers.append("Set-Cookie", deviceCookieHeader(cookieValue(request, DEVICE_COOKIE), result.account.id, passwordFingerprint(result.account), isHttps(request)));
  }
  return response;
}
