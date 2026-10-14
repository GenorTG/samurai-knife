import { authenticate, json, jsonError } from "@/lib/accounts/http";
import { editorConfig } from "@/lib/office/editor";
import { appOriginFor } from "@/lib/office/live-protocol";
import { officeError } from "@/lib/office/http";
import { getDoc } from "@/lib/office/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/office/docs/<id>/editor[?mode=view][&origin=<page origin>] -> `{ apiUrl, config, live }`: the DocsAPI script URL
 * on the sidecar and the editor config signed server-side (the secret never reaches the browser). With `origin` (it must
 * name the host this request came to) the config also carries the live-editing plugin options and `live` the session
 * token. 409 `sidecar_not_installed` without the sidecar.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  const params = new URL(request.url).searchParams;
  const mode = params.get("mode") === "view" ? "view" : "edit";
  const claimed = params.get("origin");
  const appOrigin = appOriginFor(claimed, request.headers.get("host"));
  if (claimed && !appOrigin) return jsonError("origin must be this page's origin (scheme://host:port of the request)", 400);
  try {
    return json(editorConfig(auth.account, getDoc(auth.account.id, id), { mode, appOrigin }));
  } catch (error) {
    return officeError(error);
  }
}
