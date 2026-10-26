import { msgf } from "@/lib/i18n/msg";
import { authenticate } from "@/lib/accounts/http";
import { finishAuthorization } from "@/lib/workflows/server/oauth";
import { WorkflowStoreError } from "@/lib/workflows/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const escape = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(ok: boolean, message: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><title>${ok ? "Connected" : "Not connected"}</title>
<body style="font:15px system-ui;margin:3rem auto;max-width:32rem;padding:0 1rem">
<h1 style="font-size:1.2rem">${ok ? "Connected" : "Not connected"}</h1><p>${escape(message)}</p>
<p><a href="/tools/workflows?tab=credentials">Back to credentials</a></p>
<script>try{window.opener&&window.opener.postMessage({type:"knife-oauth",ok:${ok ? "true" : "false"}},location.origin);if(${ok ? "true" : "false"})setTimeout(function(){window.close()},800)}catch(e){}</script></body>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** GET /api/workflows/oauth/callback?code&state: the provider sends the browser back here; the token is stored. */
export async function GET(request: Request): Promise<Response> {
  const auth = authenticate(request, false);
  if ("response" in auth) return page(false, "Sign in to Smart Knife in this browser, then press Connect again.");
  const params = new URL(request.url).searchParams;
  const error = params.get("error");
  if (error) return page(false, `The provider answered: ${(params.get("error_description") ?? error).slice(0, 200)}`);
  const code = params.get("code") ?? "";
  const state = params.get("state") ?? "";
  if (!code || !state) return page(false, "The provider did not send a code.");
  try {
    const name = await finishAuthorization(auth.account.id, state, code);
    return page(true, msgf("\"{name}\" is connected. You can close this window.", { name }));
  } catch (caught) {
    if (caught instanceof WorkflowStoreError) return page(false, caught.message);
    return page(false, "The token exchange failed. Check the client secret and the token URL.");
  }
}
