import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { authMode } from "@/lib/accounts/mode";
import { setAssistantLimits, toPublicAccount } from "@/lib/accounts/store";
import { turnLimitsSchema } from "@/lib/agent-client/turn-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The limits, or `{ reset: true }` for the defaults. */
const bodySchema = z.union([turnLimitsSchema, z.object({ reset: z.literal(true) }).strict()]);

/**
 * PUT /api/account/assistant { maxRounds, maxToolCalls } | { reset: true } -> the public account. The assistant's
 * per-turn budget (src/lib/agent-client/turn-limits.ts): bounds are checked here, the loop reads them from the account.
 */
export async function PUT(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(parsed.error.issues.map((issue) => `${issue.path.join("/") || "body"}: ${issue.message}`).join("; "), 400);
  const saved = setAssistantLimits(auth.account.id, "reset" in parsed.data ? null : parsed.data);
  if (!saved) return jsonError("account_not_found", 404);
  return json(toPublicAccount(saved, authMode()));
}
