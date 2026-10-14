import * as z from "zod/v4";
import { defineTool, type KnifeToolContext, type KnifeToolDefinition } from "./define";
import { resolveForRender } from "@/lib/cv/render/resolve";
import { cvViewToText, estimatePages } from "@/lib/cv/render/text";
import { buildCvView } from "@/lib/cv/render/view";
import { CV_LANGS } from "@/lib/cv/schema";
import { loadCv } from "@/lib/cv/store";

/** CV studio render lane: lets the assistant read the CV exactly as the document prints it. */
export const CV_RENDER_TOOLS: KnifeToolDefinition[] = [
  defineTool({
    name: "knife_cv_preview_text",
    description:
      "Read the CV as plain text exactly as the document (preview, PDF and DOCX) prints it in `lang`: same sections, order, dates, typography, with everything empty or untranslated left out. variantId = a per-job CV version, omit for the master profile. Also returns `warnings` (sections written in the other language but empty in `lang`: translate those before sending) and a rough A4 page estimate. Use it to check the result of your edits.",
    schema: z.object({ variantId: z.string().max(64).nullable().optional(), lang: z.enum(CV_LANGS) }).strict(),
    run({ variantId, lang }, ctx: KnifeToolContext | undefined) {
      if (!ctx?.accountId) throw new Error("CV tools need an account context.");
      const resolved = resolveForRender(loadCv(ctx.accountId), variantId);
      if (!resolved.ok) throw new Error(resolved.error);
      const view = buildCvView(resolved.profile, lang);
      return {
        source: resolved.label,
        lang,
        empty: view.isEmpty,
        pages: estimatePages(view),
        warnings: view.warnings,
        text: cvViewToText(view),
      };
    },
  }),
];
