import { guard, json, jsonError, publicOnly } from "@/lib/accounts/http";
import { clientIp } from "@/lib/accounts/network";
import { isPowForm, issueChallenge } from "@/lib/accounts/pow";
import { msg } from "@/lib/i18n/msg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/account/challenge?form=register|forgot|resend|reset|login[&bits=N] -> { c, bits, expiresInSeconds }: a signed
 * proof-of-work challenge for this client (docs/ACCOUNTS.md "Proof of work"). `bits`: the difficulty a 428 asked for
 * (raised while an identifier or the server is under attack); never below the server's own requirement, never above
 * KNIFE_POW_MAX_BITS. Stateless and cheap (one HMAC); public mode only, like the forms it protects.
 */
export async function GET(request: Request): Promise<Response> {
  const off = publicOnly();
  if (off) return off;
  const blocked = guard(request, false);
  if (blocked) return blocked;
  const form = new URL(request.url).searchParams.get("form");
  if (!isPowForm(form)) return jsonError(msg("Expected ?form=register|forgot|resend|reset|login."), 400);
  const asked = Number(new URL(request.url).searchParams.get("bits") ?? "");
  return json(issueChallenge(form, clientIp(request), Number.isInteger(asked) && asked > 0 ? { atLeastBits: asked } : {}));
}
