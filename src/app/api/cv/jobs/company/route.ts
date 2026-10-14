import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { CvJobError, refreshCompany } from "@/lib/cv/jobs/service";
import { CvStoreError } from "@/lib/cv/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ jobId: z.string().min(1).max(64), url: z.string().max(2_000).optional() }).strict();

/** POST /api/cv/jobs/company { jobId, url? }: (re)read the offer's company website (SSRF-guarded) as tailoring context. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 16 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(`Bad request: ${parsed.error.issues[0].path.join("/") || "body"}: ${parsed.error.issues[0].message}`, 422);
  try {
    const res = await refreshCompany(auth.account.id, parsed.data.jobId, parsed.data.url);
    return json({ revision: res.revision, job: res.job, companyNote: res.note });
  } catch (error) {
    if (error instanceof CvJobError) return jsonError(error.message, error.status);
    if (error instanceof CvStoreError) return jsonError(error.message, 500);
    throw error;
  }
}
