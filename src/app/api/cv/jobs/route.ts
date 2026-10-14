import * as z from "zod/v4";
import { removeJob, upsertJob } from "@/lib/cv/collections";
import { cvDeleteRoute, cvMutationRoute } from "@/lib/cv/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/cv/jobs { job }: create (id derived from company-title) or update a saved job offer. */
export async function POST(request: Request): Promise<Response> {
  return cvMutationRoute(request, z.object({ job: z.record(z.string(), z.unknown()) }).strict(), (data, body) => {
    const { data: next, job } = upsertJob(data, body.job);
    return { data: next, result: { job } };
  });
}

/** DELETE /api/cv/jobs?id=<id>: also detaches it from applications. */
export async function DELETE(request: Request): Promise<Response> {
  return cvDeleteRoute(request, removeJob);
}
