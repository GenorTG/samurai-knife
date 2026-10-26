import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { emptyTrash } from "@/lib/office/folders";
import { officeError } from "@/lib/office/http";
import { msg } from "@/lib/i18n/msg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ action: z.literal("empty") }).strict();

/** POST /api/office/trash { action: "empty" } -> `{ docs, folders, freedBytes }`. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 1024);
  if ("response" in read) return read.response;
  if (!bodySchema.safeParse(read.body).success) return jsonError(msg("Expected { action: \"empty\" }."), 422);
  try {
    return json(emptyTrash(auth.account.id));
  } catch (error) {
    return officeError(error);
  }
}
