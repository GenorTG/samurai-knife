import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { quotaErrorResponse } from "@/lib/storage/http";
import { CvPhotoError, decodeJpegDataUrl, deletePhoto, MAX_PHOTO_BYTES, photoMeta, readPhoto, savePhoto } from "@/lib/cv/photo-store";
import { msg, msgf } from "@/lib/i18n/msg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ dataUrl: z.string().max(Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 64) }).strict();

function photoError(error: unknown): Response {
  if (error instanceof CvPhotoError) return jsonError(error.message, 422);
  const full = quotaErrorResponse(error);
  if (full) return full;
  throw error;
}

/**
 * GET /api/cv/photo -> the account's CV photo (image/jpeg), 404 when there is none.
 * GET /api/cv/photo?meta=1 -> `{ photo: {bytes, updatedAt} | null }`.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  try {
    if (new URL(request.url).searchParams.has("meta")) return json({ photo: photoMeta(auth.account.id) });
    const bytes = readPhoto(auth.account.id);
    if (!bytes) return jsonError(msg("No photo yet."), 404);
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    return photoError(error);
  }
}

/** POST /api/cv/photo { dataUrl: "data:image/jpeg;base64,…" } -> `{ photo: meta }`. The browser crops and re-encodes first. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(msgf("Bad request: {value}: {message}", { value: parsed.error.issues[0].path.join("/") || "body", message: parsed.error.issues[0].message }), 422);
  try {
    return json({ photo: savePhoto(auth.account.id, decodeJpegDataUrl(parsed.data.dataUrl)) });
  } catch (error) {
    return photoError(error);
  }
}

/** DELETE /api/cv/photo -> `{ removed: boolean }`. */
export async function DELETE(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  try {
    return json({ removed: deletePhoto(auth.account.id) });
  } catch (error) {
    return photoError(error);
  }
}
