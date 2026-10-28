import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { authMode } from "@/lib/accounts/mode";
import { providerFromInput, providerInputSchema } from "@/lib/accounts/provider-input";
import { activateProviderProfile, deleteProviderProfile, getAccount, PROFILE_ID, ProfileError, providerProfileConfig, saveProviderProfile, toPublicAccount } from "@/lib/accounts/store";
import { msg } from "@/lib/i18n/msg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const profileId = z.string().regex(PROFILE_ID);
const name = z.string().trim().min(1).max(60);
const bodySchema = z.discriminatedUnion("action", [
  /** New profile; `activate` makes it the assistant's provider at once; `from` = a profile whose key/headers are kept when omitted. */
  z.object({ action: z.literal("create"), name, provider: providerInputSchema, activate: z.boolean().optional(), from: profileId.optional() }).strict(),
  /** Change a profile (omitted key/headers are kept, as in PUT /api/account/provider). */
  z.object({ action: z.literal("update"), id: profileId, name, provider: providerInputSchema }).strict(),
  /** Copy a profile under a new name (with its key; the copy is not active). */
  z.object({ action: z.literal("duplicate"), id: profileId, name }).strict(),
  z.object({ action: z.literal("activate"), id: profileId }).strict(),
  z.object({ action: z.literal("delete"), id: profileId }).strict(),
]);

/** GET /api/account/provider-profiles -> `{ profiles }` (hints only, never a key). */
export function GET(request: Request): Response {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  return json({ profiles: toPublicAccount(auth.account, authMode()).providerProfiles });
}

/**
 * POST /api/account/provider-profiles { action, … } -> `{ account, profileId? }`. Saved provider profiles: several
 * named endpoint/key/model sets per account; the active one is the assistant's provider, and workflow AI nodes may use
 * any of them. Every config passes the same checks as PUT /api/account/provider (src/lib/accounts/provider-input.ts).
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 64 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(parsed.error.issues.map((issue) => `${issue.path.join("/") || "body"}: ${issue.message}`).join("; "), 400);
  const body = parsed.data;
  const account = getAccount(auth.account.id);
  if (!account) return jsonError("account_not_found", 404);
  try {
    switch (body.action) {
      case "create": {
        const from = body.from ? (providerProfileConfig(account, body.from) ?? null) : null;
        if (body.from && !from) return jsonError(msg("Unknown profile."), 404);
        const result = await providerFromInput(auth.account, body.provider, from);
        if ("response" in result) return result.response;
        const saved = saveProviderProfile(account.id, { name: body.name, config: result.config, activate: body.activate });
        return json({ account: toPublicAccount(saved.account, authMode()), profileId: saved.profileId }, 201);
      }
      case "update": {
        const current = providerProfileConfig(account, body.id);
        if (!current) return jsonError(msg("Unknown profile."), 404);
        const result = await providerFromInput(auth.account, body.provider, current, body.id);
        if ("response" in result) return result.response;
        const saved = saveProviderProfile(account.id, { profileId: body.id, name: body.name, config: result.config });
        return json({ account: toPublicAccount(saved.account, authMode()), profileId: saved.profileId });
      }
      case "duplicate": {
        const current = providerProfileConfig(account, body.id);
        if (!current) return jsonError(msg("Unknown profile."), 404);
        const saved = saveProviderProfile(account.id, { name: body.name, config: current });
        return json({ account: toPublicAccount(saved.account, authMode()), profileId: saved.profileId }, 201);
      }
      case "activate":
        return json({ account: toPublicAccount(activateProviderProfile(account.id, body.id), authMode()) });
      case "delete":
        return json({ account: toPublicAccount(deleteProviderProfile(account.id, body.id), authMode()) });
    }
  } catch (error) {
    if (error instanceof ProfileError) return jsonError(error.message, error.status);
    throw error;
  }
}
