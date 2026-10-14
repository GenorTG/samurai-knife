import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { showcaseErrorResponse } from "@/lib/cv/showcase/http";
import { localFacts } from "@/lib/cv/showcase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/cv/showcase/local?path=: facts + checklist + score for a local git repo inside the allow-listed roots (403 elsewhere). */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const path = new URL(request.url).searchParams.get("path")?.trim() ?? "";
  if (!path) return jsonError("Pass ?path=<git repo root>.", 422);
  try {
    return json(await localFacts(path));
  } catch (error) {
    return showcaseErrorResponse(error);
  }
}
