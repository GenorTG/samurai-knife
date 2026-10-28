import { authenticate, json } from "@/lib/accounts/http";
import { requireAdmin } from "@/lib/accounts/authz";
import { showcaseErrorResponse } from "@/lib/cv/showcase/http";
import { showcaseRank } from "@/lib/cv/showcase/service";
import { bindRequestProject } from "@/lib/cv/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/cv/showcase/rank?owner=: top public non-fork repos by showcase value, with reasons and what to improve first. */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  // Admin-only: these reach the server owner's own GitHub login (`gh`) or disk, never a user's (docs/ACCOUNTS.md "Roles").
  const denied = requireAdmin(auth.account, "read GitHub repositories with the server's own login");
  if (denied) return denied;
  try {
    return json(await showcaseRank(new URL(request.url).searchParams.get("owner") ?? undefined));
  } catch (error) {
    return showcaseErrorResponse(error);
  }
}
