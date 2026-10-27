import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { atsForAccount, CvJobError } from "@/lib/cv/jobs/service";
import { CV_LANGS } from "@/lib/cv/schema";
import { CvStoreError } from "@/lib/cv/store";
import { msg, msgf } from "@/lib/i18n/msg";
import { bindRequestProject } from "@/lib/cv/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ variantId: z.string().max(64).optional(), jobId: z.string().max(64).optional(), lang: z.enum(CV_LANGS).optional() }).strict();

/** POST /api/cv/variants/ats { variantId } | { jobId, lang }: ATS check of what the version prints against its offer. Read-only. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  const read = await readJsonBody(request, 16 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(msgf("Bad request: {value}: {message}", { value: parsed.error.issues[0].path.join("/") || "body", message: parsed.error.issues[0].message }), 422);
  if (!parsed.data.variantId && !parsed.data.jobId) return jsonError(msg("Pass variantId or jobId."), 422);
  try {
    return json(atsForAccount(auth.account.id, parsed.data));
  } catch (error) {
    if (error instanceof CvJobError) return jsonError(error.message, error.status);
    if (error instanceof CvStoreError) return jsonError(error.message, 500);
    throw error;
  }
}
