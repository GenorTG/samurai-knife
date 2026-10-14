import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { CV_LANGS, type CvLang } from "@/lib/cv/schema";
import { CvStoreError, loadCv } from "@/lib/cv/store";
import { auditProfile } from "@/lib/cv/text/audit";
import { ScopeError } from "@/lib/cv/text/walk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/cv/audit?lang=pl|en[&scope=/experience/id=x]: the same payload as `knife_cv_audit` (findings keyed by editable path). */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const params = new URL(request.url).searchParams;
  const lang = params.get("lang");
  if (!lang || !CV_LANGS.includes(lang as CvLang)) return jsonError("Pass ?lang=pl or ?lang=en.", 422);
  try {
    return json(auditProfile(loadCv(auth.account.id).profile, lang as CvLang, params.get("scope") ?? "/", { includeTypography: params.get("typography") === "1" }));
  } catch (error) {
    if (error instanceof ScopeError) return jsonError(error.message, 422);
    if (error instanceof CvStoreError) return jsonError(error.message, 500);
    throw error;
  }
}
