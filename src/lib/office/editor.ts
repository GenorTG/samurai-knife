import { msgf } from "@/lib/i18n/msg";
import { randomBytes } from "node:crypto";
import { signJwt } from "@/lib/jwt-hs256";
import { appUrl, internalUrl, publicUrl } from "@/lib/services/urls";
import { readState } from "@/lib/services/state";
import type { Account } from "@/lib/accounts/store";
import { documentTypeOf } from "./templates";
import type { DocMeta } from "./store";
import { LIVE_PLUGIN_GUID, type LivePluginOptions } from "./live-protocol";
import { proxiedApiUrl } from "./proxy";
import { capabilityToken, editorConfigToken, OFFICE_SERVICE, OfficeUnavailableError, officeSecret, type DsPurpose } from "./ds-auth";

/**
 * Document Server (DocsAPI) glue. The browser gets a config signed with the sidecar's JWT secret (it never sees the
 * secret); the config points the Document Server at two app routes that are called by the CONTAINER, not the browser:
 *   GET  /api/office/ds/file?t=<jwt>      document bytes
 *   POST /api/office/ds/callback?t=<jwt>  status/save notifications
 * Those two are the only routes without the Origin/Host guard: they authenticate by JWT instead (the `t` capability
 * token naming account + document + purpose, AND the Document Server's own token). Every token kind and its key is
 * owned by ds-auth.ts.
 */

export {
  OFFICE_SERVICE,
  OfficeUnavailableError,
  officeSecret,
  capabilityToken,
  readCapability,
  readServerToken,
  type DsCapability,
  type DsPurpose,
} from "./ds-auth";

export interface EditorConfig {
  /** Where the browser loads DocsAPI from. */
  apiUrl: string;
  config: Record<string, unknown>;
  /**
   * Live editing channel for the assistant (docs/SIDECARS.md "Live editing plugin"): the per-session token the plugin
   * presents, the origin its hello comes from, and the plugin guid. Null when the page did not name its origin.
   */
  live: { token: string; sidecarOrigin: string; guid: string } | null;
}

export function editorConfig(
  account: Account,
  meta: DocMeta,
  options: { mode: "edit" | "view"; lang?: string; appOrigin?: string | null },
): EditorConfig {
  const state = readState(OFFICE_SERVICE);
  if (!state) throw new OfficeUnavailableError("the office sidecar is not installed");
  const app = appUrl(state).url;
  const q = (use: DsPurpose) => encodeURIComponent(capabilityToken(account, meta.id, use));
  const sidecarOrigin = new URL(publicUrl(state)).origin;
  // One random token per editor session; it reaches the plugin only through this signed config.
  const live = options.appOrigin ? { token: randomBytes(24).toString("base64url"), sidecarOrigin, guid: LIVE_PLUGIN_GUID } : null;
  const pluginOptions: Record<string, LivePluginOptions> = live && options.appOrigin ? { [LIVE_PLUGIN_GUID]: { token: live.token, appOrigin: options.appOrigin } } : {};
  const base = {
    document: {
      fileType: meta.format,
      key: meta.key,
      title: meta.name,
      url: `${app}/api/office/ds/file?t=${q("file")}`,
      permissions: { edit: options.mode === "edit", download: true, print: true, comment: true, review: true },
    },
    documentType: documentTypeOf(meta.format),
    editorConfig: {
      callbackUrl: `${app}/api/office/ds/callback?t=${q("callback")}`,
      mode: options.mode,
      lang: options.lang ?? "en",
      user: { id: account.id, name: account.displayName },
      // Macros off: a document's macro runs in the editor origin, the same origin as the assistant plugin.
      customization: { forcesave: true, autosave: true, compactHeader: false, goback: false, uiTheme: "theme-system", plugins: true, macros: false, macrosMode: "disable" },
      plugins: { options: pluginOptions },
    },
  };
  const token = editorConfigToken(base);
  return {
    apiUrl: proxiedApiUrl(account.id) ?? `${publicUrl(state)}/web-apps/apps/api/documents/api.js`,
    config: { ...base, token, width: "100%", height: "100%", type: "desktop" },
    live,
  };
}

export type ForceSaveResult = { status: "saving" } | { status: "unchanged" } | { status: "not_open" };

/**
 * Asks the Document Server to save the open session NOW (command service `forcesave`, the documented server API): it
 * answers at once and then calls back with status 6, which stores a new version (callback.ts). Error 4 = nothing changed
 * since the last save; 1 = no open session with this key.
 */
export async function forceSave(meta: DocMeta): Promise<ForceSaveResult> {
  const state = readState(OFFICE_SERVICE);
  if (!state) throw new OfficeUnavailableError("the office sidecar is not installed");
  const body = { c: "forcesave", key: meta.key };
  const secret = officeSecret();
  let response: Response;
  try {
    response = await fetch(`${internalUrl(state)}/coauthoring/CommandService.ashx`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${signJwt({ payload: body }, secret, { expiresInSec: 300 })}` },
      body: JSON.stringify({ ...body, token: signJwt(body, secret, { expiresInSec: 300 }) }),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch (error) {
    throw new OfficeUnavailableError(msgf("the office service did not answer: {value}", { value: error instanceof Error ? error.message : String(error) }));
  }
  const answer = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (answer.error === 0) return { status: "saving" };
  if (answer.error === 4) return { status: "unchanged" };
  if (answer.error === 1) return { status: "not_open" };
  throw new OfficeUnavailableError(msgf("the office service refused the save (command service error {value})", { value: String(answer.error) }));
}
