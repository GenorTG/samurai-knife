import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { testProvider } from "@/lib/accounts/provider";
import { getAccount, PROFILE_ID, providerProfileConfig } from "@/lib/accounts/store";
import { admitProvider, outboundLimitMessage, providerNet } from "@/lib/net/outbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/account/provider/test { profileId? } -> GET {baseUrl}/models through the SSRF-safe transport for the active
 * provider or one saved profile; in public mode a non-admin never sees a raw response body.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  // No body = the active provider (the original shape); a body must be JSON like every other mutating route.
  let wanted: unknown;
  if (request.headers.get("content-type") || request.headers.get("content-length") !== null && request.headers.get("content-length") !== "0") {
    const read = await readJsonBody(request, 1024);
    if ("response" in read) return read.response;
    wanted = (read.body as { profileId?: unknown } | null)?.profileId;
  }
  const account = getAccount(auth.account.id);
  if (typeof wanted === "string" && !PROFILE_ID.test(wanted)) return jsonError("Unknown profile.", 404);
  const provider = account ? (typeof wanted === "string" ? providerProfileConfig(account, wanted) : account.provider) : null;
  if (!provider) return jsonError(typeof wanted === "string" ? "Unknown profile." : "provider_not_configured", typeof wanted === "string" ? 404 : 409);
  const budget = admitProvider(auth.account, "provider-test", provider.baseUrl);
  if (budget.problem) return jsonError(budget.problem, 403, { code: "provider_not_allowed" });
  if (!budget.ok) {
    const limited = jsonError(outboundLimitMessage(budget.retryAfterSeconds), 429, { retryAfterSeconds: budget.retryAfterSeconds });
    limited.headers.set("Retry-After", String(budget.retryAfterSeconds));
    return limited;
  }
  return json(await testProvider(provider, providerNet(auth.account)));
}
