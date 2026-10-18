import * as z from "zod/v4";
import { defineTool, type KnifeToolContext, type KnifeToolDefinition } from "./define";
import { assertFolder, createFolder, folderPath, readFolders, readLibrary } from "@/lib/office/folders";
import { createDoc, DocError, getDoc, getLiveDoc, listVersions, moveDoc, readDocBytes, readVersionBytes, restoreVersion } from "@/lib/office/store";
import { extractOfficeText } from "@/lib/office/extract";
import { buildDocument, OFFICE_FORMATS } from "@/lib/office/templates";
import { QuotaExceededError } from "@/lib/storage/quota";
import { wrapUntrustedOptional } from "@/lib/security/untrusted";

/**
 * Office document tools (group `docs`). The editor itself is a cross-origin iframe the UI tools cannot see into, so the
 * assistant works on the per-account library directly: list (with folders), read as text (also an earlier version),
 * create a first draft, make folders and move documents, list and restore versions. Editing an existing file stays with
 * the user in the editor (or the live `doc_live_*` tools on the page). All tools are scoped to the calling account; nothing
 * here deletes (trash and permanent deletion stay in the user's hands, in the file browser).
 */

const ID = z.string().regex(/^[a-f0-9]{16}$/, "expected a 16-character id from knife_doc_list");

function account(ctx: KnifeToolContext | undefined): string {
  if (!ctx?.accountId) throw new Error("Document tools need an account context.");
  return ctx.accountId;
}

function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof DocError || error instanceof QuotaExceededError) throw new Error(error.message);
    throw error;
  }
}

export const DOC_KNIFE_TOOLS: KnifeToolDefinition[] = [
  defineTool({
    name: "knife_doc_list",
    scope: "account",
    effect: "read",
    description:
      "List the user's office library (Office documents tool): folders (id, name, parentId, path) and documents (id, name, format docx/xlsx/pptx/odt/ods/odp, folderId, folder path, size, version, kept versions, last update), newest first. Optional `folderId` (null = top level) limits documents to one folder; `query` filters names. Trashed items are not listed.",
    schema: z.object({ folderId: ID.nullable().optional(), query: z.string().max(200).optional() }).strict(),
    run({ folderId, query }, ctx) {
      return guarded(() => {
        const acc = account(ctx);
        const library = readLibrary(acc);
        const q = query?.trim().toLowerCase();
        const docs = library.docs
          .filter((d) => folderId === undefined || d.folderId === folderId)
          .filter((d) => !q || d.name.toLowerCase().includes(q))
          .map((d) => ({
            id: d.id,
            name: d.name,
            format: d.format,
            folderId: d.folderId,
            folder: folderPath(library.folders, d.folderId) || "/",
            bytes: d.bytes,
            version: d.version,
            keptVersions: listVersions(acc, d).length,
            updatedAt: d.updatedAt,
          }));
        const folders = library.folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId, path: folderPath(library.folders, f.id) }));
        return { folders, docs };
      });
    },
  }),
  defineTool({
    name: "knife_doc_read",
    scope: "account",
    effect: "read",
    untrustedOutput: true,
    description:
      "Read one office document as plain text: paragraphs for docx/odt, '# Sheet: name' blocks of tab-separated rows for xlsx/ods, '# Slide N' blocks for pptx/odp. Formatting, images and formulas are not included (cell values are). `version` reads an earlier kept version (knife_doc_versions). Use knife_doc_list for ids.",
    schema: z.object({ id: z.string().min(1).max(40), maxChars: z.number().int().min(100).max(200_000).optional(), version: z.number().int().min(1).optional() }).strict(),
    async run({ id, maxChars, version }, ctx) {
      const accountId = account(ctx);
      const { meta, source, format, bytes } = guarded(() => {
        const meta = getDoc(accountId, id);
        const source = version && version !== meta.version ? readVersionBytes(accountId, meta, version) : null;
        return source ? { meta, source, format: source.version.format, bytes: source.bytes } : { meta, source, format: meta.format, bytes: readDocBytes(accountId, meta) };
      });
      // Parsed in the isolate pool (extract.ts), stopping at `limit`: `chars` is the length returned, not the document's.
      const limit = maxChars ?? 20_000;
      const { text, truncated } = await extractOfficeText(format, bytes, { maxChars: limit, owner: accountId });
      return { id, name: meta.name, format, version: source?.version.version ?? meta.version, current: !source, chars: text.length, truncated, text: wrapUntrustedOptional(`office document ${meta.name}`, text) };
    },
  }),
  defineTool({
    name: "knife_doc_create",
    scope: "account",
    effect: "write",
    description:
      "Create a new office document in the user's library and return its id and the page that opens it in the editor. format docx/odt take `paragraphs` (one string per paragraph); xlsx/ods take `rows` (array of rows of cell strings; numbers become numeric cells); pptx/odp take `slides` [{title, bullets[]}]. Plain content only (no styling). Omit the content for a blank file. `folderId` puts it in a folder (knife_doc_list / knife_doc_folder_create). Fails with a clear message when the user's storage is full.",
    schema: z.object({
      format: z.enum(OFFICE_FORMATS),
      name: z.string().min(1).max(120),
      folderId: ID.nullable().optional(),
      paragraphs: z.array(z.string().max(20_000)).max(2000).optional(),
      rows: z.array(z.array(z.string().max(5000)).max(200)).max(5000).optional(),
      slides: z.array(z.object({ title: z.string().max(500), bullets: z.array(z.string().max(2000)).max(30).optional() }).strict()).max(200).optional(),
    }).strict(),
    run({ format, name, folderId, paragraphs, rows, slides }, ctx) {
      const kind = format === "docx" || format === "odt" ? "text" : format === "xlsx" || format === "ods" ? "sheet" : "slides";
      if ((paragraphs && kind !== "text") || (rows && kind !== "sheet") || (slides && kind !== "slides")) {
        throw new Error(`${format}: use ${kind === "text" ? "paragraphs" : kind === "sheet" ? "rows" : "slides"} for this format.`);
      }
      return guarded(() => {
        const acc = account(ctx);
        const folder = assertFolder(acc, folderId);
        const doc = createDoc(acc, { name, format, bytes: buildDocument(format, { paragraphs, rows, slides }), source: "assistant", folderId: folder });
        return { id: doc.id, name: doc.name, format: doc.format, folderId: doc.folderId, bytes: doc.bytes, open: `/tools/office?doc=${doc.id}` };
      });
    },
  }),
  defineTool({
    name: "knife_doc_folder_create",
    scope: "account",
    effect: "write",
    description: "Create a folder in the user's office library (`parentId` null/omitted = top level). Sibling names must be unique. Returns the folder id for knife_doc_create / knife_doc_move.",
    schema: z.object({ name: z.string().min(1).max(120), parentId: ID.nullable().optional() }).strict(),
    run({ name, parentId }, ctx) {
      return guarded(() => {
        const acc = account(ctx);
        const folder = createFolder(acc, name, parentId ?? null);
        return { id: folder.id, name: folder.name, parentId: folder.parentId, path: folderPath(readFolders(acc), folder.id) };
      });
    },
  }),
  defineTool({
    name: "knife_doc_move",
    scope: "account",
    effect: "write",
    description: "Move one document into a folder (`folderId` null = top level). Only moves; never renames or deletes.",
    schema: z.object({ id: ID, folderId: ID.nullable() }).strict(),
    run({ id, folderId }, ctx) {
      return guarded(() => {
        const acc = account(ctx);
        getLiveDoc(acc, id);
        const doc = moveDoc(acc, id, assertFolder(acc, folderId));
        return { id: doc.id, name: doc.name, folderId: doc.folderId, folder: folderPath(readFolders(acc), doc.folderId) || "/" };
      });
    },
  }),
  defineTool({
    name: "knife_doc_versions",
    scope: "account",
    effect: "read",
    description: "List a document's versions: the current one and every kept earlier version (number, format, size, when, who saved it, how it was made: editor save, upload, restore…), newest first. Every save from the editor keeps the previous version.",
    schema: z.object({ id: ID }).strict(),
    run({ id }, ctx) {
      return guarded(() => {
        const acc = account(ctx);
        const meta = getDoc(acc, id);
        return {
          id,
          name: meta.name,
          current: { version: meta.version, format: meta.format, bytes: meta.bytes, savedAt: meta.contentAt ?? meta.updatedAt, savedBy: meta.lastSavedBy, source: meta.versionSource },
          kept: listVersions(acc, meta).reverse(),
        };
      });
    },
  }),
  defineTool({
    name: "knife_doc_restore_version",
    scope: "account",
    effect: "write",
    description:
      "Restore an earlier version of a document (knife_doc_versions): its content becomes a NEW current version, and the content it replaces is kept as a version too, so nothing is lost. Tell the user what you restored. A document open in the editor at that moment keeps editing the old session; its next save becomes a separate '(edited copy)'.",
    schema: z.object({ id: ID, version: z.number().int().min(1) }).strict(),
    run({ id, version }, ctx) {
      return guarded(() => {
        const doc = restoreVersion(account(ctx), id, version, "assistant");
        return { id: doc.id, name: doc.name, version: doc.version, restoredFrom: version };
      });
    },
  }),
];
