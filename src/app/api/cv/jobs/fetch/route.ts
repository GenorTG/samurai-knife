import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { CvJobError, fetchAndSaveJob } from "@/lib/cv/jobs/service";
import { CvStoreError } from "@/lib/cv/store";
import { quotaErrorResponse } from "@/lib/storage/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  urlOrText: z.string().min(1).max(200_000),
  title: z.string().max(300).optional(),
  company: z.string().max(300).optional(),
  companyUrl: z.string().max(2_000).optional(),
  notes: z.string().max(20_000).optional(),
}).strict();

/**
 * POST /api/cv/jobs/fetch { urlOrText, title?, company?, companyUrl?, notes? }: fetch ONE posting (SSRF-guarded; a
 * justjoin.it offer link is read through the board's offer API) or take pasted text, detect language, save it as a
 * job with the user's notes; the company website is read for context when given (failure = `companyNote`, not an
 * error). 422 with a reason when the posting cannot be read (paste it instead).
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 512 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(`Bad request: ${parsed.error.issues[0].path.join("/") || "body"}: ${parsed.error.issues[0].message}`, 422);
  try {
    const { urlOrText, ...hints } = parsed.data;
    const saved = await fetchAndSaveJob(auth.account.id, urlOrText, hints);
    return json({ revision: saved.revision, job: saved.job, refreshed: saved.refreshed, extracted: saved.extracted, companyNote: saved.companyNote });
  } catch (error) {
    if (error instanceof CvJobError) return jsonError(error.message, error.status);
    if (error instanceof CvStoreError) return jsonError(error.message, 500);
    const full = quotaErrorResponse(error);
    if (full) return full;
    throw error;
  }
}
