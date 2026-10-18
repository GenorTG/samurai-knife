import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { testProvider } from "@/lib/accounts/provider";
import { getAccount } from "@/lib/accounts/store";
import { admitProvider, outboundLimitMessage, providerNet } from "@/lib/net/outbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET {baseUrl}/models through the SSRF-safe transport; in public mode a non-admin never sees a raw response body. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const provider = getAccount(auth.account.id)?.provider;
  if (!provider) return jsonError("provider_not_configured", 409);
  const budget = admitProvider(auth.account, "provider-test", provider.baseUrl);
  if (budget.problem) return jsonError(budget.problem, 403, { code: "provider_not_allowed" });
  if (!budget.ok) {
    const limited = jsonError(outboundLimitMessage(budget.retryAfterSeconds), 429, { retryAfterSeconds: budget.retryAfterSeconds });
    limited.headers.set("Retry-After", String(budget.retryAfterSeconds));
    return limited;
  }
  return json(await testProvider(provider, providerNet(auth.account)));
}
