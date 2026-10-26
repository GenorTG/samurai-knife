import * as z from "zod/v4";
import { existsSync } from "node:fs";
import { readAccountText } from "@/lib/storage/sealed";
import { writeAccountFile } from "@/lib/storage/quota";
import { accountScope } from "@/lib/storage/scope";
import {
  allDocs,
  cleanBase,
  DocError,
  deleteDoc,
  docDiskBytes,
  getDoc,
  isDocId,
  libraryDir,
  newId,
  TRASH_DAYS,
  trashDoc,
  untrashDoc,
  type DocMeta,
} from "./store";
import { msgf } from "@/lib/i18n/msg";

/**
 * The folder tree of one account's office library: `docs/<account>/folders.json` (0600). Folders are metadata only (the
 * document directories stay flat, a document names its `folderId`), so moving is one small write and never touches bytes.
 * Sibling names are unique (case-insensitive); depth is capped at MAX_DEPTH. Trashing a folder trashes its whole subtree
 * (`trashedWith` = the folder's id) and restoring it brings back exactly that set.
 */

export const MAX_FOLDERS = 2000;
export const MAX_DEPTH = 12;

const folderSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{16}$/),
  name: z.string().min(1).max(120),
  parentId: z.string().regex(/^[a-f0-9]{16}$/).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  trashedAt: z.string().optional(),
  trashedWith: z.string().regex(/^[a-f0-9]{16}$/).optional(),
});

const fileSchema = z.object({ version: z.literal(1), folders: z.array(folderSchema).max(MAX_FOLDERS) });

export type Folder = z.infer<typeof folderSchema>;

function foldersPath(accountId: string): string {
  libraryDir(accountId);
  return accountScope(accountId).join("docs", "folders.json");
}

export function readFolders(accountId: string): Folder[] {
  const path = foldersPath(accountId);
  if (!existsSync(path)) return [];
  try {
    return fileSchema.parse(JSON.parse(readAccountText(accountId, path))).folders;
  } catch {
    throw new DocError("the folder list (folders.json) is damaged", 500);
  }
}

function writeFolders(accountId: string, folders: Folder[]): void {
  writeAccountFile(accountId, foldersPath(accountId), `${JSON.stringify(fileSchema.parse({ version: 1, folders }), null, 2)}\n`, { enforce: false });
}

function purgeOldTrash(accountId: string, folders: Folder[]): Folder[] {
  const before = new Date(Date.now() - TRASH_DAYS * 86_400_000).toISOString();
  const old = new Set(folders.filter((f) => f.trashedAt && f.trashedAt < before).map((f) => f.id));
  if (!old.size) return folders;
  const kept = folders.filter((f) => !old.has(f.id));
  writeFolders(accountId, kept);
  return kept;
}

export interface Library {
  folders: Folder[];
  docs: DocMeta[];
  trash: { folders: Folder[]; docs: DocMeta[] };
}

/** Everything in one read: live folders + documents, and the trash (only the items the user trashed, not their contents). */
export function readLibrary(accountId: string): Library {
  const folders = purgeOldTrash(accountId, readFolders(accountId));
  const docs = allDocs(accountId);
  return {
    folders: folders.filter((f) => !f.trashedAt),
    docs: docs.filter((d) => !d.trashedAt),
    trash: {
      folders: folders.filter((f) => f.trashedAt && f.trashedWith === f.id),
      docs: docs.filter((d) => d.trashedAt && d.trashedWith === d.id),
    },
  };
}

function find(folders: Folder[], id: string): Folder {
  const folder = isDocId(id) ? folders.find((f) => f.id === id) : undefined;
  if (!folder) throw new DocError("unknown folder", 404);
  return folder;
}

/** A live (not trashed) folder, or null for the root; 404 for anything else. */
export function assertFolder(accountId: string, folderId: string | null | undefined): string | null {
  if (folderId === null || folderId === undefined || folderId === "") return null;
  const folder = find(readFolders(accountId), folderId);
  if (folder.trashedAt) throw new DocError(msgf("{name} is in the trash", { name: folder.name }), 409);
  return folder.id;
}

function depth(folders: Folder[], id: string | null): number {
  let d = 0;
  for (let at = id; at; at = folders.find((f) => f.id === at)?.parentId ?? null) d += 1;
  return d;
}

/** Ids of a folder and every folder below it. */
export function subtree(folders: Folder[], rootId: string): Set<string> {
  const out = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
      out.add(f.id);
      grew = true;
    }
  }
  return out;
}

function assertUniqueName(folders: Folder[], parentId: string | null, name: string, exceptId?: string): void {
  const clash = folders.find((f) => !f.trashedAt && f.parentId === parentId && f.id !== exceptId && f.name.toLowerCase() === name.toLowerCase());
  if (clash) throw new DocError(`a folder named ${name} already exists here`, 409);
}

export function createFolder(accountId: string, name: string, parentId: string | null): Folder {
  const folders = readFolders(accountId);
  if (folders.length >= MAX_FOLDERS) throw new DocError(`at most ${MAX_FOLDERS} folders`, 409);
  const parent = assertFolder(accountId, parentId);
  if (depth(folders, parent) >= MAX_DEPTH) throw new DocError(`folders nest at most ${MAX_DEPTH} levels deep`, 422);
  const clean = cleanBase(name);
  assertUniqueName(folders, parent, clean);
  let id = newId();
  while (folders.some((f) => f.id === id)) id = newId();
  const now = new Date().toISOString();
  const folder: Folder = { id, name: clean, parentId: parent, createdAt: now, updatedAt: now };
  writeFolders(accountId, [...folders, folder]);
  return folder;
}

export function renameFolder(accountId: string, folderId: string, name: string): Folder {
  const folders = readFolders(accountId);
  const folder = find(folders, folderId);
  const clean = cleanBase(name);
  assertUniqueName(folders, folder.parentId, clean, folder.id);
  const next = { ...folder, name: clean, updatedAt: new Date().toISOString() };
  writeFolders(accountId, folders.map((f) => (f.id === folder.id ? next : f)));
  return next;
}

export function moveFolder(accountId: string, folderId: string, parentId: string | null): Folder {
  const folders = readFolders(accountId);
  const folder = find(folders, folderId);
  if (folder.trashedAt) throw new DocError(msgf("{name} is in the trash: restore it first", { name: folder.name }), 409);
  const parent = assertFolder(accountId, parentId);
  if (parent && subtree(folders, folder.id).has(parent)) throw new DocError("a folder cannot move into itself or one of its subfolders", 422);
  const below = Math.max(...[...subtree(folders, folder.id)].map((id) => depth(folders, id) - depth(folders, folder.id)));
  if (depth(folders, parent) + 1 + below > MAX_DEPTH) throw new DocError(`folders nest at most ${MAX_DEPTH} levels deep`, 422);
  assertUniqueName(folders, parent, folder.name, folder.id);
  const next = { ...folder, parentId: parent, updatedAt: new Date().toISOString() };
  writeFolders(accountId, folders.map((f) => (f.id === folder.id ? next : f)));
  return next;
}

/** The folder, its subfolders and every document in them go to the trash together. Returns how many documents went. */
export function trashFolder(accountId: string, folderId: string): { folder: Folder; docs: number } {
  const folders = readFolders(accountId);
  const folder = find(folders, folderId);
  if (folder.trashedAt) return { folder, docs: 0 };
  const ids = subtree(folders, folder.id);
  const at = new Date().toISOString();
  const next = folders.map((f) => (ids.has(f.id) && !f.trashedAt ? { ...f, trashedAt: at, trashedWith: folder.id } : f));
  let docs = 0;
  for (const doc of allDocs(accountId)) {
    if (!doc.trashedAt && doc.folderId && ids.has(doc.folderId)) {
      trashDoc(accountId, doc.id, folder.id, at);
      docs += 1;
    }
  }
  writeFolders(accountId, next);
  return { folder: next.find((f) => f.id === folder.id) as Folder, docs };
}

/** Restores a trashed folder with everything trashed together with it; lands at the root when its parent is gone. */
export function restoreFolder(accountId: string, folderId: string): Folder {
  const folders = readFolders(accountId);
  const folder = find(folders, folderId);
  if (!folder.trashedAt) return folder;
  if (folder.trashedWith !== folder.id) throw new DocError(msgf("{name} went to the trash with its parent folder: restore that one", { name: folder.name }), 409);
  const parentLive = folder.parentId ? folders.some((f) => f.id === folder.parentId && !f.trashedAt) : true;
  const parentId = parentLive ? folder.parentId : null;
  const restoredName = uniqueName(folders, parentId, folder.name, folder.id);
  const now = new Date().toISOString();
  const next = folders.map((f) => {
    if (f.trashedWith !== folder.id) return f;
    const base = { ...f, trashedAt: undefined, trashedWith: undefined, updatedAt: now };
    return f.id === folder.id ? { ...base, parentId, name: restoredName } : base;
  });
  writeFolders(accountId, next);
  for (const doc of allDocs(accountId)) if (doc.trashedWith === folder.id) untrashDoc(accountId, doc.id, doc.folderId);
  return next.find((f) => f.id === folder.id) as Folder;
}

/** "Name", or "Name (2)"… when a live sibling has the name already (restores never fail on a clash). */
function uniqueName(folders: Folder[], parentId: string | null, name: string, exceptId: string): string {
  const taken = new Set(folders.filter((f) => !f.trashedAt && f.parentId === parentId && f.id !== exceptId).map((f) => f.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n += 1) if (!taken.has(`${name} (${n})`.toLowerCase())) return `${name} (${n})`;
}

/** A trashed document back where it was (root when its folder is gone or still in the trash). */
export function restoreDoc(accountId: string, docId: string): DocMeta {
  const doc = getDoc(accountId, docId);
  if (!doc.trashedAt) return doc;
  if (doc.trashedWith && doc.trashedWith !== doc.id) throw new DocError(msgf("{name} went to the trash with its folder: restore the folder", { name: doc.name }), 409);
  const folders = readFolders(accountId);
  const live = doc.folderId && folders.some((f) => f.id === doc.folderId && !f.trashedAt) ? doc.folderId : null;
  return untrashDoc(accountId, doc.id, live);
}

/** Deletes a trashed folder for good, with every folder and document trashed together with it. */
export function deleteFolderForever(accountId: string, folderId: string): { docs: number; freedBytes: number } {
  const folders = readFolders(accountId);
  const folder = find(folders, folderId);
  if (!folder.trashedAt || folder.trashedWith !== folder.id) throw new DocError("only a folder in the trash can be deleted for good: move it to the trash first", 409);
  let docs = 0;
  let freedBytes = 0;
  for (const doc of allDocs(accountId)) {
    if (doc.trashedWith !== folder.id) continue;
    freedBytes += docDiskBytes(accountId, doc);
    deleteDoc(accountId, doc.id);
    docs += 1;
  }
  writeFolders(accountId, folders.filter((f) => f.trashedWith !== folder.id));
  return { docs, freedBytes };
}

/** Empties the trash; returns what went. */
export function emptyTrash(accountId: string): { docs: number; folders: number; freedBytes: number } {
  const folders = readFolders(accountId);
  let docs = 0;
  let freedBytes = 0;
  for (const doc of allDocs(accountId)) {
    if (!doc.trashedAt) continue;
    freedBytes += docDiskBytes(accountId, doc);
    deleteDoc(accountId, doc.id);
    docs += 1;
  }
  const kept = folders.filter((f) => !f.trashedAt);
  if (kept.length !== folders.length) writeFolders(accountId, kept);
  return { docs, folders: folders.length - kept.length, freedBytes };
}

/** "Projects / 2026 / Offers" for a folder id (null = root). */
export function folderPath(folders: Folder[], folderId: string | null): string {
  const parts: string[] = [];
  for (let at = folderId; at; ) {
    const f = folders.find((x) => x.id === at);
    if (!f) break;
    parts.unshift(f.name);
    at = f.parentId;
  }
  return parts.join(" / ");
}

/** Byte totals for the file browser: live documents, their kept versions, and the trash. */
export function libraryBytes(accountId: string): { files: number; versions: number; trash: number } {
  let files = 0;
  let versions = 0;
  let trash = 0;
  for (const doc of allDocs(accountId)) {
    const total = docDiskBytes(accountId, doc);
    if (doc.trashedAt) trash += total;
    else {
      files += doc.bytes;
      versions += total - doc.bytes;
    }
  }
  return { files, versions, trash };
}
