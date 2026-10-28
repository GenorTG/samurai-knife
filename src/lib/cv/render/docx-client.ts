import type { CvLang } from "../schema";
import type { CvLayout, CvLook, CvPageMode, PhotoShape } from "./layout";
import { msg, msgf } from "@/lib/i18n/msg";
import { withProject } from "../shown-project";

export type CvExportFormat = "pdf" | "docx" | "html" | "txt";

export interface CvExportOptions {
  variantId: string | null;
  lang: CvLang;
  theme: CvLayout;
  photo: boolean;
  photoShape: PhotoShape;
  format?: CvExportFormat;
  look?: Partial<Omit<CvLook, "layout">>;
  pageMode?: CvPageMode;
  /** pdf / html: the preview's sheet element; its markup is what the file shows. */
  sheet?: HTMLElement | null;
}

const NAMES: Record<CvExportFormat, string> = { pdf: "PDF", docx: "DOCX", html: "HTML", txt: "text" };

/**
 * Ask the server for the CV of the master profile (variantId = null) or a version as PDF, DOCX, HTML or plain text and
 * trigger a browser download. Rejects with a readable message on failure (never a raw status line).
 */
export async function downloadCvExport(options: CvExportOptions): Promise<void> {
  const format = options.format ?? "docx";
  const { sheet, look, ...rest } = options;
  if ((format === "pdf" || format === "html") && !sheet) throw new Error(msg("Open the preview first: the PDF and HTML files are made from it."));
  let response: Response;
  try {
    response = await fetch(withProject("/api/cv/export"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...rest, ...look, format, ...(sheet && (format === "pdf" || format === "html") ? { sheet: sheet.outerHTML } : {}) }),
    });
  } catch {
    throw new Error(msgf("Could not reach the server to build the {name}. Check your connection and try again.", { name: NAMES[format] }));
  }
  if (!response.ok) throw new Error(await errorMessage(response, format));

  const blob = await response.blob();
  const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? `CV-${options.lang}.${format}`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Kept for callers of the old DOCX-only helper. */
export const downloadCvDocx = (options: Omit<CvExportOptions, "format">): Promise<void> => downloadCvExport({ ...options, format: "docx" });

async function errorMessage(response: Response, format: CvExportFormat): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    /* not JSON */
  }
  return msgf("The {name} could not be built (status {status}).", { name: NAMES[format], status: response.status });
}
