import { guard, json, jsonError, publicOnly } from "@/lib/accounts/http";
import { clientIp } from "@/lib/accounts/network";
import { isPowForm, issueChallenge } from "@/lib/accounts/pow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/account/challenge?form=register|forgot|resend|reset|login -> { c, bits, expiresInSeconds }: a signed
 * proof-of-work challenge for this client (docs/ACCOUNTS.md "Proof of work"). Stateless and cheap (one HMAC); public
 * mode only, like the forms it protects.
 */
export async function GET(request: Request): Promise<Response> {
  const off = publicOnly();
  if (off) return off;
  const blocked = guard(request, false);
  if (blocked) return blocked;
  const form = new URL(request.url).searchParams.get("form");
  if (!isPowForm(form)) return jsonError("Expected ?form=register|forgot|resend|reset|login.", 400);
  return json(issueChallenge(form, clientIp(request)));
}
