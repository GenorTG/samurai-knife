import * as z from "zod/v4";
import { defineTool, type KnifeToolContext, type KnifeToolDefinition } from "./define";
import { CV_LANGS } from "@/lib/cv/schema";
import { loadCv } from "@/lib/cv/store";
import { auditProfile, auditTranslation, lintAdHoc } from "@/lib/cv/text/audit";
import { GLOSSARY, searchGlossary } from "@/lib/cv/text/glossary";
import { ScopeError } from "@/lib/cv/text/walk";

/**
 * CV studio wording / translation quality tools. They only *report*: deterministic rules find candidates, the
 * model decides what to change with the user. No LLM is called here.
 */

const HINTS_ONLY =
  "Findings are deterministic hints, not verdicts: some are false positives, and the user decides what changes. Never invent facts (numbers, names, employers, results) to satisfy a finding; ask the user for the missing detail instead.";

const SCOPE_DOC = "Profile path to check, e.g. '/', '/experience/id=rentiers', '/summary'. Default '/'.";

function account(ctx: KnifeToolContext | undefined): string {
  if (!ctx?.accountId) throw new Error("CV tools need an account context.");
  return ctx.accountId;
}

/** Scope problems are user-facing: the message names what exists, so the model can retry. */
function scoped<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ScopeError) throw new Error(error.message);
    throw error;
  }
}

export const CV_TEXT_TOOLS: KnifeToolDefinition[] = [
  defineTool({
    name: "knife_cv_audit",
    description:
      "Lint all profile text in ONE language (weak openers, buzzwords, first person in EN bullets, long bullets, bullets with no number/name/tech, typography, stripped Polish diacritics, mixed languages, inconsistent bullet lists). " +
      "Returns counts by severity and rule plus findings keyed by the editable path (e.g. /experience/id=x/bullets/id=y/text/en), each with rule, severity, message, hint and span. Fix with knife_cv_patch on that exact path. " +
      HINTS_ONLY,
    schema: z.object({ lang: z.enum(CV_LANGS), scope: z.string().max(300).optional().describe(SCOPE_DOC), includeTypography: z.boolean().optional().describe("Also report typography-only findings (non-breaking spaces) that the renderer already fixes. Default false.") }).strict(),
    run({ lang, scope, includeTypography }, ctx) {
      return scoped(() => auditProfile(loadCv(account(ctx)).profile, lang, scope ?? "/", { includeTypography: includeTypography === true }));
    },
  }),
  defineTool({
    name: "knife_cv_translation_audit",
    description:
      "Check every field that has both PL and EN text for facts that must survive translation (numbers, URLs, emails, versions, tech terms, names), untranslated copies, extreme length mismatch and glossary drift; also lists fields missing one side (missingPl / missingEn). " +
      "Findings are keyed by the {pl,en} field path; append /pl or /en to edit a side. Findings never say which side is right: ask the user for the source of truth before changing a figure. " +
      HINTS_ONLY,
    schema: z.object({ scope: z.string().max(300).optional().describe(SCOPE_DOC) }).strict(),
    run({ scope }, ctx) {
      return scoped(() => auditTranslation(loadCv(account(ctx)).profile, scope ?? "/"));
    },
  }),
  defineTool({
    name: "knife_cv_lint_text",
    description:
      "Lint ad-hoc text the user pasted or you drafted (not stored in the profile). kind: bullet (one achievement per line; several lines are checked as a list), summary, or paragraph. " +
      "Use it on a rewrite BEFORE saving it with knife_cv_patch. " +
      HINTS_ONLY,
    schema: z.object({
      text: z.string().min(1).max(20_000),
      lang: z.enum(CV_LANGS),
      kind: z.enum(["bullet", "summary", "paragraph"]).optional().describe("Default bullet."),
    }).strict(),
    run({ text, lang, kind }) {
      if (!text.trim()) throw new Error("text is empty");
      return lintAdHoc(text, lang, kind ?? "bullet");
    },
  }),
  defineTool({
    name: "knife_cv_glossary",
    description:
      "Look up the preferred PL<->EN rendering of CV/IT terms (query matches PL or EN, diacritics optional) or list them all. Use it when translating so terminology stays consistent; the user's own wording still wins.",
    schema: z.object({ query: z.string().max(100).optional() }).strict(),
    run({ query }) {
      const entries = searchGlossary(query).map((e) => ({ pl: e.pl, en: e.en, acceptedEn: e.accept }));
      return entries.length || !query?.trim() ? { entries } : { entries, note: `no glossary entry matches '${query}'; ${GLOSSARY.length} entries total` };
    },
  }),
];
