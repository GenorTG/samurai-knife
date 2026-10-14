import * as z from "zod/v4";
import { defineTool, type KnifeToolContext, type KnifeToolDefinition } from "./define";
import { createDoc, DocError, getDoc, listDocs, readDocBytes } from "@/lib/office/store";
import { extractText } from "@/lib/office/text";
import { buildDocument, OFFICE_FORMATS } from "@/lib/office/templates";

/**
 * Office document tools (group `docs`). The editor itself is a cross-origin iframe the UI tools cannot see into, so the
 * assistant works on the per-account library directly: list, read as text, create a first draft. Editing an existing
 * file stays with the user in the editor. All tools are scoped to the calling account.
 */

function account(ctx: KnifeToolContext | undefined): string {
  if (!ctx?.accountId) throw new Error("Document tools need an account context.");
  return ctx.accountId;
}

function rethrow(error: unknown): never {
  if (error instanceof DocError) throw new Error(error.message);
  throw error;
}

export const DOC_KNIFE_TOOLS: KnifeToolDefinition[] = [
  defineTool({
    name: "knife_doc_list",
    description: "List the user's office documents (Office documents tool): id, name, format (docx/xlsx/pptx/odt/ods/odp), size, version, last update. Newest first.",
    schema: z.object({}).strict(),
    run(_input, ctx) {
      return listDocs(account(ctx)).map((d) => ({ id: d.id, name: d.name, format: d.format, bytes: d.bytes, version: d.version, updatedAt: d.updatedAt }));
    },
  }),
  defineTool({
    name: "knife_doc_read",
    description:
      "Read one office document as plain text: paragraphs for docx/odt, '# Sheet: name' blocks of tab-separated rows for xlsx/ods, '# Slide N' blocks for pptx/odp. Formatting, images and formulas are not included (cell values are). Use knife_doc_list for ids.",
    schema: z.object({ id: z.string().min(1).max(40), maxChars: z.number().int().min(100).max(200_000).optional() }).strict(),
    run({ id, maxChars }, ctx) {
      try {
        const accountId = account(ctx);
        const meta = getDoc(accountId, id);
        const text = extractText(meta.format, readDocBytes(accountId, meta));
        const limit = maxChars ?? 20_000;
        return { id, name: meta.name, format: meta.format, version: meta.version, chars: text.length, truncated: text.length > limit, text: text.slice(0, limit) };
      } catch (error) {
        rethrow(error);
      }
    },
  }),
  defineTool({
    name: "knife_doc_create",
    description:
      "Create a new office document in the user's library and return its id and the page that opens it in the editor. format docx/odt take `paragraphs` (one string per paragraph); xlsx/ods take `rows` (array of rows of cell strings; numbers become numeric cells); pptx/odp take `slides` [{title, bullets[]}]. Plain content only (no styling). Omit the content for a blank file.",
    schema: z.object({
      format: z.enum(OFFICE_FORMATS),
      name: z.string().min(1).max(120),
      paragraphs: z.array(z.string().max(20_000)).max(2000).optional(),
      rows: z.array(z.array(z.string().max(5000)).max(200)).max(5000).optional(),
      slides: z.array(z.object({ title: z.string().max(500), bullets: z.array(z.string().max(2000)).max(30).optional() }).strict()).max(200).optional(),
    }).strict(),
    run({ format, name, paragraphs, rows, slides }, ctx) {
      const kind = format === "docx" || format === "odt" ? "text" : format === "xlsx" || format === "ods" ? "sheet" : "slides";
      if ((paragraphs && kind !== "text") || (rows && kind !== "sheet") || (slides && kind !== "slides")) {
        throw new Error(`${format}: use ${kind === "text" ? "paragraphs" : kind === "sheet" ? "rows" : "slides"} for this format.`);
      }
      try {
        const doc = createDoc(account(ctx), { name, format, bytes: buildDocument(format, { paragraphs, rows, slides }), source: "assistant" });
        return { id: doc.id, name: doc.name, format: doc.format, bytes: doc.bytes, open: `/tools/office?doc=${doc.id}` };
      } catch (error) {
        rethrow(error);
      }
    },
  }),
];
