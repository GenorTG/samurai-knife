import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { providerFromInput, providerInputSchema } from "@/lib/accounts/provider-input";
import { getAccount, setProvider, toPublicAccount } from "@/lib/accounts/store";
import { authMode } from "@/lib/accounts/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT /api/account/provider: the active provider profile (same checks as every saved profile, provider-input.ts). */
export async function PUT(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;

  const read = await readJsonBody(request, 64 * 1024);
  if ("response" in read) return read.response;
  const parsed = providerInputSchema.safeParse(read.body);
  if (!parsed.success) {
    return jsonError(parsed.error.issues.map((issue) => issue.message).join("; "), 400);
  }
  const current = getAccount(auth.account.id)?.provider ?? null;
  const result = await providerFromInput(auth.account, parsed.data, current);
  if ("response" in result) return result.response;
  const saved = setProvider(auth.account.id, result.config);
  if (!saved) return jsonError("account_not_found", 404);
  return json(toPublicAccount(saved, authMode()));
}
