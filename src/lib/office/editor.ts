import { randomBytes } from "node:crypto";
import { signJwt, verifyJwt, JwtError, bearerToken, type JwtPayload } from "@/lib/jwt-hs256";
import { appUrl, internalUrl, publicUrl } from "@/lib/services/urls";
import { readSecret, readState } from "@/lib/services/state";
import type { Account } from "@/lib/accounts/store";
import { documentTypeOf } from "./templates";
import type { DocMeta } from "./store";
import { LIVE_PLUGIN_GUID, type LivePluginOptions } from "./live-protocol";

/**
 * Document Server (DocsAPI) glue. The browser gets a config signed with the sidecar's JWT secret (it never sees the
 * secret); the config points the Document Server at two app routes that are called by the CONTAINER, not the browser:
 *   GET  /api/office/ds/file?t=<jwt>      document bytes
 *   POST /api/office/ds/callback?t=<jwt>  status/save notifications
 * Those two are the only routes without the Origin/Host guard: they authenticate by JWT instead (the `t` capability
 * token naming account + document + purpose, AND the Document Server's own `Authorization: Bearer` token), both signed
 * with the same per-install secret.
 */

export const OFFICE_SERVICE = "office";
const FILE_TOKEN_TTL_SEC = 24 * 3600;
const CALLBACK_TOKEN_TTL_SEC = 30 * 24 * 3600;

export class OfficeUnavailableError extends Error {}

export function officeSecret(): string {
  const secret = readSecret(OFFICE_SERVICE, "JWT_SECRET");
  if (!secret) throw new OfficeUnavailableError("the office sidecar is not installed");
  return secret;
}

export type DsPurpose = "file" | "callback";

export interface DsCapability {
  acc: string;
  doc: string;
  use: DsPurpose;
}

export function capabilityToken(cap: DsCapability): string {
  return signJwt({ ...cap }, officeSecret(), { expiresInSec: cap.use === "file" ? FILE_TOKEN_TTL_SEC : CALLBACK_TOKEN_TTL_SEC });
}

export function readCapability(token: string | null, use: DsPurpose): DsCapability {
  if (!token) throw new JwtError("missing capability token");
  const claims = verifyJwt(token, officeSecret());
  if (claims.use !== use || typeof claims.acc !== "string" || typeof claims.doc !== "string") throw new JwtError("wrong capability token");
  return { acc: claims.acc, doc: claims.doc, use };
}

/**
 * The Document Server's outgoing token (JWT_ENABLED outbox): `Authorization: Bearer <jwt>` whose claims wrap the request
 * in `payload` (callbacks may also carry it in the body as `token`). Returns the signed claims.
 */
export function readServerToken(request: Request, bodyToken?: unknown): JwtPayload {
  const secret = officeSecret();
  if (typeof bodyToken === "string" && bodyToken) return verifyJwt(bodyToken, secret);
  const header = bearerToken(request.headers.get("authorization"));
  if (!header) throw new JwtError("missing Document Server token");
  const claims = verifyJwt(header, secret);
  const payload = claims.payload;
  return typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as JwtPayload) : claims;
}

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
  const q = (cap: DsCapability) => encodeURIComponent(capabilityToken(cap));
  const sidecarOrigin = new URL(publicUrl(state)).origin;
  // One random token per editor session; it reaches the plugin only through this signed config.
  const live = options.appOrigin ? { token: randomBytes(24).toString("base64url"), sidecarOrigin, guid: LIVE_PLUGIN_GUID } : null;
  const pluginOptions: Record<string, LivePluginOptions> = live && options.appOrigin ? { [LIVE_PLUGIN_GUID]: { token: live.token, appOrigin: options.appOrigin } } : {};
  const base = {
    document: {
      fileType: meta.format,
      key: meta.key,
      title: meta.name,
      url: `${app}/api/office/ds/file?t=${q({ acc: account.id, doc: meta.id, use: "file" })}`,
      permissions: { edit: options.mode === "edit", download: true, print: true, comment: true, review: true },
    },
    documentType: documentTypeOf(meta.format),
    editorConfig: {
      callbackUrl: `${app}/api/office/ds/callback?t=${q({ acc: account.id, doc: meta.id, use: "callback" })}`,
      mode: options.mode,
      lang: options.lang ?? "en",
      user: { id: account.id, name: account.displayName },
      // Macros off: a document's macro runs in the editor origin, the same origin as the assistant plugin.
      customization: { forcesave: true, autosave: true, compactHeader: false, goback: false, uiTheme: "theme-system", plugins: true, macros: false, macrosMode: "disable" },
      plugins: { options: pluginOptions },
    },
  };
  const token = signJwt(base, officeSecret());
  return {
    apiUrl: `${publicUrl(state)}/web-apps/apps/api/documents/api.js`,
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
    throw new OfficeUnavailableError(`the office service did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  const answer = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (answer.error === 0) return { status: "saving" };
  if (answer.error === 4) return { status: "unchanged" };
  if (answer.error === 1) return { status: "not_open" };
  throw new OfficeUnavailableError(`the office service refused the save (command service error ${String(answer.error)})`);
}
