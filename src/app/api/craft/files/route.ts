import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { CraftFileError, listCraftFiles, MAX_CRAFT_FILE_BYTES, saveCraftFile, takeSaveSlot, assertCraftRoom } from "@/lib/craft/files";
import { quotaErrorResponse } from "@/lib/storage/http";
import { storageUsage } from "@/lib/storage/quota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE64_MAX = Math.ceil((MAX_CRAFT_FILE_BYTES * 4) / 3) + 8;
const saveSchema = z.object({
  action: z.literal("save"),
  app: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  name: z.string().min(1).max(400),
  mime: z.string().max(200).optional(),
  data: z.string().max(BASE64_MAX),
}).strict();

function craftError(error: unknown): Response {
  const quota = quotaErrorResponse(error);
  if (quota) return quota;
  if (error instanceof CraftFileError) return jsonError(error.message, error.status);
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
 * POST /api/craft/files { action: "save", app, name, mime?, data (base64) } -> `{ file }` (201 new, 200 replaced): what a
 * Craft app saved, caught by the bridge. 30 saves a minute per account; 507 when it does not fit the quota.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, BASE64_MAX + 4096);
  if ("response" in read) return read.response;
  const parsed = saveSchema.safeParse(read.body);
  if (!parsed.success) return jsonError(`Bad request: ${parsed.error.issues[0].path.join("/") || "body"}: ${parsed.error.issues[0].message}`, 422);
  const body = parsed.data;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) return jsonError("data: expected base64", 422);
  if (!takeSaveSlot(auth.account.id)) return jsonError("Too many saves in a minute; wait a moment.", 429, { retryAfterSec: 60 });
  try {
    assertCraftRoom(auth.account.id, Math.floor((body.data.length * 3) / 4));
    const before = listCraftFiles(auth.account.id).length;
    const file = saveCraftFile(auth.account.id, { app: body.app, name: body.name, mime: body.mime, bytes: Buffer.from(body.data, "base64") });
    return json({ file }, listCraftFiles(auth.account.id).length > before ? 201 : 200);
  } catch (error) {
    return craftError(error);
  }
}
