import type { CvData, CvLang, Profile } from "../schema";
import { resolveVariant } from "../variant";

export type ResolvedProfile = { ok: true; profile: Profile; label: string } | { ok: false; status: 404; error: string };

/** The profile a renderer prints: the master (`variantId` null) or master + variant. Unknown ids list the known ones. */
export function resolveForRender(data: CvData, variantId: string | null | undefined): ResolvedProfile {
  if (!variantId) return { ok: true, profile: data.profile, label: "master" };
  const variant = data.variants.find((v) => v.id === variantId);
  if (!variant) {
    const known = data.variants.map((v) => v.id);
    return { ok: false, status: 404, error: `no variant '${variantId}' (have: ${known.length ? known.join(", ") : "none"})` };
  }
  return { ok: true, profile: resolveVariant(data.profile, variant), label: `variant ${variant.id}` };
}

const POLISH_FOLD: Record<string, string> = { "ł": "l", "Ł": "L" };

/** `Jan-Kowalski-CV-pl.docx`: ASCII-only so it is safe in a Content-Disposition header on any platform. */
export function cvFileName(name: string, lang: CvLang, extension: string): string {
  const stem = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[łŁ]/g, (c) => POLISH_FOLD[c])
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${stem ? `${stem}-` : ""}CV-${lang}.${extension}`;
}
