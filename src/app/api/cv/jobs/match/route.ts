import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { CvJobError, matchJob } from "@/lib/cv/jobs/service";
import { CV_LANGS, type CvLang } from "@/lib/cv/schema";
import { CvStoreError } from "@/lib/cv/store";
import { msg } from "@/lib/i18n/msg";
import { bindRequestProject } from "@/lib/cv/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/cv/jobs/match?id=<jobId>&lang=pl|en: coverage report of the master profile against a saved job. 404 unknown job, 422 bad lang or empty profile. */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  const params = new URL(request.url).searchParams;
  const id = params.get("id") ?? "";
  const lang = params.get("lang") ?? "";
  if (!id) return jsonError(msg("Pass ?id=<jobId>."), 422);
  if (!(CV_LANGS as readonly string[]).includes(lang)) return jsonError(msg("Pass lang=pl or lang=en."), 422);
  try {
    return json(matchJob(auth.account.id, id, lang as CvLang));
  } catch (error) {
    if (error instanceof CvJobError) return jsonError(error.message, error.status);
    if (error instanceof CvStoreError) return jsonError(error.message, 500);
    throw error;
  }
}
