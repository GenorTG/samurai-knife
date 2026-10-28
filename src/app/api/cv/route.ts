import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { CvStoreError, loadCv } from "@/lib/cv/store";
import { bindRequestProject, currentProjectId, CvProjectError, listProjects } from "@/lib/cv/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cv: the CV data of one project (profile, variants, jobs, applications), its revision, which project it is
 * (`project`) and the account's projects (`projects`, `active`). Without `?project=` it is the ACTIVE project, so a page
 * that polls follows a switch made by the assistant or another tab. `?revision=N&shown=<project>` answers
 * `{ changed:false }` when that project is still the one and nothing is newer (cheap polling).
 */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  try {
    const data = loadCv(auth.account.id);
    const params = new URL(request.url).searchParams;
    const project = currentProjectId(auth.account.id);
    const { active, projects } = listProjects(auth.account.id);
    const known = Number(params.get("revision"));
    const shown = params.get("shown");
    if (Number.isInteger(known) && known === data.revision && known > 0 && (!shown || shown === project)) {
      return json({ changed: false, revision: data.revision, project });
    }
    return json({ changed: true, ...data, project, active, projects });
  } catch (error) {
    if (error instanceof CvStoreError) return jsonError(error.message, 500);
    if (error instanceof CvProjectError) return jsonError(error.message, error.status);
    throw error;
  }
}
