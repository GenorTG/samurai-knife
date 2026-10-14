import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { showcaseErrorResponse } from "@/lib/cv/showcase/http";
import { githubRepoFacts } from "@/lib/cv/showcase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/cv/showcase/repo?repo=owner/name: GitHub facts + checklist + score. */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const repo = new URL(request.url).searchParams.get("repo")?.trim() ?? "";
  if (!repo) return jsonError("Pass ?repo=owner/name.", 422);
  try {
    return json(await githubRepoFacts(repo));
  } catch (error) {
    return showcaseErrorResponse(error);
  }
}
