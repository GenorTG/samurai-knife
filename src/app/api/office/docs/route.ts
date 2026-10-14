import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { officeError } from "@/lib/office/http";
import { createDoc, listDocs, MAX_DOC_BYTES, splitName } from "@/lib/office/store";
import { buildDocument, OFFICE_FORMATS } from "@/lib/office/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), format: z.enum(OFFICE_FORMATS), name: z.string().max(200).optional() }).strict(),
  z.object({
    action: z.literal("upload"),
    name: z.string().min(1).max(200),
    /** Base64 file bytes (the browser reads the picked file; JSON only, like every mutating route). */
    data: z.string().max(Math.ceil((MAX_DOC_BYTES * 4) / 3) + 8),
  }).strict(),
]);

/** GET /api/office/docs -> `{ docs: DocMeta[] }`, newest first. */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  try {
    return json({ docs: listDocs(auth.account.id) });
  } catch (error) {
    return officeError(error);
  }
}

/** POST /api/office/docs { action: "create", format, name? } | { action: "upload", name, data } -> 201 `{ doc }`. */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, Math.ceil((MAX_DOC_BYTES * 4) / 3) + 4096);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(`Bad request: ${parsed.error.issues[0].path.join("/") || "body"}: ${parsed.error.issues[0].message}`, 422);
  const body = parsed.data;
  try {
    if (body.action === "create") {
      const doc = createDoc(auth.account.id, { name: body.name || "Untitled", format: body.format, bytes: buildDocument(body.format), source: "blank" });
      return json({ doc }, 201);
    }
    const split = splitName(body.name);
    if (!split) return jsonError(`Unsupported file type: ${body.name}. Supported: ${OFFICE_FORMATS.join(", ")}.`, 415);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) return jsonError("data: expected base64", 422);
    const doc = createDoc(auth.account.id, { name: body.name, format: split.format, bytes: Buffer.from(body.data, "base64"), source: "upload" });
    return json({ doc }, 201);
  } catch (error) {
    return officeError(error);
  }
}
