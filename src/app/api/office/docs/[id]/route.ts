import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { forceSave } from "@/lib/office/editor";
import { assertFolder, restoreDoc } from "@/lib/office/folders";
import { attachment, officeError } from "@/lib/office/http";
import {
  deleteDoc,
  docDiskBytes,
  duplicateDoc,
  getDoc,
  getLiveDoc,
  listVersions,
  MAX_VERSIONS,
  moveDoc,
  pruneVersions,
  readDocBytes,
  renameDoc,
  restoreVersion,
  trashDoc,
} from "@/lib/office/store";
import { MIME } from "@/lib/office/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const folderId = z.string().regex(/^[a-f0-9]{16}$/).nullable();

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("rename"), name: z.string().min(1).max(200) }).strict(),
  /** Save the open editor session now (Document Server command service); the new version arrives via the callback. */
  z.object({ action: z.literal("forcesave") }).strict(),
  z.object({ action: z.literal("move"), folderId }).strict(),
  z.object({ action: z.literal("duplicate"), folderId: folderId.optional() }).strict(),
  z.object({ action: z.literal("trash") }).strict(),
  z.object({ action: z.literal("restore") }).strict(),
  z.object({ action: z.literal("restore_version"), version: z.number().int().min(1) }).strict(),
  z.object({ action: z.literal("prune_versions"), keep: z.number().int().min(0).max(MAX_VERSIONS) }).strict(),
]);

/**
 * GET /api/office/docs/<id> -> `{ doc, versions, diskBytes }` (versions = the kept earlier versions, oldest first);
 * `?download=1` -> the current file as an attachment.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  try {
    const doc = getDoc(auth.account.id, id);
    if (new URL(request.url).searchParams.get("download") !== "1") {
      return json({ doc, versions: listVersions(auth.account.id, doc), diskBytes: docDiskBytes(auth.account.id, doc) });
    }
    const bytes = readDocBytes(auth.account.id, doc);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": MIME[doc.format],
        "Content-Disposition": attachment(doc.name),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return officeError(error);
  }
}

/**
 * POST /api/office/docs/<id> { action, … }:
 *   rename {name} | move {folderId|null} | duplicate {folderId?} -> 201 | trash | restore -> `{ doc }`
 *   restore_version {version} -> `{ doc }` (the old bytes become a NEW version; nothing is lost)
 *   prune_versions {keep} -> `{ doc, removed, freedBytes }`
 *   forcesave -> `{ status: "saving" | "unchanged" | "not_open", doc }` (poll the doc for the new version)
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  const read = await readJsonBody(request, 4096);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(`Bad request: ${parsed.error.issues[0].message}`, 422);
  const acc = auth.account.id;
  const body = parsed.data;
  try {
    switch (body.action) {
      case "forcesave": {
        const doc = getLiveDoc(acc, id);
        return json({ ...(await forceSave(doc)), doc });
      }
      case "rename":
        return json({ doc: renameDoc(acc, id, body.name) });
      case "move":
        getLiveDoc(acc, id);
        return json({ doc: moveDoc(acc, id, assertFolder(acc, body.folderId)) });
      case "duplicate":
        getLiveDoc(acc, id);
        return json({ doc: duplicateDoc(acc, id, body.folderId === undefined ? undefined : assertFolder(acc, body.folderId)) }, 201);
      case "trash":
        return json({ doc: trashDoc(acc, id) });
      case "restore":
        return json({ doc: restoreDoc(acc, id) });
      case "restore_version":
        return json({ doc: restoreVersion(acc, id, body.version, auth.account.displayName) });
      case "prune_versions":
        return json(pruneVersions(acc, id, body.keep));
    }
  } catch (error) {
    return officeError(error);
  }
}

/**
 * DELETE /api/office/docs/<id> -> `{ removed, trashed: true, doc }`: into the trash (restorable for 30 days).
 * `?permanent=1` -> `{ removed }`: the document and every kept version, for good.
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  try {
    getDoc(auth.account.id, id);
    if (new URL(request.url).searchParams.get("permanent") === "1") return json({ removed: deleteDoc(auth.account.id, id) });
    return json({ removed: true, trashed: true, doc: trashDoc(auth.account.id, id) });
  } catch (error) {
    return officeError(error);
  }
}
