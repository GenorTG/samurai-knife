import { findSidecar } from "@/lib/services/definitions";
import { markSession } from "@/lib/services/manager";
import { readState } from "@/lib/services/state";
import { internalUrl, publicUrl } from "@/lib/services/urls";
import { OFFICE_SERVICE } from "./editor";
import { QuotaExceededError } from "@/lib/storage/quota";
import { createDoc, getDoc, isOfficeFormat, MAX_DOC_BYTES, noteSaveError, rotateKey, saveVersion, type DocMeta } from "./store";

/**
 * Document Server save callback ("track"), statuses as documented by the DocsAPI:
 *   1 editing (users connected/disconnected)  2 ready to save (all closed)  3 save error  4 closed, no changes
 *   6 force-save (Save button / autosave tick)  7 force-save error
 * Saves on 2 and 6. Answer `{error: 0}` = handled; anything else makes the editor warn the user.
 */

export interface CallbackBody {
  key?: unknown;
  status?: unknown;
  url?: unknown;
  filetype?: unknown;
  users?: unknown;
  forcesavetype?: unknown;
}

export interface CallbackOutcome {
  error: 0 | 1;
  /** What happened, for the server log and tests. */
  action: "editing" | "saved" | "force-saved" | "closed" | "conflict-copy" | "ignored" | "failed";
  doc?: DocMeta;
  message?: string;
}

/** Only URLs on the sidecar itself may be downloaded (no SSRF through a forged callback). */
function allowedOrigins(): Set<string> {
  const state = readState(OFFICE_SERVICE);
  if (!state) return new Set();
  return new Set([new URL(publicUrl(state)).origin, new URL(internalUrl(state)).origin]);
}

async function download(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (!allowedOrigins().has(parsed.origin)) throw new Error(`refusing to download from ${parsed.origin}: not the office sidecar`);
  // The browser-facing origin may not be reachable from here (a custom public URL): fetch through the internal one.
  const state = readState(OFFICE_SERVICE);
  const target = state ? new URL(parsed.pathname + parsed.search, internalUrl(state)) : parsed;
  const response = await fetch(target, { signal: AbortSignal.timeout(60_000), redirect: "error" });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_DOC_BYTES) throw new Error("saved document exceeds the size limit");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_DOC_BYTES) throw new Error("saved document exceeds the size limit");
  return bytes;
}

function savedBy(users: unknown): string | undefined {
  return Array.isArray(users) && typeof users[0] === "string" ? users[0] : undefined;
}

export async function handleCallback(accountId: string, docId: string, body: CallbackBody): Promise<CallbackOutcome> {
  const status = typeof body.status === "number" ? body.status : Number.NaN;
  const key = typeof body.key === "string" ? body.key : "";
  const meta = getDoc(accountId, docId);
  if (!findSidecar(OFFICE_SERVICE)) return { error: 1, action: "failed", message: "no office definition" };

  if (status === 1) {
    markSession(OFFICE_SERVICE, key, Array.isArray(body.users) && body.users.length > 0);
    return { error: 0, action: "editing" };
  }
  if (status === 4) {
    markSession(OFFICE_SERVICE, key, false);
    // Force-saves during the session changed the bytes under the same key; give the next session a new one.
    const doc = rotateKey(accountId, docId, key) ?? undefined;
    return { error: 0, action: "closed", doc };
  }
  if (status === 3 || status === 7) {
    markSession(OFFICE_SERVICE, key, status === 7);
    return { error: 0, action: "ignored", message: `Document Server reported a save error (status ${status})` };
  }
  if (status !== 2 && status !== 6) return { error: 0, action: "ignored", message: `status ${String(body.status)}` };

  if (typeof body.url !== "string" || !body.url) return { error: 1, action: "failed", message: "save callback without url" };
  try {
    const bytes = await download(body.url);
    const reported = typeof body.filetype === "string" ? body.filetype.toLowerCase() : meta.format;
    const format = isOfficeFormat(reported) ? reported : meta.format;
    if (key && key !== meta.key) {
      // The document changed under the session (replaced meanwhile): keep both instead of overwriting either.
      const copy = createDoc(accountId, { name: `${meta.name.replace(/\.[A-Za-z0-9]+$/, "")} (edited copy)`, format, bytes, source: "upload", versionSource: "editor", folderId: meta.folderId });
      if (status === 2) markSession(OFFICE_SERVICE, key, false);
      return { error: 0, action: "conflict-copy", doc: copy };
    }
    // Every editor save is a version; over the quota, this document's oldest versions make room first (store.ts).
    const doc = saveVersion(accountId, docId, bytes, { rotateKey: status === 2, savedBy: savedBy(body.users), format, source: "editor", makeRoom: true });
    if (status === 2) markSession(OFFICE_SERVICE, key, false);
    return { error: 0, action: status === 2 ? "saved" : "force-saved", doc };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Answering an error makes the editor warn the user and keep the changes in its session; the page shows why.
    if (error instanceof QuotaExceededError) noteSaveError(accountId, docId, message);
    return { error: 1, action: "failed", message };
  }
}
