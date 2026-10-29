import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { normalizeBaseUrl, testProvider } from "@/lib/accounts/provider";
import { providerFromInput } from "@/lib/accounts/provider-input";
import { getAccount } from "@/lib/accounts/store";
import { withLearnedVision } from "@/lib/vision/capabilities";
import { admitProvider, outboundLimitMessage, providerNet } from "@/lib/net/outbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  baseUrl: z.string().trim().min(1).max(2_048),
  // Omitted: the stored key, but only for the stored base URL (a typed new address never receives the old key).
  apiKey: z.string().max(4_096).optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
}).strict();

/**
 * POST /api/account/provider/models { baseUrl, apiKey?, extraHeaders? } -> GET {baseUrl}/models for the fields as typed in
 * the settings (not saved yet), so the user can pick a model before saving. Same checks as a save (provider-input.ts:
 * public-mode hosts, address policy, header rules) and the same budget as Test; the key is never echoed.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 64 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(parsed.error.issues.map((issue) => issue.message).join("; "), 400);
  const stored = getAccount(auth.account.id)?.provider ?? null;
  const sameAddress = stored !== null && normalizeBaseUrl(parsed.data.baseUrl) === stored.baseUrl;
  // The model is not known yet: any non-empty value passes the shared checks and is never sent anywhere.
  const result = await providerFromInput(auth.account, { ...parsed.data, model: "model-list" }, sameAddress ? stored : null);
  if ("response" in result) return result.response;
  const budget = admitProvider(auth.account, "provider-test", result.config.baseUrl);
  if (budget.problem) return jsonError(budget.problem, 403, { code: "provider_not_allowed" });
  if (!budget.ok) {
    const limited = jsonError(outboundLimitMessage(budget.retryAfterSeconds), 429, { retryAfterSeconds: budget.retryAfterSeconds });
    limited.headers.set("Retry-After", String(budget.retryAfterSeconds));
    return limited;
  }
  return json(withLearnedVision(result.config.baseUrl, await testProvider(result.config, providerNet(auth.account))));
}
