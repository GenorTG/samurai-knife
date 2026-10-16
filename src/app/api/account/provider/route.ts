import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { openClawResponsesProblem } from "@/lib/accounts/openclaw-target";
import { baseUrlProblem, normalizeBaseUrl, validateExtraHeaders } from "@/lib/accounts/provider";
import { providerPolicy, strictHeaders } from "@/lib/net/outbound";
import { getAccount, setProvider, toPublicAccount } from "@/lib/accounts/store";
import { authMode } from "@/lib/accounts/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  baseUrl: z.string().trim().min(1).max(2_048),
  model: z.string().trim().min(1).max(200),
  // Omitted: keep the stored key. Empty string: clear it (keyless local servers).
  apiKey: z.string().max(4_096).optional(),
  // Omitted: keep stored headers. {}: clear them.
  extraHeaders: z.record(z.string(), z.string()).optional(),
  // Omitted: keep stored value. "": clear (provider default).
  reasoningEffort: z.enum(["", "low", "medium", "high"]).optional(),
  openClawResponses: z.boolean().optional(),
}).strict();

export async function PUT(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;

  const read = await readJsonBody(request, 64 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) {
    return jsonError(parsed.error.issues.map((issue) => issue.message).join("; "), 400);
  }

  const baseUrl = normalizeBaseUrl(parsed.data.baseUrl);
  if (!baseUrl) {
    return jsonError("baseUrl must be an http(s) URL without credentials, query or fragment.", 400);
  }
  if (parsed.data.extraHeaders) {
    const headerProblem = validateExtraHeaders(parsed.data.extraHeaders, strictHeaders(auth.account));
    if (headerProblem) return jsonError(headerProblem, 400);
  }
  // Checked again on every request (DNS can change); refusing here gives the user the reason at once.
  const addressProblem = await baseUrlProblem(baseUrl, providerPolicy(auth.account));
  if (addressProblem) return jsonError(`baseUrl: ${addressProblem}`, 400, { code: "address_not_allowed" });

  const current = getAccount(auth.account.id)?.provider ?? null;
  const openClawResponses = parsed.data.openClawResponses ?? current?.openClawResponses ?? false;
  if (openClawResponses) {
    const problem = openClawResponsesProblem(baseUrl, parsed.data.model);
    if (problem) return jsonError(problem, 400);
  }
  const effortValue = parsed.data.reasoningEffort === undefined ? current?.reasoningEffort : parsed.data.reasoningEffort || undefined;
  const effort = effortValue ? { reasoningEffort: effortValue } : {};
  const saved = setProvider(auth.account.id, {
    baseUrl,
    model: parsed.data.model,
    apiKey: parsed.data.apiKey ?? current?.apiKey ?? "",
    ...(parsed.data.extraHeaders !== undefined
      ? (Object.keys(parsed.data.extraHeaders).length > 0 ? { extraHeaders: parsed.data.extraHeaders } : {})
      : current?.extraHeaders ? { extraHeaders: current.extraHeaders } : {}),
    ...effort,
    openClawResponses,
  });
  if (!saved) return jsonError("account_not_found", 404);
  return json(toPublicAccount(saved, authMode()));
}
