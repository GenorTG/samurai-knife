import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { attachment, officeError } from "@/lib/office/http";
import { getDoc, readVersionBytes } from "@/lib/office/store";
import { MIME } from "@/lib/office/templates";
import { extractOfficeText } from "@/lib/office/extract";
import { queueFullOrNull } from "@/lib/queue-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREVIEW_CHARS = 20_000;

/**
 * GET /api/office/docs/<id>/versions/<n> -> `{ version, text, truncated }` (a plain-text preview, the same extraction as
 * knife_doc_read); `?download=1` -> that version's file as an attachment ("<name> (v<n>).<fmt>").
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string; version: string }> }): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const { id, version } = await ctx.params;
  const n = Number(version);
  if (!Number.isInteger(n) || n < 1) return jsonError("unknown version", 404);
  try {
    const doc = getDoc(auth.account.id, id);
    const { version: found, bytes } = readVersionBytes(auth.account.id, doc, n);
    if (new URL(request.url).searchParams.get("download") === "1") {
      const name = `${doc.name.replace(/\.[A-Za-z0-9]+$/, "")} (v${found.version}).${found.format}`;
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": MIME[found.format],
          "Content-Disposition": attachment(name),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    let preview: { text: string; truncated: boolean };
    try {
      preview = await extractOfficeText(found.format, bytes, { maxChars: PREVIEW_CHARS, owner: auth.account.id, signal: request.signal });
    } catch (error) {
      const full = queueFullOrNull(error);
      if (full) return full;
      preview = { text: "", truncated: false }; // unreadable file, or stopped by the isolate limits: no preview
    }
    return json({ version: found, text: preview.text, truncated: preview.truncated });
  } catch (error) {
    return officeError(error);
  }
}
