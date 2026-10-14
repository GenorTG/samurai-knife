import * as z from "zod/v4";
import { removeVariant, upsertVariant } from "@/lib/cv/collections";
import { cvDeleteRoute, cvMutationRoute } from "@/lib/cv/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/cv/variants { variant }: create or update a per-job CV version. Referenced ids are validated against the profile (422 lists the valid ones). */
export async function POST(request: Request): Promise<Response> {
  return cvMutationRoute(request, z.object({ variant: z.record(z.string(), z.unknown()) }).strict(), (data, body) => {
    const { data: next, variant } = upsertVariant(data, body.variant);
    return { data: next, result: { variant } };
  });
}

/** DELETE /api/cv/variants?id=<id> */
export async function DELETE(request: Request): Promise<Response> {
  return cvDeleteRoute(request, removeVariant);
}
