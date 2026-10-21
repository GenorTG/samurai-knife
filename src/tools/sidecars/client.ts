import type { SidecarStatus } from "@/lib/services/manager";
import type { OpView } from "@/lib/services/ops";
import type { DocMeta, DocVersion } from "@/lib/office/store";
import type { Folder } from "@/lib/office/folders";
import type { StorageUsage } from "@/lib/storage/quota";
import type { OfficeFormat } from "@/lib/office/templates";
import type { CraftFile } from "@/lib/craft/files";
import type { CraftLaunch } from "@/lib/craft/launch";
import type { AppNotices } from "@/lib/craft/notices";
import type { CraftUpdatesView } from "@/lib/craft/updates";

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
export type { DocMeta, DocVersion, Folder, OfficeFormat, OpView, StorageUsage };

/** The API's answer when the account's storage quota is full (src/lib/storage/quota.ts). */
export function isQuotaFull(error: unknown): boolean {
  return error instanceof ApiError && error.code === "storage_quota_exceeded";
}

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
  | { action: "install"; port?: number; appUrl?: string; publicUrl?: string; idleStopMinutes?: number; autostart?: boolean }
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
  options: { port?: number; appUrl?: string | null; publicUrl?: string | null; idleStopMinutes?: number; autostart?: boolean },
): Promise<{ restartNeeded: boolean }> {
  return request<{ restartNeeded: boolean }>("POST", `/api/services/${q(id)}`, { action: "configure", ...options });
}

export function getOp(opId: string): Promise<OpView> {
  return request<{ op: OpView }>("GET", `/api/services/ops/${q(opId)}`).then((r) => r.op);
}

/* --------------------------------------------------------------------------------------------- office */

export interface OfficeLibrary {
  docs: DocMeta[];
  folders: Folder[];
  trash: { docs: DocMeta[]; folders: Folder[] };
  storage: StorageUsage;
  bytes: { files: number; versions: number; trash: number };
  limits: { maxDocBytes: number; versionsKept: number; trashDays: number };
}

export function getLibrary(): Promise<OfficeLibrary> {
  return request<OfficeLibrary>("GET", "/api/office/docs");
}

export function listDocs(): Promise<DocMeta[]> {
  return getLibrary().then((r) => r.docs);
}

export function createDoc(format: OfficeFormat, name: string, folderId: string | null = null): Promise<DocMeta> {
  return request<{ doc: DocMeta }>("POST", "/api/office/docs", { action: "create", format, name, folderId }).then((r) => r.doc);
}

export function uploadDoc(name: string, data: string, folderId: string | null = null): Promise<DocMeta> {
  return request<{ doc: DocMeta }>("POST", "/api/office/docs", { action: "upload", name, data, folderId }).then((r) => r.doc);
}

export type DocAction =
  | { action: "move"; folderId: string | null }
  | { action: "duplicate"; folderId?: string | null }
  | { action: "trash" }
  | { action: "restore" }
  | { action: "restore_version"; version: number }
  | { action: "prune_versions"; keep: number };

export function docAction(id: string, body: DocAction): Promise<{ doc: DocMeta; removed?: number; freedBytes?: number }> {
  return request("POST", `/api/office/docs/${q(id)}`, body);
}

export function getDocDetails(id: string): Promise<{ doc: DocMeta; versions: DocVersion[]; diskBytes: number }> {
  return request("GET", `/api/office/docs/${q(id)}`);
}

export function deleteDocForever(id: string): Promise<boolean> {
  return request<{ removed: boolean }>("DELETE", `/api/office/docs/${q(id)}?permanent=1`).then((r) => r.removed);
}

export function versionPreview(id: string, version: number): Promise<{ version: DocVersion; text: string; truncated: boolean }> {
  return request("GET", `/api/office/docs/${q(id)}/versions/${version}`);
}

export function versionDownloadUrl(id: string, version: number): string {
  return `/api/office/docs/${q(id)}/versions/${version}?download=1`;
}

export function createFolder(name: string, parentId: string | null): Promise<Folder> {
  return request<{ folder: Folder }>("POST", "/api/office/folders", { name, parentId }).then((r) => r.folder);
}

export type FolderAction = { action: "rename"; name: string } | { action: "move"; parentId: string | null } | { action: "trash" } | { action: "restore" };

export function folderAction(id: string, body: FolderAction): Promise<{ folder: Folder; docs?: number }> {
  return request("POST", `/api/office/folders/${q(id)}`, body);
}

export function deleteFolderForever(id: string): Promise<{ docs: number; freedBytes: number }> {
  return request("DELETE", `/api/office/folders/${q(id)}`);
}

export function emptyTrash(): Promise<{ docs: number; folders: number; freedBytes: number }> {
  return request("POST", "/api/office/trash", { action: "empty" });
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

/* ------------------------------------------------------------------------------------------- Craft apps */

export type { AppNotices, CraftLaunch };

export type { CraftUpdatesView };

/** The Craft apps update channel (admins). */
export function getCraftUpdates(): Promise<CraftUpdatesView> {
  return request<CraftUpdatesView>("GET", "/api/craft/updates");
}

export type CraftUpdateAction =
  | { action: "check"; apply?: boolean }
  | { action: "apply" | "rollback"; app: string }
  | { action: "hold"; app: string; hold: boolean }
  | { action: "mode"; mode: "auto" | "notify" | "off" };

export function postCraftUpdates(body: CraftUpdateAction): Promise<CraftUpdatesView | { started: boolean; view: CraftUpdatesView }> {
  return request("POST", "/api/craft/updates", body);
}

export type { CraftFile };

export interface CraftFilesList {
  files: CraftFile[];
  usage: { usedBytes: number; quotaBytes: number | null };
  maxFileBytes: number;
}

export function listCraftFiles(): Promise<CraftFilesList> {
  return request<CraftFilesList>("GET", "/api/craft/files");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Stores what an app saved (POST /api/craft/files); same app + name replaces the file. */
export function saveCraftFile(app: string, name: string, mime: string, bytes: ArrayBuffer): Promise<{ file: CraftFile }> {
  return request<{ file: CraftFile }>("POST", "/api/craft/files", { action: "save", app, name, mime, data: bytesToBase64(new Uint8Array(bytes)) });
}

export function deleteCraftFile(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>("DELETE", `/api/craft/files/${encodeURIComponent(id)}`);
}

/** The file's bytes and its real type (the response itself is always application/octet-stream). */
export async function craftFileBytes(id: string): Promise<{ bytes: ArrayBuffer; mime: string }> {
  const response = await fetch(`/api/craft/files/${encodeURIComponent(id)}`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    await response.text();
    throw new ApiError(`Could not read the file (${response.status}).`, response.status);
  }
  return { bytes: await response.arrayBuffer(), mime: response.headers.get("x-craft-type") ?? "" };
}

export function craftFileDownloadUrl(id: string): string {
  return `/api/craft/files/${encodeURIComponent(id)}`;
}

/** Licence and notice texts of the Craft app version this install serves. */
export function getCraftNotices(app: string): Promise<AppNotices> {
  return request<AppNotices>("GET", `/api/craft/notices?app=${encodeURIComponent(app)}`);
}

/** Where each Craft app loads from (with a proxy ticket in public mode); 409 not_installed without the sidecar. */
export function getCraftLaunch(): Promise<CraftLaunch> {
  return request<CraftLaunch>("GET", "/api/craft");
}
