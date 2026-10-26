import { promises as fs } from "node:fs";
import path from "node:path";
import * as z from "zod/v4";

import { authenticate, jsonError, readJsonBody } from "@/lib/accounts/http";
import { CV_LAYOUT_INFO, CV_LAYOUTS, PHOTO_SHAPES } from "@/lib/cv/render/layout";
import { cvFileName, resolveForRender } from "@/lib/cv/render/resolve";
import { buildCvView } from "@/lib/cv/render/view";
import { CV_LANGS, ID_PATTERN } from "@/lib/cv/schema";
import { cvStoreErrorResponse } from "@/lib/cv/http";
import { readPhoto } from "@/lib/cv/photo-store";
import { loadCv } from "@/lib/cv/store";
import { disposeDir, makeScratchDir, runPythonScript } from "@/lib/python";
import { queueFullOrNull } from "@/lib/queue-http";
import { msgf } from "@/lib/i18n/msg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOCX_TIMEOUT_MS = 60_000;

const bodySchema = z
  .object({
    variantId: z.string().regex(ID_PATTERN).nullable(),
    lang: z.enum(CV_LANGS),
    theme: z.enum(CV_LAYOUTS),
    /** Print the stored photo (layouts with a photo slot only; no stored photo = no photo). */
    photo: z.boolean().default(false),
    photoShape: z.enum(PHOTO_SHAPES).default("round"),
    format: z.literal("docx"),
  })
  .strict();

/**
 * POST /api/cv/export { variantId: string|null, lang, theme (layout), photo?, photoShape?, format: "docx" } -> the CV as a .docx file.
 * The profile (master, or master + variant) is resolved and turned into the shared view model here; the Python script
 * only lays that view out. Runs on the light Python lane. 404 unknown variant, 422 nothing to print in `lang`.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const read = await readJsonBody(request, 16 * 1024);
  if ("response" in read) return read.response;
  const parsed = bodySchema.safeParse(read.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return jsonError(msgf("Bad request: {value}: {message}", { value: issue.path.join("/") || "body", message: issue.message }), 422);
  }
  const { variantId, lang, theme, photoShape } = parsed.data;

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
  const view = buildCvView(resolved.profile, lang, { nbsp: false });
  if (view.isEmpty) {
    return jsonError(msgf("Nothing to export: the {label} CV has no text in {value} yet.", { label: resolved.label, value: lang === "pl" ? "Polish" : "English" }), 422, { warnings: view.warnings });
  }

  const filename = cvFileName(view.name, lang, "docx");
  const outDir = await makeScratchDir("knife-cv-");
  try {
    let photo: string | null = null;
    // The stored photo is sealed at rest: the Python lane gets a plaintext copy in the job's own scratch dir.
    const storedPhoto = parsed.data.photo && CV_LAYOUT_INFO[theme].photo ? readPhoto(auth.account.id) : null;
    if (storedPhoto) {
      photo = path.join(outDir, "photo.jpg");
      await fs.writeFile(photo, storedPhoto, { mode: 0o600 });
    }
    const result = await runPythonScript<Record<string, unknown>>(
      "cv_docx.py",
      { view, theme, photo, photo_shape: photoShape, out_dir: outDir, filename },
      { lane: "light", timeoutMs: DOCX_TIMEOUT_MS, label: "cv:docx", signal: request.signal, owner: auth.account.id, binds: { writable: [outDir] } },
    );
    if (result.cancelled) return new Response(null, { status: 499 });
    const file = typeof result.payload?.file === "string" ? path.basename(result.payload.file) : "";
    if (!result.ok || !file) return jsonError(result.error ?? "The DOCX could not be built.", 500, { logs: result.logs });
    const buffer = await fs.readFile(path.join(outDir, file));
    const mime = typeof result.payload?.mime === "string" ? result.payload.mime : "application/octet-stream";
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `attachment; filename="${file}"`,
        "Cache-Control": "no-store",
        "X-Knife-Ms": String(result.ms),
      },
    });
  } catch (error) {
    const full = queueFullOrNull(error);
    if (full) return full;
    return jsonError(error instanceof Error ? error.message : String(error), 500);
  } finally {
    await disposeDir(outDir);
  }
}
