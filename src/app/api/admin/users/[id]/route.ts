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
]);

/** POST /api/admin/users/<id> { action, ... } -> disable (ends the user's sessions) | enable | delete | quota | role | resend-verification. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const denied = requireAdmin(auth.account, "manage users");
  if (denied) return denied;
  const parsed = await parseBody(request, bodySchema, "{ action: disable|enable|delete|quota|role|resend-verification }");
  if ("response" in parsed) return parsed.response;
  const { id } = await ctx.params;
  const result = adminAct(auth.account.id, id, parsed.data);
  return result.ok ? json(result) : jsonError(result.error, result.status);
}
