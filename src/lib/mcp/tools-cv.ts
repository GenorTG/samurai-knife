import * as z from "zod/v4";
import { defineTool, type KnifeToolContext, type KnifeToolDefinition } from "./define";
import { CV_JOBS_TOOLS } from "./tools-cv-jobs";
import { CV_RENDER_TOOLS } from "./tools-cv-render";
import { CV_SHOWCASE_TOOLS } from "./tools-cv-showcase";
import { CV_TEXT_TOOLS } from "./tools-cv-text";
import { CvCollectionError, dueApplications, removeApplication, summarizeApplication, removeJob, removeVariant, todayIso, upsertApplication, upsertJob, upsertVariant } from "@/lib/cv/collections";
import { applyOps, CvOpError, missingTranslations, readPath } from "@/lib/cv/ops";
import { CvImportError, importProfile } from "@/lib/cv/import";
import { APPLICATION_STATUSES, CV_LANGS, type CvData } from "@/lib/cv/schema";
import { loadCv, mutateCv, undoCv } from "@/lib/cv/store";
import { factWarnings } from "@/lib/cv/text/guard";
import { rewriteWarningsFor } from "@/lib/cv/rewrites";
import { priorityWarnings } from "@/lib/cv/priorities";
import { CV_TAILOR_TOOLS } from "./tools-cv-tailor";

/**
 * CV studio tools. Principle: tools gather evidence and apply deterministic checks; the model (the widget's own
 * provider) writes the prose. Nothing here calls an LLM. All tools are scoped to the calling account.
 */

function account(ctx: KnifeToolContext | undefined): string {
  if (!ctx?.accountId) throw new Error("CV tools need an account context.");
  return ctx.accountId;
}

const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), path: z.string().min(1).max(300), value: z.unknown() }).strict(),
  z.object({ op: z.literal("add"), path: z.string().min(1).max(300), value: z.unknown() }).strict(),
  z.object({ op: z.literal("remove"), path: z.string().min(1).max(300) }).strict(),
]);

const CORE_CV_TOOLS: KnifeToolDefinition[] = [
  defineTool({
    name: "knife_cv_get",
    scope: "account",
    effect: "read",
    description:
      "Read the user's master CV profile (bilingual PL/EN) or one part of it. path is JSON-pointer-like, e.g. '/experience/id=rentiers' or '/summary'; '/' = whole profile. Always read before editing.",
    schema: z.object({ path: z.string().max(300).optional() }).strict(),
    run({ path }, ctx) {
      const profile = loadCv(account(ctx)).profile;
      try {
        return readPath(profile, path ?? "/");
      } catch (error) {
        if (error instanceof CvOpError) throw new Error(error.message);
        throw error;
      }
    },
  }),
  defineTool({
    name: "knife_cv_patch",
    scope: "account",
    effect: "write",
    description:
      "Edit the master CV profile atomically. ops: [{op:'set'|'add'|'remove', path, value}]. Paths address list items by id: /experience/id=rentiers/bullets/id=b2/text/en ; append with .../bullets/-. The user sees changes live and can undo. Never invent facts: keep numbers, names, technologies and qualifiers. If the result has `warnings`, your new text dropped a number, URL, email, version or name from the old text: restore it (or tell the user why it was removed).",
    schema: z.object({ ops: z.array(opSchema).min(1).max(40) }).strict(),
    run({ ops }, ctx) {
      const id = account(ctx);
      try {
        const { data, result } = mutateCv(id, (current) => {
          const applied = applyOps(current.profile, ops);
          return { data: { ...current, profile: applied.profile }, result: applied.changes };
        });
        return { applied: result.length, revision: data.revision, paths: result.map((c) => c.path), changes: result, warnings: factWarnings(result) };
      } catch (error) {
        if (error instanceof CvOpError) throw new Error(error.message);
        throw error;
      }
    },
  }),
  defineTool({
    name: "knife_cv_missing",
    scope: "account",
    effect: "read",
    description: "List profile text fields written in the other language but empty in `lang` (the translation backlog).",
    schema: z.object({ lang: z.enum(CV_LANGS) }).strict(),
    run({ lang }, ctx) {
      return { untranslated: missingTranslations(loadCv(account(ctx)).profile, lang) };
    },
  }),
  defineTool({
    name: "knife_cv_import",
    scope: "account",
    effect: "write",
    destructiveWhen: [{ arg: "overwrite", when: "true" }],
    description:
      "Load a COMPLETE master profile you structured from the user's pasted CV (same shape knife_cv_get returns: contact, summary, experience[], projects[], skills[], education[], languages[], consent, extras; every text field {pl,en}, every list item has a lowercase id). Refuses to replace an existing profile unless overwrite=true. Copy facts faithfully; leave the other language empty rather than inventing it, then translate with knife_cv_patch.",
    schema: z.object({ profile: z.record(z.string(), z.unknown()), overwrite: z.boolean().optional() }).strict(),
    run({ profile, overwrite }, ctx) {
      try {
        const { data, replaced } = importProfile(account(ctx), profile, overwrite === true);
        return { imported: true, replaced, revision: data.revision };
      } catch (error) {
        if (error instanceof CvImportError) throw new Error(error.message);
        throw error;
      }
    },
  }),
  defineTool({
    name: "knife_cv_undo",
    scope: "account",
    effect: "write",
    description: "Revert the last CV data change (profile, variants, jobs or applications).",
    schema: z.object({}).strict(),
    run(_input, ctx) {
      if (!undoCv(account(ctx))) throw new Error("Nothing to undo.");
      return { undone: true, revision: loadCv(account(ctx)).revision };
    },
  }),
  defineTool({
    name: "knife_cv_job_list",
    scope: "account",
    effect: "read",
    description: "List the user's saved job offers (id, company, title, url, language, whether requirements were saved) and, for each, whether it was applied to: `application` = {id, status, appliedOn} or null.",
    schema: z.object({}).strict(),
    run(_input, ctx) {
      const data = loadCv(account(ctx));
      return data.jobs.map((j) => {
        const app = data.applications.find((a) => a.jobId === j.id);
        return { id: j.id, company: j.company, title: j.title, url: j.url, lang: j.lang, location: j.location, requirements: j.requirements.length, savedAt: j.savedAt, application: app ? { id: app.id, status: app.status, appliedOn: app.appliedOn } : null };
      });
    },
  }),
  defineTool({
    name: "knife_cv_job_save",
    scope: "account",
    effect: "write",
    description: "Create or update a saved job offer. Use it to store a link (url) and/or pasted posting text, and to save the requirement / nice-to-have lines you extracted so matching is sharp. Without id it ALWAYS creates a new offer (a second one if the company and title already exist): call knife_cv_job_list first and pass the existing id to update. Returns the job id.",
    schema: z.object({
      id: z.string().max(64).optional(), url: z.string().max(2_000).optional(), title: z.string().max(300).optional(), company: z.string().max(300).optional(),
      location: z.string().max(300).optional(), text: z.string().max(120_000).optional(), requirements: z.array(z.string().max(500)).max(80).optional(),
      niceToHave: z.array(z.string().max(500)).max(80).optional(), lang: z.enum(["pl", "en", "unknown"]).optional(),
      companyUrl: z.string().max(2_000).optional().describe("The company's website (read it with knife_cv_job_company)."),
      notes: z.string().max(20_000).optional().describe("The user's own notes for this offer; REPLACES the saved notes, so append to what knife_cv_tailor_context returned."),
      seniority: z.string().max(60).optional(), workplace: z.string().max(60).optional(), salary: z.string().max(300).optional(),
      languages: z.array(z.string().max(60)).max(10).optional(),
    }).strict(),
    run(input, ctx) {
      const { data, result } = withData(account(ctx), (current) => {
        // a new offer records where it came from; an update keeps its source (e.g. justjoin)
        const source = input.id && current.jobs.some((j) => j.id === input.id) ? {} : { source: input.url && !input.text ? "url" : "paste" };
        const { data: next, job } = upsertJob(current, { ...input, ...source });
        return { data: next, result: job };
      });
      return { id: result.id, revision: data.revision, company: result.company, title: result.title };
    },
  }),
  defineTool({
    name: "knife_cv_job_delete",
    scope: "account",
    effect: "destructive",
    description: "Delete a saved job offer (applications that referenced it keep their record, unlinked).",
    schema: z.object({ id: z.string().min(1).max(64) }).strict(),
    run({ id }, ctx) {
      const { data } = withData(account(ctx), (current) => ({ data: removeJob(current, id), result: null }));
      return { removed: id, revision: data.revision };
    },
  }),
  defineTool({
    name: "knife_cv_variant_list",
    scope: "account",
    effect: "read",
    description: "List saved per-job CV versions (variants).",
    schema: z.object({}).strict(),
    run(_input, ctx) {
      return loadCv(account(ctx)).variants.map((v) => ({ id: v.id, name: v.name, lang: v.lang, target: v.target, jobId: v.jobId }));
    },
  }),
  defineTool({
    name: "knife_cv_variant_get",
    scope: "account",
    effect: "read",
    description: "Read one CV version (which roles/bullets/projects/skill groups, in what order, overrides).",
    schema: z.object({ id: z.string().min(1).max(64) }).strict(),
    run({ id }, ctx) {
      const variant = loadCv(account(ctx)).variants.find((v) => v.id === id);
      if (!variant) throw new Error(`No variant '${id}'.`);
      return variant;
    },
  }),
  defineTool({
    name: "knife_cv_variant_create",
    scope: "account",
    effect: "write",
    description: "Create or update a per-job CV version: which experience entries and bullets (by id, in order), projects, skill groups, custom sections, the section print order (sectionOrder, e.g. ['summary','projects','experience','skills','education','languages']), optional headline/summary overrides ({pl,en}) and per-version rewrites [{path, text:{pl,en}}] of bullet texts / project summaries (see knife_cv_variant_rewrite). null/omitted = keep all / profile order. Updating an existing id merges: omitted fields keep their saved value. Ids are validated against the profile; the error lists the valid ones. Never add content that is not in the profile or confirmed by the user; `warnings` lists facts a rewrite dropped or invented and the user's pinned priorities the version breaks: fix every one.",
    schema: z.object({
      id: z.string().min(1).max(64), name: z.string().min(1).max(200), lang: z.enum(CV_LANGS).optional(), target: z.string().max(300).optional(), jobId: z.string().max(64).nullable().optional(),
      headline: z.object({ pl: z.string(), en: z.string() }).nullable().optional(), summary: z.object({ pl: z.string(), en: z.string() }).nullable().optional(),
      experience: z.array(z.object({ id: z.string(), bulletIds: z.array(z.string()).nullable().optional() })).nullable().optional(),
      projectIds: z.array(z.string()).nullable().optional(), skillGroupIds: z.array(z.string()).nullable().optional(), notes: z.string().max(4_000).optional(),
      customSectionIds: z.array(z.string()).nullable().optional(), sectionOrder: z.array(z.string()).nullable().optional(),
      rewrites: z.array(z.object({ path: z.string().max(300), text: z.object({ pl: z.string().max(4_000), en: z.string().max(4_000) }) })).max(200).optional(),
    }).strict(),
    run(input, ctx) {
      const { data, result } = withData(account(ctx), (current) => {
        const { data: next, variant } = upsertVariant(current, input);
        return { data: next, result: { variant, warnings: [...rewriteWarningsFor(current, input.rewrites ?? []), ...priorityWarnings(current.profile, variant)] } };
      });
      const v = result.variant;
      const todo = v.jobId && (v.headline === null || v.summary === null)
        ? `This version still uses the profile's ${[v.headline === null ? "headline" : "", v.summary === null ? "summary" : ""].filter(Boolean).join(" and ")}: write ${v.headline === null && v.summary === null ? "them" : "it"} for this offer (from profile facts only) and save with knife_cv_variant_create.`
        : "";
      return { id: v.id, revision: data.revision, warnings: result.warnings, ...(todo ? { todo } : {}) };
    },
  }),
  defineTool({
    name: "knife_cv_variant_delete",
    scope: "account",
    effect: "destructive",
    description: "Delete a CV version.",
    schema: z.object({ id: z.string().min(1).max(64) }).strict(),
    run({ id }, ctx) {
      const { data } = withData(account(ctx), (current) => ({ data: removeVariant(current, id), result: null }));
      return { removed: id, revision: data.revision };
    },
  }),
  defineTool({
    name: "knife_cv_app_list",
    scope: "account",
    effect: "read",
    description:
      "List tracked job applications as the user's pipeline. Each item: status, appliedOn (the day it was sent), daysSinceApplied, open / inProgress flags, next action + due date, overdue, closedOn. Filters: status; open=true (wishlist + applied + screening + interview) or open=false (offer, rejected, withdrawn, ghosted). Sorted by appliedOn (oldest first, so the longest-waiting come first) unless sort='due'. Also returns today's date and counts (open, inProgress, overdue, per status). Use it to answer 'which applications are still open / what did I apply to when'.",
    schema: z.object({ status: z.enum(APPLICATION_STATUSES).optional(), open: z.boolean().optional(), sort: z.enum(["applied", "due"]).optional() }).strict(),
    run({ status, open, sort }, ctx) {
      const today = todayIso();
      const all = loadCv(account(ctx)).applications.map((a) => summarizeApplication(a, today));
      const items = all
        .filter((a) => (!status || a.status === status) && (open === undefined || a.open === open))
        .sort((x, y) => (sort === "due" ? (x.nextActionDue ?? "9999").localeCompare(y.nextActionDue ?? "9999") : (x.appliedOn ?? "9999").localeCompare(y.appliedOn ?? "9999")));
      const perStatus: Record<string, number> = {};
      for (const a of all) perStatus[a.status] = (perStatus[a.status] ?? 0) + 1;
      return { today, counts: { total: all.length, open: all.filter((a) => a.open).length, inProgress: all.filter((a) => a.inProgress).length, overdue: all.filter((a) => a.overdue).length, perStatus }, applications: items };
    },
  }),
  defineTool({
    name: "knife_cv_app_save",
    scope: "account",
    effect: "write",
    description: "Track a job application: create (company + role required) or update by id. Without id it ALWAYS creates a new row (a second one for the same company and role): call knife_cv_app_list first and pass the existing id to update. Link the offer (jobId), the CV version sent (variantId), the posting url, next action and its due date (YYYY-MM-DD). appliedOn (YYYY-MM-DD) is the day it was sent: it is set to today automatically when the status becomes 'applied'; pass it explicitly to record an earlier date. A status change is logged with today's date; `note` explains it. Statuses: wishlist, applied, screening, interview, offer, rejected, withdrawn, ghosted.",
    schema: z.object({
      id: z.string().max(64).optional(), company: z.string().max(300).optional(), role: z.string().max(300).optional(), status: z.enum(APPLICATION_STATUSES).optional(),
      url: z.string().max(2_000).optional(), jobId: z.string().max(64).nullable().optional(), variantId: z.string().max(64).nullable().optional(), lang: z.enum(CV_LANGS).optional(),
      nextAction: z.string().max(500).optional(), nextActionDue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), appliedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), notes: z.string().max(4_000).optional(), note: z.string().max(500).optional(),
    }).strict(),
    run({ note, ...fields }, ctx) {
      const { data, result } = withData(account(ctx), (current) => {
        const existing = fields.id ? current.applications.find((a) => a.id === fields.id) : undefined;
        if (!existing && (!fields.company || !fields.role)) throw new Error("A new application needs company and role.");
        const { data: next, application } = upsertApplication(current, fields, note ?? "");
        return { data: next, result: application };
      });
      return { id: result.id, status: result.status, appliedOn: result.appliedOn, revision: data.revision, history: result.history };
    },
  }),
  defineTool({
    name: "knife_cv_app_delete",
    scope: "account",
    effect: "destructive",
    description: "Delete a tracked application.",
    schema: z.object({ id: z.string().min(1).max(64) }).strict(),
    run({ id }, ctx) {
      const { data } = withData(account(ctx), (current) => ({ data: removeApplication(current, id), result: null }));
      return { removed: id, revision: data.revision };
    },
  }),
  defineTool({
    name: "knife_cv_app_due",
    scope: "account",
    effect: "read",
    description: "Open applications whose follow-up / next action is due (today's date is returned). withinDays=0 means due today or overdue.",
    schema: z.object({ withinDays: z.number().int().min(0).max(60).optional() }).strict(),
    run({ withinDays }, ctx) {
      const today = todayIso();
      return { today, due: dueApplications(loadCv(account(ctx)).applications, today, withinDays ?? 0).map((a) => summarizeApplication(a, today)) };
    },
  }),
];

/** Run a data mutation and translate collection errors into plain tool errors (the model reads them). */
function withData<T>(accountId: string, fn: (data: CvData) => { data: CvData; result: T }): { data: CvData; result: T } {
  try {
    return mutateCv(accountId, fn);
  } catch (error) {
    if (error instanceof CvCollectionError) throw new Error(error.message);
    throw error;
  }
}

export const CV_KNIFE_TOOLS: KnifeToolDefinition[] = [...CORE_CV_TOOLS, ...CV_TEXT_TOOLS, ...CV_JOBS_TOOLS, ...CV_SHOWCASE_TOOLS, ...CV_RENDER_TOOLS, ...CV_TAILOR_TOOLS];
