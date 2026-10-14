import * as z from "zod/v4";
import { cvMutationRoute } from "@/lib/cv/http";
import { setRewrites } from "@/lib/cv/rewrites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bi = z.object({ pl: z.string().max(4_000).optional(), en: z.string().max(4_000).optional() }).strict();
const bodySchema = z.object({
  variantId: z.string().min(1).max(64),
  set: z.array(z.object({ path: z.string().min(1).max(300), text: bi }).strict()).max(60).default([]),
  remove: z.array(z.string().max(300)).max(60).default([]),
}).strict();

/** POST /api/cv/variants/rewrite { variantId, set?, remove? }: per-version wording of master texts; returns fact `warnings`. */
export async function POST(request: Request): Promise<Response> {
  return cvMutationRoute(request, bodySchema, (data, body) => {
    const out = setRewrites(data, body.variantId, body.set, body.remove);
    return { data: out.data, result: { variant: out.variant, warnings: out.warnings } };
  });
}
