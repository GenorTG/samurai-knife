import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { testProvider } from "@/lib/accounts/provider";
import { getAccount } from "@/lib/accounts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const provider = getAccount(auth.account.id)?.provider;
  if (!provider) return jsonError("provider_not_configured", 409);
  return json(await testProvider(provider));
}
