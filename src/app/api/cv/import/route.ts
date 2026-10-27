import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { cvStoreErrorResponse } from "@/lib/cv/http";
import { CvImportError, importProfile } from "@/lib/cv/import";
import { msg } from "@/lib/i18n/msg";
import { bindRequestProject } from "@/lib/cv/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ profile: z.unknown(), overwrite: z.boolean().optional() }).strict();

/** POST /api/cv/import { profile, overwrite? }: replace the master profile with a validated one. 409 if one exists and overwrite is not set; 422 when invalid. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  const read = await readJsonBody(request, 1024 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(msg("Expected { profile, overwrite? }."), 422);
  try {
    const { data, replaced } = importProfile(auth.account.id, parsed.data.profile, parsed.data.overwrite === true);
    return json({ revision: data.revision, replaced });
  } catch (error) {
    if (error instanceof CvImportError) return jsonError(error.message, error.message.startsWith("A profile already") ? 409 : 422);
    const stored = cvStoreErrorResponse(error);
    if (stored) return stored;
    throw error;
  }
}
