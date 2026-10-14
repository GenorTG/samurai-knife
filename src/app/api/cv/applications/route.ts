import * as z from "zod/v4";
import { removeApplication, upsertApplication } from "@/lib/cv/collections";
import { cvDeleteRoute, cvMutationRoute } from "@/lib/cv/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/cv/applications { application, note? }: create or update; a status change appends a dated history entry. */
export async function POST(request: Request): Promise<Response> {
  return cvMutationRoute(request, z.object({ application: z.record(z.string(), z.unknown()), note: z.string().max(500).optional() }).strict(), (data, body) => {
    const { data: next, application } = upsertApplication(data, body.application, body.note ?? "");
    return { data: next, result: { application } };
  });
}

/** DELETE /api/cv/applications?id=<id> */
export async function DELETE(request: Request): Promise<Response> {
  return cvDeleteRoute(request, removeApplication);
}
