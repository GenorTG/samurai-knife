import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { isPublicMode } from "@/lib/accounts/mode";
import { dataDir } from "@/lib/accounts/store";
import { CraftFileError, listCraftFiles, MAX_CRAFT_FILE_BYTES, saveCraftFile, takeSaveSlot, assertCraftRoom } from "@/lib/craft/files";
import { quotaErrorResponse } from "@/lib/storage/http";
import { storageUsage } from "@/lib/storage/quota";
import { isUploadBudgetError, reserveUpload, type UploadReservation } from "@/lib/upload-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE64_MAX = Math.ceil((MAX_CRAFT_FILE_BYTES * 4) / 3) + 8;
const BODY_MAX = BASE64_MAX + 4096;
const saveSchema = z.object({
  action: z.literal("save"),
  app: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  name: z.string().min(1).max(400),
  mime: z.string().max(200).optional(),
  data: z.string().max(BASE64_MAX),
  // false: refuse (409 file_exists) instead of replacing the same app + name (an agent's craft_file_save)
  replace: z.boolean().optional(),
}).strict();

function craftError(error: unknown): Response {
  const quota = quotaErrorResponse(error);
  if (quota) return quota;
  if (error instanceof CraftFileError) return jsonError(error.message, error.status, error.code ? { code: error.code } : undefined);
  throw error;
}

/** GET /api/craft/files -> `{ files, usage, maxFileBytes }`: the account's Craft files, newest first. docs/SIDECARS.md "Craft files". */
export function GET(request: Request): Response {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  try {
    return json({ files: listCraftFiles(auth.account.id), usage: storageUsage(auth.account.id), maxFileBytes: MAX_CRAFT_FILE_BYTES });
  } catch (error) {
    return craftError(error);
  }
}

/**
 * POST /api/craft/files { action: "save", app, name, mime?, data (base64), replace? } -> `{ file }` (201 new, 200
 * replaced): what a Craft app saved, caught by the bridge, or a file of the assistant's chain (craft_file_save, which
 * sends replace:false unless asked to overwrite: 409 `file_exists`). The body (up to ~67 MB of JSON, held in memory)
 * takes an upload slot first (upload-budget.ts: per account, server-wide, in-flight bytes, the data disk's floor);
 * 30 saves a minute per account; 507 when it does not fit the quota.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const length = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  let reservation: UploadReservation;
  try {
    reservation = reserveUpload({ owner: auth.account.id, declaredBytes: Number.isFinite(length) && length >= 0 ? length : null, maxBytes: BODY_MAX, privileged: isPublicMode() && auth.account.role === "admin", dir: dataDir() });
  } catch (error) {
    if (isUploadBudgetError(error)) {
      const refused = jsonError(error.message, error.status, { retryAfterSec: error.retryAfterSec });
      refused.headers.set("Retry-After", String(error.retryAfterSec));
      return refused;
    }
    throw error;
  }
  try {
    return await save(auth.account.id, request, reservation.bytes);
  } finally {
    reservation.release();
  }
}

async function save(accountId: string, request: Request, maxBytes: number): Promise<Response> {
  const read = await readJsonBody(request, maxBytes);
  if ("response" in read) return read.response;
  const parsed = saveSchema.safeParse(read.body);
  if (!parsed.success) return jsonError(`Bad request: ${parsed.error.issues[0].path.join("/") || "body"}: ${parsed.error.issues[0].message}`, 422);
  const body = parsed.data;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) return jsonError("data: expected base64", 422);
  if (!takeSaveSlot(accountId)) return jsonError("Too many saves in a minute; wait a moment.", 429, { retryAfterSec: 60 });
  try {
    assertCraftRoom(accountId, Math.floor((body.data.length * 3) / 4));
    const before = listCraftFiles(accountId).length;
    const file = saveCraftFile(accountId, { app: body.app, name: body.name, mime: body.mime, bytes: Buffer.from(body.data, "base64"), replace: body.replace });
    return json({ file }, listCraftFiles(accountId).length > before ? 201 : 200);
  } catch (error) {
    return craftError(error);
  }
}
