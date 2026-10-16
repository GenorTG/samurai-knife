import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { requireAdmin } from "@/lib/accounts/authz";
import { showcaseErrorResponse } from "@/lib/cv/showcase/http";
import { githubRepoFacts } from "@/lib/cv/showcase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/cv/showcase/repo?repo=owner/name: GitHub facts + checklist + score. */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  // Admin-only: these reach the server owner's own GitHub login (`gh`) or disk, never a user's (docs/ACCOUNTS.md "Roles").
  const denied = requireAdmin(auth.account, "read GitHub repositories with the server's own login");
  if (denied) return denied;
  const repo = new URL(request.url).searchParams.get("repo")?.trim() ?? "";
  if (!repo) return jsonError("Pass ?repo=owner/name.", 422);
  try {
    return json(await githubRepoFacts(repo));
  } catch (error) {
    return showcaseErrorResponse(error);
  }
}
