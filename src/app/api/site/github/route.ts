import { authenticate, json } from "@/lib/accounts/http";
import { appStatus } from "@/lib/github-app/config";
import { siteErrorResponse } from "@/lib/site/http";
import { appRepositories } from "@/lib/site/service";
import { bindRequestProject } from "@/lib/cv/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/site/github -> is there a GitHub App, which installations this account linked, and their repositories. */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  const app = appStatus();
  try {
    return json({ app: app.configured ? { slug: app.slug, name: app.name, installUrl: app.installUrl } : null, ...(app.configured ? appRepositories(auth.account.id) : { login: null, installations: [] }) });
  } catch (error) {
    return siteErrorResponse(error);
  }
}
