import { promises as fs } from "node:fs";
import path from "node:path";
import * as z from "zod/v4";

import { authenticate, jsonError, readJsonBody } from "@/lib/accounts/http";
import { accentOf, CV_ACCENT_IDS, CV_DENSITIES, CV_FONTS, CV_LAYOUT_INFO, CV_LAYOUTS, CV_PAGE_MODES, CV_PAPERS, fontsOf, iconsOf, PHOTO_SHAPES, type CvAccent } from "@/lib/cv/render/layout";
import { cvFileName, resolveForRender } from "@/lib/cv/render/resolve";
import { cleanSheet, MAX_SHEET_BYTES, pdfFontFiles, pdfHtml, SheetError, standaloneHtml } from "@/lib/cv/render/sheet-html";
import { cvViewToText } from "@/lib/cv/render/text";
import { buildCvView } from "@/lib/cv/render/view";
import { CV_LANGS, ID_PATTERN } from "@/lib/cv/schema";
import { cvStoreErrorResponse } from "@/lib/cv/http";
import { readPhoto } from "@/lib/cv/photo-store";
import { loadCv } from "@/lib/cv/store";
import { disposeDir, makeScratchDir, runPythonScript } from "@/lib/python";
import { queueFullOrNull } from "@/lib/queue-http";
import { msg, msgf } from "@/lib/i18n/msg";
import { bindRequestProject } from "@/lib/cv/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOCX_TIMEOUT_MS = 60_000;
const PDF_TIMEOUT_MS = 90_000;

const bodySchema = z
  .object({
    variantId: z.string().regex(ID_PATTERN).nullable(),
    lang: z.enum(CV_LANGS),
    theme: z.enum(CV_LAYOUTS),
    /** Print the stored photo (layouts with a photo slot only; no stored photo = no photo). */
    photo: z.boolean().default(false),
    photoShape: z.enum(PHOTO_SHAPES).default("round"),
    format: z.enum(["docx", "pdf", "html", "txt"]).default("docx"),
    accent: z.string().refine((v) => v === "auto" || (CV_ACCENT_IDS as string[]).includes(v), "unknown accent").default("auto"),
    fonts: z.enum(CV_FONTS).default("auto"),
    density: z.enum(CV_DENSITIES).default("comfortable"),
    paper: z.enum(CV_PAPERS).default("a4"),
    fullUrls: z.boolean().default(false),
    icons: z.boolean().default(true),
    pageMode: z.enum(CV_PAGE_MODES).default("cv"),
    /** pdf / html: the sheet the preview rendered (`<article class="cvdoc">…`), cleaned server-side (sheet-html.ts). */
    sheet: z.string().max(MAX_SHEET_BYTES).optional(),
  })
  .strict();

function attachment(body: Uint8Array | string, mime: string, file: string, extra: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : new Uint8Array(body), {
    headers: { "Content-Type": mime, "Content-Disposition": `attachment; filename="${file}"`, "Cache-Control": "no-store", ...extra },
  });
}

/**
 * POST /api/cv/export { variantId, lang, theme (layout), format: docx|pdf|html|txt, photo?, photoShape?, accent?, fonts?,
 * density?, paper?, fullUrls?, icons?, pageMode?: cv|cv+pages|pages, sheet? } -> the file.
 * - docx: the view laid out by cv_docx.py (every layout mapped to what Word does well; links are real hyperlinks).
 * - pdf: the preview's sheet + cv-document.css rendered by WeasyPrint (cv_pdf.py): the PDF is the preview, links clickable.
 * - html: the same sheet as one self-contained file (fonts and photo embedded).
 * - txt: the plain text an ATS reads (same wording and order).
 * Runs on the light Python lane. 404 unknown variant, 422 nothing to print in `lang` or no sheet for pdf/html.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const unknownProject = bindRequestProject(request, auth.account.id);
  if (unknownProject) return unknownProject;
  const read = await readJsonBody(request, MAX_SHEET_BYTES + 64 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return jsonError(msgf("Bad request: {value}: {message}", { value: issue.path.join("/") || "body", message: issue.message }), 422);
  }
  const body = parsed.data;
  const { variantId, lang, theme, photoShape, format } = body;

  let stored;
  try {
    stored = loadCv(auth.account.id);
  } catch (error) {
    const response = cvStoreErrorResponse(error);
    if (response) return response;
    throw error;
  }
  const resolved = resolveForRender(stored, variantId);
  if (!resolved.ok) return jsonError(resolved.error, resolved.status);
  const view = buildCvView(resolved.profile, lang, { nbsp: false, fullUrls: body.fullUrls });
  const pagesOnly = body.pageMode === "pages";
  if ((pagesOnly && view.pages.length === 0) || (!pagesOnly && view.isEmpty)) {
    return jsonError(msgf("Nothing to export: the {label} CV has no text in {value} yet.", { label: resolved.label, value: lang === "pl" ? "Polish" : "English" }), 422, { warnings: view.warnings });
  }
  const stem = cvFileName(view.name, lang, "x").slice(0, -2) + (pagesOnly ? "-projects" : "");
  const storedPhoto = body.photo && CV_LAYOUT_INFO[theme].photo ? readPhoto(auth.account.id) : null;
  const title = view.name ? `${view.name} - ${pagesOnly ? "Projects" : "CV"}` : "CV";

  if (format === "txt") {
    const text = `${cvViewToText(view)}\n`;
    return attachment(text, "text/plain; charset=utf-8", `${stem}.txt`);
  }

  if (format === "html" || format === "pdf") {
    if (!body.sheet) return jsonError(msg("The PDF and HTML exports need the preview's sheet: open the CV version and export from there."), 422);
    const fonts = fontsOf({ layout: theme, fonts: body.fonts });
    const photoDataUrl = storedPhoto ? `data:image/jpeg;base64,${storedPhoto.toString("base64")}` : null;
    let doc;
    try {
      cleanSheet(body.sheet, null);
      doc = { sheetHtml: body.sheet, lang, title, paper: body.paper, fonts, photoDataUrl };
    } catch (error) {
      if (error instanceof SheetError) return jsonError(msg("That is not a CV sheet from the CV studio preview."), 422);
      throw error;
    }
    if (format === "html") return attachment(standaloneHtml(doc), "text/html; charset=utf-8", `${stem}.html`);
    const outDir = await makeScratchDir("knife-cv-");
    try {
      // The sandboxed renderer sees only its scratch dir: the fonts it may load are copied in.
      const fontsDir = path.join(outDir, "fonts");
      await fs.mkdir(fontsDir, { mode: 0o700 });
      for (const font of pdfFontFiles(fonts)) await fs.copyFile(font.path, path.join(fontsDir, font.name));
      const result = await runPythonScript<Record<string, unknown>>(
        "cv_pdf.py",
        { html: pdfHtml(doc), fonts_dir: fontsDir, out_dir: outDir, filename: `${stem}.pdf`, title, author: view.name, lang },
        { lane: "light", timeoutMs: PDF_TIMEOUT_MS, label: "cv:pdf", signal: request.signal, owner: auth.account.id, binds: { writable: [outDir] } },
      );
      if (result.cancelled) return new Response(null, { status: 499 });
      const file = typeof result.payload?.file === "string" ? path.basename(result.payload.file) : "";
      if (!result.ok || !file) return jsonError(result.error ?? msg("The PDF could not be built."), 500, { logs: result.logs });
      const pages = typeof result.payload?.pages === "number" ? String(result.payload.pages) : "";
      return attachment(await fs.readFile(path.join(outDir, file)), "application/pdf", file, { "X-Knife-Ms": String(result.ms), ...(pages ? { "X-Cv-Pages": pages } : {}) });
    } catch (error) {
      const full = queueFullOrNull(error);
      if (full) return full;
      return jsonError(error instanceof Error ? error.message : String(error), 500);
    } finally {
      await disposeDir(outDir);
    }
  }

  const filename = `${stem}.docx`;
  const outDir = await makeScratchDir("knife-cv-");
  try {
    let photo: string | null = null;
    // The stored photo is sealed at rest: the Python lane gets a plaintext copy in the job's own scratch dir.
    if (storedPhoto) {
      photo = path.join(outDir, "photo.jpg");
      await fs.writeFile(photo, storedPhoto, { mode: 0o600 });
    }
    // Resolved here (layout defaults applied): the script gets a colour and a font pair, never "auto".
    const look = { accent: accentOf({ layout: theme, accent: body.accent as CvAccent | "auto" }), fonts: fontsOf({ layout: theme, fonts: body.fonts }), density: body.density, paper: body.paper, icons: iconsOf({ layout: theme, icons: body.icons }) };
    const result = await runPythonScript<Record<string, unknown>>(
      "cv_docx.py",
      { view, theme, look, page_mode: body.pageMode, photo, photo_shape: photoShape, out_dir: outDir, filename },
      { lane: "light", timeoutMs: DOCX_TIMEOUT_MS, label: "cv:docx", signal: request.signal, owner: auth.account.id, binds: { writable: [outDir] } },
    );
    if (result.cancelled) return new Response(null, { status: 499 });
    const file = typeof result.payload?.file === "string" ? path.basename(result.payload.file) : "";
    if (!result.ok || !file) return jsonError(result.error ?? "The DOCX could not be built.", 500, { logs: result.logs });
    const mime = typeof result.payload?.mime === "string" ? result.payload.mime : "application/octet-stream";
    return attachment(await fs.readFile(path.join(outDir, file)), mime, file, { "X-Knife-Ms": String(result.ms) });
  } catch (error) {
    const full = queueFullOrNull(error);
    if (full) return full;
    return jsonError(error instanceof Error ? error.message : String(error), 500);
  } finally {
    await disposeDir(outDir);
  }
}
