import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { deleteFolderForever, moveFolder, renameFolder, restoreFolder, trashFolder } from "@/lib/office/folders";
import { officeError } from "@/lib/office/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("rename"), name: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal("move"), parentId: z.string().regex(/^[a-f0-9]{16}$/).nullable() }).strict(),
  z.object({ action: z.literal("trash") }).strict(),
  z.object({ action: z.literal("restore") }).strict(),
]);

/**
 * POST /api/office/folders/<id> { action: rename {name} | move {parentId|null} | trash | restore } -> `{ folder }`
 * (trash also returns `docs`, how many documents went with it).
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
      case "rename":
        return json({ folder: renameFolder(acc, id, body.name) });
      case "move":
        return json({ folder: moveFolder(acc, id, body.parentId) });
      case "trash":
        return json(trashFolder(acc, id));
      case "restore":
        return json({ folder: restoreFolder(acc, id) });
    }
  } catch (error) {
    return officeError(error);
  }
}

/** DELETE /api/office/folders/<id> -> `{ docs, freedBytes }`: a folder in the trash, with everything trashed with it, for good. */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  try {
    return json(deleteFolderForever(auth.account.id, id));
  } catch (error) {
    return officeError(error);
  }
}
