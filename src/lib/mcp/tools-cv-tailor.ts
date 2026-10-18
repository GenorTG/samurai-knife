import * as z from "zod/v4";
import { defineTool, type KnifeToolContext, type KnifeToolDefinition } from "./define";
import { CvCollectionError } from "@/lib/cv/collections";
import { atsForAccount, CvJobError, refreshCompany, suggestForJob } from "@/lib/cv/jobs/service";
import { setRewrites } from "@/lib/cv/rewrites";
import { CV_LANGS } from "@/lib/cv/schema";
import { addProjectFromGithub } from "@/lib/cv/showcase/service";
import { ShowcaseError } from "@/lib/cv/showcase/types";
import { loadCv, mutateCv } from "@/lib/cv/store";
import { wrapUntrustedOptional, wrapUntrustedStrings } from "@/lib/security/untrusted";

/**
 * CV studio "tailor" tools: everything the assistant needs to fit a CV version to one offer in a few calls, plus
 * per-version rewording, the ATS check and "add a project from a GitHub link". Evidence and checks only: no LLM here.
 */

function account(ctx: KnifeToolContext | undefined): string {
  if (!ctx?.accountId) throw new Error("CV tools need an account context.");
  return ctx.accountId;
}

async function surface<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CvJobError || error instanceof CvCollectionError || error instanceof ShowcaseError) throw new Error(error.message);
    throw error;
  }
}

const TEXT_CAP = 6_000;
const bi = z.object({ pl: z.string().max(4_000).optional(), en: z.string().max(4_000).optional() }).strict();

export const CV_TAILOR_TOOLS: KnifeToolDefinition[] = [
  defineTool({
    name: "knife_cv_tailor_context",
    scope: "account",
    effect: "read",
    untrustedOutput: true,
    description:
      "START HERE to tailor the CV for one saved offer: returns in one call the offer (title, company, requirement and nice-to-have lines, the board's skills with levels, seniority, workplace, salary, languages, the user's NOTES for this offer, an excerpt of the company website), the user's tailoring GUIDANCE (what to emphasise; follow it), every PINNED item (always include, list first), the ranked suggestion for a version (variant ready for knife_cv_variant_create) and the versions already made for this offer. Then: create the version, reword bullets for this offer with knife_cv_variant_rewrite (facts kept, the offer's vocabulary where it is TRUE), write headline + summary, run knife_cv_ats_check and fix what it lists. Default language: pl.",
    schema: z.object({ jobId: z.string().min(1).max(64), lang: z.enum(CV_LANGS).optional() }).strict(),
    run({ jobId, lang }, ctx) {
      return surface(() => {
        const id = account(ctx);
        const data = loadCv(id);
        const job = data.jobs.find((j) => j.id === jobId);
        if (!job) throw new CvJobError(`no job '${jobId}' (have: ${data.jobs.map((j) => j.id).join(", ") || "none"})`, 404);
        const l = lang ?? "pl";
        const p = data.profile;
        return {
          offer: {
            id: job.id,
            title: wrapUntrustedOptional(`job posting ${job.url || "(pasted text)"}`, job.title),
            company: wrapUntrustedOptional(`job posting ${job.url || "(pasted text)"}`, job.company),
            location: wrapUntrustedOptional(`job posting ${job.url || "(pasted text)"}`, job.location),
            url: job.url, lang: job.lang,
            seniority: wrapUntrustedOptional(`job posting ${job.url || "(pasted text)"}`, job.seniority),
            workplace: wrapUntrustedOptional(`job posting ${job.url || "(pasted text)"}`, job.workplace),
            salary: wrapUntrustedStrings(`job posting ${job.url || "(pasted text)"}`, job.salary),
            languages: wrapUntrustedStrings(`job posting ${job.url || "(pasted text)"}`, job.languages),
            applyUrl: job.applyUrl,
            requirements: wrapUntrustedStrings(`job posting ${job.url || "(pasted text)"}`, job.requirements),
            niceToHave: wrapUntrustedStrings(`job posting ${job.url || "(pasted text)"}`, job.niceToHave),
            skills: wrapUntrustedStrings(`job posting ${job.url || "(pasted text)"}`, job.skills),
            notes: job.notes, companyUrl: job.companyUrl, companyExcerpt: wrapUntrustedOptional(`company website ${job.companyUrl}`, job.companyText.slice(0, 1_500)),
            text: wrapUntrustedOptional(`job posting ${job.url || "(pasted text)"}`, job.text.slice(0, TEXT_CAP)), textTruncated: job.text.length > TEXT_CAP,
          },
          guidance: p.guidance,
          pinned: {
            experience: p.experience.filter((e) => e.pinned).map((e) => e.id),
            bullets: p.experience.flatMap((e) => e.bullets.filter((b) => b.pinned).map((b) => `/experience/id=${e.id}/bullets/id=${b.id}`)),
            projects: p.projects.filter((x) => x.pinned).map((x) => x.id),
            skillGroups: p.skills.filter((g) => g.pinned).map((g) => g.id),
            customSections: p.customSections.filter((c) => c.pinned).map((c) => c.id),
          },
          customSections: p.customSections.map((c) => ({ id: c.id, title: c.title, items: c.items.length, pinned: c.pinned })),
          profileSectionOrder: p.sectionOrder,
          suggestion: suggestForJob(id, jobId, l),
          existingVersions: data.variants.filter((v) => v.jobId === jobId).map((v) => ({ id: v.id, name: v.name, lang: v.lang, rewrites: v.rewrites.length })),
          priorities: "Keep every pinned item and list pinned projects first; follow `guidance`. knife_cv_variant_create returns warnings when a version breaks them.",
          rules: "Truthful only: reword, reorder, select and use the offer's terms for things the profile really shows. Never add employers, dates, numbers, skills or achievements the profile lacks; gaps stay gaps (ask the user).",
        };
      });
    },
  }),
  defineTool({
    name: "knife_cv_variant_rewrite",
    scope: "account",
    effect: "write",
    description:
      "Reword texts for ONE CV version only (the master profile is untouched): set: [{path, text:{pl?,en?}}] where path is a bullet text (/experience/id=x/bullets/id=y/text or /projects/id=p/bullets/id=b/text), a project summary (/projects/id=p/summary), an experience note (/experience/id=x/note) or a custom item text (/customSections/id=s/items/id=i/text); an omitted/empty language keeps the master text. remove: [path] restores the master wording. Use it to put the offer's vocabulary and the most relevant facts first, for things the profile REALLY shows. `warnings` lists facts the new wording dropped or added that the profile does not contain: fix every one (restore, or remove the invention).",
    schema: z.object({
      variantId: z.string().min(1).max(64),
      set: z.array(z.object({ path: z.string().min(1).max(300), text: bi }).strict()).max(60).default([]),
      remove: z.array(z.string().max(300)).max(60).default([]),
    }).strict(),
    run({ variantId, set, remove }, ctx) {
      return surface(() => {
        const { data, result } = mutateCv(account(ctx), (current) => {
          const out = setRewrites(current, variantId, set, remove);
          return { data: out.data, result: out };
        });
        return { variantId, revision: data.revision, rewrites: result.variant.rewrites.length, warnings: result.warnings };
      });
    },
  }),
  defineTool({
    name: "knife_cv_ats_check",
    scope: "account",
    effect: "read",
    untrustedOutput: true,
    description:
      "ATS check of what a CV version PRINTS against its offer: score 0-100 (a guide), required/nice keyword coverage, each posting keyword as present / dropped (the user has it, this version leaves it out: bring it back) / missing (a real gap: never invent it), offer spellings the version writes differently (use the offer's spelling once, if true), structural checks (contact, headline, summary, dates, length, RODO clause, languages, years asked vs dated roles, the user's pinned priorities), `fixable` (what you can still fix truthfully) and `gaps` (to report, never to add). Run it after your edits, fix `fixable`, run it once more, then stop: re-running without changes returns the same result. Pass variantId (its offer and language), or jobId (+lang) to check the master profile.",
    schema: z.object({
      variantId: z.string().max(64).optional(), jobId: z.string().max(64).optional(), lang: z.enum(CV_LANGS).optional(),
      includePrinted: z.boolean().optional().describe("Also return `printed`, the plain text an ATS reads (long)."),
    }).strict(),
    run({ includePrinted, ...input }, ctx) {
      return surface(() => {
        if (!input.variantId && !input.jobId) throw new CvJobError("pass variantId or jobId.", 422);
        const { printed, ...report } = atsForAccount(account(ctx), input);
        return wrapUntrustedStrings("job-posting-derived ATS comparison", {
          ...report,
          ...(includePrinted ? { printed } : {}),
          next: report.fixable.length
            ? "Fix the `fixable` items (truthfully), then run this check ONCE more."
            : "Nothing left to fix in this version. Do not run the check again: tell the user the score, the `gaps` (things the offer asks for that are not in their profile) and what you changed.",
        });
      });
    },
  }),
  defineTool({
    name: "knife_cv_job_company",
    scope: "account",
    effect: "outbound",
    urlArgs: ["url"],
    untrustedOutput: true,
    description: "(Re)read the company website of a saved offer as tailoring context (one page, SSRF-guarded); `url` replaces the saved website. Returns the text excerpt. Use it to name the company's domain truthfully in the summary; never invent a connection.",
    schema: z.object({ jobId: z.string().min(1).max(64), url: z.string().max(2_000).optional() }).strict(),
    run({ jobId, url }, ctx) {
      return surface(async () => {
        const res = await refreshCompany(account(ctx), jobId, url);
        return { jobId, companyUrl: res.job.companyUrl, revision: res.revision, note: res.note, excerpt: wrapUntrustedOptional(`company website ${res.job.companyUrl}`, res.job.companyText.slice(0, 3_000)) };
      });
    },
  }),
  defineTool({
    name: "knife_cv_project_from_github",
    scope: "admin",
    effect: "write",
    untrustedOutput: true,
    description:
      "Add a project to the master CV from a GitHub link (https://github.com/owner/name or owner/name; uses the host's authenticated `gh`). A new project is a draft with name, link, technologies (languages, topics, known dependencies) and the repo description; a project already linked to the repo only gets technologies merged (the user's wording is kept). pinned:true marks it as a priority item. Returns `facts` (README excerpt, commits, dates, stars, tests/CI…): then write summary {pl,en} and 2-4 bullets with knife_cv_patch FROM THESE FACTS ONLY (no invented users, numbers or features).",
    schema: z.object({ repo: z.string().min(1).max(300), pinned: z.boolean().optional() }).strict(),
    run({ repo, pinned }, ctx) {
      return surface(async () => {
        const res = await addProjectFromGithub(account(ctx), repo, pinned ?? false);
        return { ...res, facts: { ...res.facts, ...(typeof res.facts.readmeExcerpt === "string" ? { readmeExcerpt: wrapUntrustedOptional(`GitHub README of ${repo}`, res.facts.readmeExcerpt) } : {}) }, path: `/projects/id=${res.project.id}`, next: `Write /projects/id=${res.project.id}/summary ({pl,en}) and bullets (add to /projects/id=${res.project.id}/bullets/-, each {id, text:{pl,en}}) with knife_cv_patch, from the returned facts only.` };
      });
    },
  }),
];
