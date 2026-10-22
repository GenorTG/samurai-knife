import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { CraftFileError, deleteCraftFile, readCraftFile } from "@/lib/craft/files";
import { attachment } from "@/lib/office/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/craft/files/<id> -> the file's bytes, always `application/octet-stream` as an attachment (it is user content
 * from a third-party app: never rendered on this origin). The real type is in `X-Craft-Type` for the chooser.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  try {
    const { file, bytes } = readCraftFile(auth.account.id, id);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": attachment(file.name),
        "Content-Length": String(bytes.byteLength),
        "X-Craft-Type": file.mime,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        // Applied by scripts/security-headers.mjs in production (which keeps the app's CSP otherwise).
        "X-Knife-Csp": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    if (error instanceof CraftFileError) return jsonError(error.message, error.status);
    throw error;
  }
}

/** DELETE /api/craft/files/<id> -> `{ ok: true }`. */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  try {
    deleteCraftFile(auth.account.id, id);
    return json({ ok: true });
  } catch (error) {
    if (error instanceof CraftFileError) return jsonError(error.message, error.status);
    throw error;
  }
}
