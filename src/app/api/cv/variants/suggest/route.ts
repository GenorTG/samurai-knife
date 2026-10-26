import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { CvJobError, suggestForJob } from "@/lib/cv/jobs/service";
import { CV_LANGS } from "@/lib/cv/schema";
import { CvStoreError } from "@/lib/cv/store";
import { msgf } from "@/lib/i18n/msg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ jobId: z.string().min(1).max(64), lang: z.enum(CV_LANGS), maxBulletsPerRole: z.number().int().min(1).max(12).optional() }).strict();

/** POST /api/cv/variants/suggest { jobId, lang, maxBulletsPerRole? }: a PROPOSED variant ranked by evidence for the job. Nothing is saved (POST /api/cv/variants does that). */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 64 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(msgf("Bad request: {value}: {message}", { value: parsed.error.issues[0].path.join("/") || "body", message: parsed.error.issues[0].message }), 422);
  try {
    const { jobId, lang, maxBulletsPerRole } = parsed.data;
    return json({ saved: false, ...suggestForJob(auth.account.id, jobId, lang, maxBulletsPerRole) });
  } catch (error) {
    if (error instanceof CvJobError) return jsonError(error.message, error.status);
    if (error instanceof CvStoreError) return jsonError(error.message, 500);
    throw error;
  }
}
