import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { assertFolder, libraryBytes, readLibrary } from "@/lib/office/folders";
import { officeError } from "@/lib/office/http";
import { createDoc, MAX_DOC_BYTES, MAX_VERSIONS, splitName, TRASH_DAYS } from "@/lib/office/store";
import { buildDocument, OFFICE_FORMATS } from "@/lib/office/templates";
import { assertCanStore, storageUsage } from "@/lib/storage/quota";
import { msgf } from "@/lib/i18n/msg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const folderId = z.string().regex(/^[a-f0-9]{16}$/).nullable().optional();

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), format: z.enum(OFFICE_FORMATS), name: z.string().max(200).optional(), folderId }).strict(),
  z.object({
    action: z.literal("upload"),
    name: z.string().min(1).max(200),
    /** Base64 file bytes (the browser reads the picked file; JSON only, like every mutating route). */
    data: z.string().max(Math.ceil((MAX_DOC_BYTES * 4) / 3) + 8),
    folderId,
  }).strict(),
]);

/**
 * GET /api/office/docs -> `{ docs, folders, trash: {docs, folders}, storage, bytes: {files, versions, trash}, limits }`:
 * the whole library of the calling account in one read (documents newest first; the trash lists what the user trashed).
 */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  try {
    const library = readLibrary(auth.account.id);
    return json({
      ...library,
      storage: storageUsage(auth.account.id),
      bytes: libraryBytes(auth.account.id),
      limits: { maxDocBytes: MAX_DOC_BYTES, versionsKept: MAX_VERSIONS, trashDays: TRASH_DAYS },
    });
  } catch (error) {
    return officeError(error);
  }
}

/**
 * POST /api/office/docs { action: "create", format, name?, folderId? } | { action: "upload", name, data, folderId? }
 * -> 201 `{ doc }`; 507 `storage_quota_exceeded` when it does not fit the account's quota.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, Math.ceil((MAX_DOC_BYTES * 4) / 3) + 4096);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(msgf("Bad request: {value}: {message}", { value: parsed.error.issues[0].path.join("/") || "body", message: parsed.error.issues[0].message }), 422);
  const body = parsed.data;
  try {
    const folder = assertFolder(auth.account.id, body.folderId);
    if (body.action === "create") {
      const doc = createDoc(auth.account.id, { name: body.name || "Untitled", format: body.format, bytes: buildDocument(body.format), source: "blank", folderId: folder });
      return json({ doc }, 201);
    }
    const split = splitName(body.name);
    if (!split) return jsonError(msgf("Unsupported file type: {name}. Supported: {value}.", { name: body.name, value: OFFICE_FORMATS.join(", ") }), 415);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) return jsonError("data: expected base64", 422);
    // Refuse before decoding when it cannot fit anyway.
    assertCanStore(auth.account.id, Math.floor((body.data.length * 3) / 4));
    const doc = createDoc(auth.account.id, { name: body.name, format: split.format, bytes: Buffer.from(body.data, "base64"), source: "upload", folderId: folder });
    return json({ doc }, 201);
  } catch (error) {
    return officeError(error);
  }
}
