import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { normalizeBaseUrl } from "@/lib/accounts/provider";
import { providerFromInput } from "@/lib/accounts/provider-input";
import { getAccount } from "@/lib/accounts/store";
import { learnedVision, rememberVision } from "@/lib/vision/capabilities";
import { MAX_PROBE_MODELS, probeVision, withProbeSlot, type ProbeReason } from "@/lib/vision/probe";
import { admitProvider, outboundLimitMessage, providerNet } from "@/lib/net/outbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const modelId = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f]+$/);
const bodySchema = z.object({
  baseUrl: z.string().trim().min(1).max(2_048),
  // Omitted: the stored key, but only for the stored base URL (as in /models: a typed new address never gets the old key).
  apiKey: z.string().max(4_096).optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  models: z.array(modelId).min(1).max(MAX_PROBE_MODELS),
  /** Check again even when an answer is remembered. */
  force: z.boolean().optional(),
}).strict();

interface ProbeResult {
  model: string;
  vision: boolean | null;
  /** `detected` when the answer is learned (just now or earlier); null when it is still unknown. */
  source: "detected" | null;
  reason: ProbeReason | "cached" | "rate_limited";
  status: number | null;
  checkedAt?: string;
}

/**
 * POST /api/account/provider/vision-probe { baseUrl, apiKey?, extraHeaders?, models[1..6], force? } -> `{ results }`.
 * Asks each model one tiny question with a generated picture (src/lib/vision/probe.ts) and remembers definite answers
 * for every account (src/lib/vision/capabilities.ts). Same checks as a save and the model list (provider-input.ts),
 * each probe is one model request on the account's provider budget, at most 3 of an account run at once.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 64 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(parsed.error.issues.map((issue) => issue.message).join("; "), 400);
  const { models, force, ...fields } = parsed.data;
  const stored = getAccount(auth.account.id)?.provider ?? null;
  const sameAddress = stored !== null && normalizeBaseUrl(fields.baseUrl) === stored.baseUrl;
  const checked = await providerFromInput(auth.account, { ...fields, model: models[0] }, sameAddress ? stored : null);
  if ("response" in checked) return checked.response;
  const config = checked.config;
  const net = providerNet(auth.account);

  const unique = [...new Set(models)];
  const results: ProbeResult[] = [];
  const pending: string[] = [];
  for (const model of unique) {
    const learned = force ? null : learnedVision(config.baseUrl, model);
    if (learned) results.push({ model, vision: learned.vision, source: "detected", reason: "cached", status: null, checkedAt: learned.checkedAt });
    else pending.push(model);
  }

  // Every probe is a model request: admitted (and counted) one by one, like a chat round.
  const admitted: string[] = [];
  for (const model of pending) {
    const budget = admitProvider(auth.account, "provider", config.baseUrl);
    if (budget.problem) return jsonError(budget.problem, 403, { code: "provider_not_allowed" });
    if (!budget.ok) {
      if (admitted.length === 0 && results.length === 0) {
        const limited = jsonError(outboundLimitMessage(budget.retryAfterSeconds), 429, { retryAfterSeconds: budget.retryAfterSeconds });
        limited.headers.set("Retry-After", String(budget.retryAfterSeconds));
        return limited;
      }
      results.push({ model, vision: null, source: null, reason: "rate_limited", status: 429 });
      continue;
    }
    admitted.push(model);
  }

  const probed = await Promise.all(admitted.map((model) => withProbeSlot(auth.account.id, async (): Promise<ProbeResult> => {
    const verdict = await probeVision(config, net, model);
    if (verdict.vision === null) return { model, vision: null, source: null, reason: verdict.reason, status: verdict.status };
    const entry = rememberVision(config.baseUrl, model, verdict.vision);
    return { model, vision: verdict.vision, source: "detected", reason: verdict.reason, status: verdict.status, ...(entry ? { checkedAt: entry.checkedAt } : {}) };
  })));
  results.push(...probed);
  const order = new Map(unique.map((model, index) => [model, index]));
  results.sort((a, b) => (order.get(a.model) ?? 0) - (order.get(b.model) ?? 0));
  return json({ results });
}
