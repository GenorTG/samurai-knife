import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { requireAdmin } from "@/lib/accounts/authz";
import { showcaseErrorResponse } from "@/lib/cv/showcase/http";
import { localFacts } from "@/lib/cv/showcase/service";
import { msg } from "@/lib/i18n/msg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/cv/showcase/local?path=: facts + checklist + score for a local git repo inside the allow-listed roots (403 elsewhere). */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  // Admin-only: these reach the server owner's own GitHub login (`gh`) or disk, never a user's (docs/ACCOUNTS.md "Roles").
  const denied = requireAdmin(auth.account, "read git repositories on the server's disk");
  if (denied) return denied;
  const path = new URL(request.url).searchParams.get("path")?.trim() ?? "";
  if (!path) return jsonError(msg("Pass ?path=<git repo root>."), 422);
  try {
    return json(await localFacts(path));
  } catch (error) {
    return showcaseErrorResponse(error);
  }
}
