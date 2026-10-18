import * as z from "zod/v4";
import { authenticate, json, jsonError, parseBody } from "@/lib/accounts/http";
import { requireAdmin } from "@/lib/accounts/authz";
import { adminAct } from "@/lib/accounts/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUOTA = 1024 ** 5;

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("disable") }).strict(),
  z.object({ action: z.literal("enable") }).strict(),
  z.object({ action: z.literal("delete") }).strict(),
  z.object({ action: z.literal("quota"), bytes: z.number().int().min(0).max(MAX_QUOTA).nullable() }).strict(),
  z.object({ action: z.literal("role"), role: z.enum(["admin", "user"]) }).strict(),
  z.object({ action: z.literal("resend-verification") }).strict(),
  z.object({ action: z.literal("network"), privateNetwork: z.boolean() }).strict(),
  z.object({ action: z.literal("provider-url"), baseUrl: z.string().trim().min(1).max(2_048).nullable() }).strict(),
  z.object({ action: z.literal("site-url"), url: z.string().trim().min(1).max(2_048).nullable() }).strict(),
]);

/** POST /api/admin/users/<id> { action, ... } -> disable (ends the user's sessions) | enable | delete | quota | role | resend-verification | network {privateNetwork} | provider-url {baseUrl|null} (public mode: approve a custom model provider for a non-admin) | site-url {url|null} (public mode: approve a website a non-admin may audit without GitHub verification). */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const denied = requireAdmin(auth.account, "manage users");
  if (denied) return denied;
  const parsed = await parseBody(request, bodySchema, "{ action: disable|enable|delete|quota|role|resend-verification|network|provider-url|site-url }");
  if ("response" in parsed) return parsed.response;
  const { id } = await ctx.params;
  const result = adminAct(auth.account.id, id, parsed.data);
  return result.ok ? json(result) : jsonError(result.error, result.status);
}
