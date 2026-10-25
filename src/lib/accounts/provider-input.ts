import * as z from "zod/v4";
import { jsonError } from "@/lib/accounts/http";
import { baseUrlProblem, normalizeBaseUrl, validateExtraHeaders } from "@/lib/accounts/provider";
import type { Account, ProviderConfig } from "@/lib/accounts/store";
import { providerPolicy, providerUrlProblem, strictHeaders } from "@/lib/net/outbound";

/**
 * One provider config from a request (the account's provider, or a saved profile): the same checks for both, so a
 * profile can never hold what the provider form would refuse (public-mode host rules, address policy, header rules).
 */
export const providerInputSchema = z.object({
  baseUrl: z.string().trim().min(1).max(2_048),
  model: z.string().trim().min(1).max(200),
  // Omitted: keep the stored key. Empty string: clear it (keyless local servers).
  apiKey: z.string().max(4_096).optional(),
  // Omitted: keep stored headers. {}: clear them.
  extraHeaders: z.record(z.string(), z.string()).optional(),
  // Omitted: keep stored value. "": clear (provider default).
  reasoningEffort: z.enum(["", "low", "medium", "high"]).optional(),
  // Sent by pages loaded before the Responses continuation was removed (2026-10-25): accepted and ignored.
  openClawResponses: z.boolean().optional(),
}).strict();

export type ProviderInput = z.infer<typeof providerInputSchema>;

/** The config to store, or the refusal to send. `current` = what is stored now (kept fields come from it). */
export async function providerFromInput(account: Account, input: ProviderInput, current: ProviderConfig | null): Promise<{ config: ProviderConfig } | { response: Response }> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!baseUrl) return { response: jsonError("baseUrl must be an http(s) URL without credentials, query or fragment.", 400) };
  if (input.extraHeaders) {
    const headerProblem = validateExtraHeaders(input.extraHeaders, strictHeaders(account));
    if (headerProblem) return { response: jsonError(headerProblem, 400) };
  }
  // Public mode: known provider hosts only for non-admins, or the base URL an admin approved for this account.
  const hostProblem = providerUrlProblem(account, baseUrl);
  if (hostProblem) return { response: jsonError(`baseUrl: ${hostProblem}`, 400, { code: "provider_not_allowed" }) };
  // Checked again on every request (DNS can change); refusing here gives the user the reason at once.
  const addressProblem = await baseUrlProblem(baseUrl, providerPolicy(account));
  if (addressProblem) return { response: jsonError(`baseUrl: ${addressProblem}`, 400, { code: "address_not_allowed" }) };
  const effortValue = input.reasoningEffort === undefined ? current?.reasoningEffort : input.reasoningEffort || undefined;
  return {
    config: {
      baseUrl,
      model: input.model,
      apiKey: input.apiKey ?? current?.apiKey ?? "",
      ...(input.extraHeaders !== undefined
        ? Object.keys(input.extraHeaders).length > 0
          ? { extraHeaders: input.extraHeaders }
          : {}
        : current?.extraHeaders
          ? { extraHeaders: current.extraHeaders }
          : {}),
      ...(effortValue ? { reasoningEffort: effortValue } : {}),
    },
  };
}
