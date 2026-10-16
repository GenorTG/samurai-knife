import type { SidecarStatus } from "@/lib/services/manager";
import type { OpView } from "@/lib/services/ops";
import type { DocMeta } from "@/lib/office/store";
import type { OfficeFormat } from "@/lib/office/templates";

/**
 * Typed browser helpers for /api/services and /api/office. Same-origin relative URLs and JSON bodies, so every mutating
 * call passes the Origin guard and the JSON-only body rule; errors carry the API's own `error` (and `hint`) text.
 */

/** `canManage` false = public mode, not an administrator: no lifecycle controls, configuration fields are withheld. */
export type ServiceView = SidecarStatus & { op: OpView | null; canManage?: boolean };

/** The API's answer when a non-admin would have to start or install a shared service (src/lib/accounts/authz.ts). */
export function isAdminRequired(error: unknown): boolean {
  return error instanceof ApiError && error.code === "admin_required";
}
export type { DocMeta, OfficeFormat, OpView };

// No TypeScript parameter properties: the assistant's doc_live tools import this file and the unit tests load it through
// Node's type stripping, which rejects them.
export class ApiError extends Error {
  readonly status: number;
  readonly hint?: string;
  readonly code?: string;
  constructor(message: string, status: number, hint?: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.hint = hint;
    this.code = code;
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiError(`Network error: ${errorText(error)}`, 0);
  }
  const raw = await response.text();
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as { error?: unknown; hint?: unknown; code?: unknown };
    throw new ApiError(
      typeof record.error === "string" ? record.error : `Request failed (${response.status}).`,
      response.status,
      typeof record.hint === "string" ? record.hint : undefined,
      typeof record.code === "string" ? record.code : undefined,
    );
  }
  return parsed as T;
}

const q = encodeURIComponent;

/* ------------------------------------------------------------------------------------------- services */

export function getService(id: string, memory = false): Promise<ServiceView> {
  return request<{ service: ServiceView }>("GET", `/api/services/${q(id)}${memory ? "?memory=1" : ""}`).then((r) => r.service);
}

export function listServices(): Promise<ServiceView[]> {
  return request<{ services: ServiceView[] }>("GET", "/api/services").then((r) => r.services);
}

export type ServiceAction =
  | { action: "install"; port?: number; appUrl?: string; publicUrl?: string; idleStopMinutes?: number }
  | { action: "start" | "stop" | "update" }
  | { action: "remove"; purge?: boolean; removeImage?: boolean };

export function serviceAction(id: string, body: ServiceAction): Promise<OpView> {
  return request<{ op: OpView }>("POST", `/api/services/${q(id)}`, body).then((r) => r.op);
}

export function ensureService(id: string): Promise<{ ready: boolean; op?: OpView }> {
  return request<{ ready: boolean; op?: OpView }>("POST", `/api/services/${q(id)}`, { action: "ensure" });
}

export function touchService(id: string): Promise<void> {
  return request<{ ok: boolean }>("POST", `/api/services/${q(id)}`, { action: "touch" }).then(() => undefined);
}

export function configureService(
  id: string,
  options: { port?: number; appUrl?: string | null; publicUrl?: string | null; idleStopMinutes?: number },
): Promise<{ restartNeeded: boolean }> {
  return request<{ restartNeeded: boolean }>("POST", `/api/services/${q(id)}`, { action: "configure", ...options });
}

export function getOp(opId: string): Promise<OpView> {
  return request<{ op: OpView }>("GET", `/api/services/ops/${q(opId)}`).then((r) => r.op);
}

/* --------------------------------------------------------------------------------------------- office */

export function listDocs(): Promise<DocMeta[]> {
  return request<{ docs: DocMeta[] }>("GET", "/api/office/docs").then((r) => r.docs);
}

export function createDoc(format: OfficeFormat, name: string): Promise<DocMeta> {
  return request<{ doc: DocMeta }>("POST", "/api/office/docs", { action: "create", format, name }).then((r) => r.doc);
}

export function uploadDoc(name: string, data: string): Promise<DocMeta> {
  return request<{ doc: DocMeta }>("POST", "/api/office/docs", { action: "upload", name, data }).then((r) => r.doc);
}

export function renameDoc(id: string, name: string): Promise<DocMeta> {
  return request<{ doc: DocMeta }>("POST", `/api/office/docs/${q(id)}`, { action: "rename", name }).then((r) => r.doc);
}

export function deleteDoc(id: string): Promise<boolean> {
  return request<{ removed: boolean }>("DELETE", `/api/office/docs/${q(id)}`).then((r) => r.removed);
}

export function getDoc(id: string): Promise<DocMeta> {
  return request<{ doc: DocMeta }>("GET", `/api/office/docs/${q(id)}`).then((r) => r.doc);
}

/** Save the open editor session now; the new version lands through the Document Server callback a moment later. */
export function forceSaveDoc(id: string): Promise<{ status: "saving" | "unchanged" | "not_open"; doc: DocMeta }> {
  return request("POST", `/api/office/docs/${q(id)}`, { action: "forcesave" });
}

export function docDownloadUrl(id: string): string {
  return `/api/office/docs/${q(id)}?download=1`;
}

export interface EditorSetup {
  apiUrl: string;
  config: Record<string, unknown>;
  /** Live-editing session for the assistant plugin (null when the server did not enable it). */
  live: { token: string; sidecarOrigin: string; guid: string } | null;
}

export function editorConfig(id: string): Promise<EditorSetup> {
  return request<EditorSetup>("GET", `/api/office/docs/${q(id)}/editor?origin=${encodeURIComponent(window.location.origin)}`);
}

/** File -> base64 without data-URL prefix, chunked so big files do not blow the argument limit. */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
