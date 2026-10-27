import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { requireAdmin } from "@/lib/accounts/authz";
import { showcaseErrorResponse } from "@/lib/cv/showcase/http";
import { addProjectFromGithub } from "@/lib/cv/showcase/service";
import { CvStoreError } from "@/lib/cv/store";
import { quotaErrorResponse } from "@/lib/storage/http";
import { msgf } from "@/lib/i18n/msg";
import { bindRequestProject } from "@/lib/cv/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ repo: z.string().min(1).max(300), pinned: z.boolean().optional() }).strict();

/** POST /api/cv/showcase/project { repo, pinned? }: add (or refresh) a master-CV project from a GitHub repo link; returns the draft and its facts. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  // Admin-only: these reach the server owner's own GitHub login (`gh`) or disk, never a user's (docs/ACCOUNTS.md "Roles").
  const denied = requireAdmin(auth.account, "read GitHub repositories with the server's own login");
  if (denied) return denied;
  const read = await readJsonBody(request, 16 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(msgf("Bad request: {value}: {message}", { value: parsed.error.issues[0].path.join("/") || "body", message: parsed.error.issues[0].message }), 422);
  try {
    return json(await addProjectFromGithub(auth.account.id, parsed.data.repo, parsed.data.pinned ?? false));
  } catch (error) {
    if (error instanceof CvStoreError) return jsonError(error.message, 500);
    const full = quotaErrorResponse(error);
    if (full) return full;
    return showcaseErrorResponse(error);
  }
}
