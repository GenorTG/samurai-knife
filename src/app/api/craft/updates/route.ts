import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { requireAdmin } from "@/lib/accounts/authz";
import { applyCraftUpdate, craftUpdatesView, holdCraft, rollbackCraft, setCraftUpdateMode, startCraftCheck } from "@/lib/craft/updates";
import { SidecarError } from "@/lib/services/manager";
import { msgf } from "@/lib/i18n/msg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const appId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const bodySchema = z.discriminatedUnion("action", [
  /** Background check; `apply` also switches every app that is not held (what the auto mode does daily). */
  z.object({ action: z.literal("check"), apply: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("apply"), app: appId }).strict(),
  z.object({ action: z.literal("rollback"), app: appId }).strict(),
  z.object({ action: z.literal("hold"), app: appId, hold: z.boolean() }).strict(),
  z.object({ action: z.literal("mode"), mode: z.enum(["auto", "notify", "off"]) }).strict(),
]);

function serviceError(error: unknown): Response {
  if (error instanceof SidecarError) return jsonError(error.message, error.status, error.hint ? { hint: error.hint } : undefined);
  throw error;
}

/** GET /api/craft/updates -> the update channel per app (admins only). docs/SIDECARS.md "Updates". */
export function GET(request: Request): Response {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const denied = requireAdmin(auth.account, "manage the Craft apps updates");
  if (denied) return denied;
  return json(craftUpdatesView());
}

/** POST /api/craft/updates { action, ... } (admins only): check (202, background), apply, rollback, hold, mode. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const denied = requireAdmin(auth.account, "manage the Craft apps updates");
  if (denied) return denied;
  const read = await readJsonBody(request, 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(msgf("Bad request: {value}: {message}", { value: parsed.error.issues[0].path.join("/") || "body", message: parsed.error.issues[0].message }), 422);
  const body = parsed.data;
  try {
    switch (body.action) {
      case "check":
        return json({ started: startCraftCheck(Boolean(body.apply)), view: craftUpdatesView() }, 202);
      case "apply":
        await applyCraftUpdate(body.app);
        return json(craftUpdatesView());
      case "rollback":
        await rollbackCraft(body.app);
        return json(craftUpdatesView());
      case "hold":
        holdCraft(body.app, body.hold);
        return json(craftUpdatesView());
      case "mode":
        setCraftUpdateMode(body.mode);
        return json(craftUpdatesView());
    }
  } catch (error) {
    return serviceError(error);
  }
}
