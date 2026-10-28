import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { applyOps, CvOpError, type CvOp } from "@/lib/cv/ops";
import { cvStoreErrorResponse } from "@/lib/cv/http";
import { mutateCv } from "@/lib/cv/store";
import { factWarnings } from "@/lib/cv/text/guard";
import { msgf } from "@/lib/i18n/msg";
import { bindRequestProject } from "@/lib/cv/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), path: z.string().min(1).max(300), value: z.unknown() }).strict(),
  z.object({ op: z.literal("add"), path: z.string().min(1).max(300), value: z.unknown() }).strict(),
  z.object({ op: z.literal("remove"), path: z.string().min(1).max(300) }).strict(),
]);
const bodySchema = z.object({ ops: z.array(opSchema).min(1).max(40) }).strict();

/** POST /api/cv/patch { ops }: the UI's edit path; same engine as `knife_cv_patch`. 422 with the reason when an op is invalid. `warnings` lists hard facts a rewrite dropped (the edit is applied anyway). */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  const read = await readJsonBody(request, 512 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(msgf("Expected { ops }: {message}", { message: parsed.error.issues[0].message }), 422);
  try {
    const { data, result } = mutateCv(auth.account.id, (current) => {
      const applied = applyOps(current.profile, parsed.data.ops as CvOp[]);
      return { data: { ...current, profile: applied.profile }, result: applied.changes };
    });
    return json({ revision: data.revision, changes: result, warnings: factWarnings(result) });
  } catch (error) {
    if (error instanceof CvOpError) return jsonError(error.message, 422);
    const stored = cvStoreErrorResponse(error);
    if (stored) return stored;
    throw error;
  }
}
