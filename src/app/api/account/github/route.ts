import * as z from "zod/v4";
import { authenticate, json, jsonError, parseBody } from "@/lib/accounts/http";
import { unlinkGithub } from "@/lib/github-app/accounts";
import { forgetInstallations } from "@/lib/site/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ action: z.literal("unlink") }).strict();

/** POST /api/account/github {action:"unlink"} -> unlink the GitHub identity (and forget the linked app installations). */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(request, bodySchema, '{ action: "unlink" }');
  if ("response" in parsed) return parsed.response;
  const result = unlinkGithub(auth.account.id);
  if (!result.ok) return jsonError(result.message, 409);
  forgetInstallations(auth.account.id);
  return json({ ok: true });
}
