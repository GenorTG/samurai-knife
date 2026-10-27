import { authenticate, json } from "@/lib/accounts/http";
import { siteErrorResponse } from "@/lib/site/http";
import { status } from "@/lib/site/service";
import { bindRequestProject } from "@/lib/cv/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/site/status -> view + live repository info + the repo's own agent instructions (AGENTS.md...). */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  try {
    return json(await status(auth.account.id));
  } catch (error) {
    return siteErrorResponse(error);
  }
}
