import { JwtError } from "@/lib/jwt-hs256";
import { jsonError } from "@/lib/accounts/http";
import { authorizeDsRequest, OfficeUnavailableError } from "@/lib/office/ds-auth";
import { DocError, getDoc, readDocBytes } from "@/lib/office/store";
import { MIME } from "@/lib/office/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/office/ds/file?t=<capability jwt> — called by the Document Server CONTAINER, never the browser.
 * Exception to the Origin/Host guard (documented in docs/SIDECARS.md): the container's Host header is the
 * app URL it was given (maybe host.docker.internal) and it sends no Origin. Authenticated by JWT twice: the `t` token
 * (account + document + purpose, signed by this app; the account must still be usable) and the server's own
 * `Authorization: Bearer` token (src/lib/office/ds-auth.ts).
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const { cap } = authorizeDsRequest(request, "file");
    const meta = getDoc(cap.acc, cap.doc);
    const bytes = readDocBytes(cap.acc, meta);
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": MIME[meta.format], "Content-Length": String(bytes.length), "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof JwtError) return jsonError(`forbidden: ${error.message}`, 403);
    if (error instanceof OfficeUnavailableError) return jsonError(error.message, 409);
    if (error instanceof DocError) return jsonError(error.message, error.status);
    throw error;
  }
}
