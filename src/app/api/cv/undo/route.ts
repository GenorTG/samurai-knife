import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { cvStoreErrorResponse } from "@/lib/cv/http";
import { loadCv, undoCv } from "@/lib/cv/store";
import { msg } from "@/lib/i18n/msg";
import { bindRequestProject } from "@/lib/cv/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/cv/undo: restore the state before the last save. 409 when there is nothing to undo. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  try {
    if (!undoCv(auth.account.id)) return jsonError(msg("Nothing to undo."), 409);
    return json({ revision: loadCv(auth.account.id).revision });
  } catch (error) {
    const stored = cvStoreErrorResponse(error);
    if (stored) return stored;
    throw error;
  }
}
