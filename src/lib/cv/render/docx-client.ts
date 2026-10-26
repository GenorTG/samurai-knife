import type { CvLang } from "../schema";
import type { CvLayout, PhotoShape } from "./layout";
import { msg } from "@/lib/i18n/msg";

/**
 * Ask the server for a DOCX of the master profile (variantId = null) or a variant and trigger a browser download.
 * Rejects with a readable message on failure (never a raw status line).
 */
export async function downloadCvDocx(options: { variantId: string | null; lang: CvLang; theme: CvLayout; photo: boolean; photoShape: PhotoShape }): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/cv/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...options, format: "docx" }),
    });
  } catch {
    throw new Error(msg("Could not reach the server to build the DOCX. Check your connection and try again."));
  }
  if (!response.ok) throw new Error(await errorMessage(response));

  const blob = await response.blob();
  const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? `CV-${options.lang}.docx`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function errorMessage(response: Response): Promise<string> {
  let reason = "";
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const record = body as { error?: unknown };
      if (typeof record.error === "string") reason = record.error;
    }
  } catch {
    // not JSON
  }
  if (response.status === 401) return "Sign in to export the DOCX.";
  if (response.status === 503) return `The export queue is busy${response.headers.get("retry-after") ? `, retry in ${response.headers.get("retry-after")} s` : ""}.`;
  return reason ? `DOCX export failed: ${reason}` : `DOCX export failed (HTTP ${response.status}).`;
}
