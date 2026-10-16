import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { showcaseErrorResponse } from "@/lib/cv/showcase/http";
import { addProjectFromGithub } from "@/lib/cv/showcase/service";
import { CvStoreError } from "@/lib/cv/store";
import { quotaErrorResponse } from "@/lib/storage/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ repo: z.string().min(1).max(300), pinned: z.boolean().optional() }).strict();

/** POST /api/cv/showcase/project { repo, pinned? }: add (or refresh) a master-CV project from a GitHub repo link; returns the draft and its facts. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 16 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(`Bad request: ${parsed.error.issues[0].path.join("/") || "body"}: ${parsed.error.issues[0].message}`, 422);
  try {
    return json(await addProjectFromGithub(auth.account.id, parsed.data.repo, parsed.data.pinned ?? false));
  } catch (error) {
    if (error instanceof CvStoreError) return jsonError(error.message, 500);
    const full = quotaErrorResponse(error);
    if (full) return full;
    return showcaseErrorResponse(error);
  }
}
