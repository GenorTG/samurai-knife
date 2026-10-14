import * as z from "zod/v4";
import { authenticate, json, jsonError, readJsonBody } from "@/lib/accounts/http";
import { forceSave } from "@/lib/office/editor";
import { attachment, officeError } from "@/lib/office/http";
import { deleteDoc, getDoc, readDocBytes, renameDoc } from "@/lib/office/store";
import { MIME } from "@/lib/office/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("rename"), name: z.string().min(1).max(200) }).strict(),
  /** Save the open editor session now (Document Server command service); the new version arrives via the callback. */
  z.object({ action: z.literal("forcesave") }).strict(),
]);

/** GET /api/office/docs/<id> -> `{ doc }`; `?download=1` -> the file as an attachment. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  try {
    const doc = getDoc(auth.account.id, id);
    if (new URL(request.url).searchParams.get("download") !== "1") return json({ doc });
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
 * POST /api/office/docs/<id> { action: "rename", name } -> `{ doc }`;
 * { action: "forcesave" } -> `{ status: "saving" | "unchanged" | "not_open", doc }` (poll the doc for the new version).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  const read = await readJsonBody(request, 4096);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) return jsonError(`Bad request: ${parsed.error.issues[0].message}`, 422);
  try {
    if (parsed.data.action === "forcesave") {
      const doc = getDoc(auth.account.id, id);
      return json({ ...(await forceSave(doc)), doc });
    }
    return json({ doc: renameDoc(auth.account.id, id, parsed.data.name) });
  } catch (error) {
    return officeError(error);
  }
}

/** DELETE /api/office/docs/<id> -> `{ removed }` (the document and its kept versions). */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  try {
    getDoc(auth.account.id, id);
    return json({ removed: deleteDoc(auth.account.id, id) });
  } catch (error) {
    return officeError(error);
  }
}
