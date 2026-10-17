import * as z from "zod/v4";
import { authenticate, json, parseBody } from "@/lib/accounts/http";
import { requireAdmin } from "@/lib/accounts/authz";
import { appStatus, forgetApp } from "@/lib/github-app/config";
import { jsonError } from "@/lib/accounts/http";
import { buildManifest, callbackBases, callbackPaths, publicBase } from "@/lib/github-app/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET -> the GitHub App's status and the callback URLs this server uses (admins). */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const denied = requireAdmin(auth.account, "manage the GitHub App");
  if (denied) return denied;
  const base = publicBase();
  return json({ ...appStatus(), publicUrl: base, callbackUrls: callbackBases().map((b) => callbackPaths(b).callback), setupUrl: base ? callbackPaths(base).setup : null });
}

const createSchema = z.object({ name: z.string().max(34).optional(), org: z.string().max(39).optional() }).strict();

/** POST {name?, org?} -> {postUrl, manifest}: the page POSTs the manifest to GitHub as a form (GitHub's manifest flow). */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const denied = requireAdmin(auth.account, "create the GitHub App");
  if (denied) return denied;
  const parsed = await parseBody(request, createSchema, "{ name?, org? }");
  if ("response" in parsed) return parsed.response;
  try {
    const { postUrl, manifest } = buildManifest(auth.account.id, parsed.data);
    return json({ postUrl, manifest: JSON.stringify(manifest) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 409);
  }
}

/** DELETE -> forget the local credentials (the app stays on GitHub until its owner deletes it there). */
export async function DELETE(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const denied = requireAdmin(auth.account, "remove the GitHub App");
  if (denied) return denied;
  return json({ removed: forgetApp() });
}
