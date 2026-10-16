import * as z from "zod/v4";
import { defineTool, type KnifeToolContext, type KnifeToolDefinition } from "./define";
import { boardLinks } from "@/lib/cv/jobs/boards";
import { CvJobError, fetchAndSaveJob, matchJob, suggestForJob } from "@/lib/cv/jobs/service";
import { CV_LANGS } from "@/lib/cv/schema";

/** CV studio `knife_cv_*` tools for the "jobs" lane. Evidence and deterministic checks only: no LLM calls. */

const MAX_TEXT_RETURNED = 12_000;

function account(ctx: KnifeToolContext | undefined): string {
  if (!ctx?.accountId) throw new Error("CV tools need an account context.");
  return ctx.accountId;
}

/** Tool errors are plain messages the model reads. */
async function surface<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CvJobError) throw new Error(error.message);
    throw error;
  }
}

export const CV_JOBS_TOOLS: KnifeToolDefinition[] = [
  defineTool({
    name: "knife_cv_job_fetch",
    scope: "account",
    description:
      "Read ONE job posting and save it: pass a posting URL (justjoin.it and nofluffjobs.com offer links are read through the board's own offer data: description, requirement lines, skills (with levels on justjoin.it), seniority, salary, languages, company site; pracuj.pl and LinkedIn block servers, so ask for the pasted text there) (http/https; fetched server-side, one page, loopback/private/Tailscale addresses are refused) or the pasted posting text. Returns the saved job id, language, structured fields (title, company, location) and the posting text. Re-fetching a saved URL refreshes that job instead of duplicating it. If the page is empty (JavaScript-rendered or login-walled) or a listing page, the error says so: ask the user to paste the posting and call again with the text. title/company override what the page says. Afterwards read the text and call knife_cv_job_save with the requirement and nice-to-have lines so matching is sharp. Search/listing pages are not scraped.",
    schema: z.object({
      urlOrText: z.string().min(1).max(200_000), title: z.string().max(300).optional(), company: z.string().max(300).optional(),
      companyUrl: z.string().max(2_000).optional().describe("The company's own website, if the user gave one: read once as context."),
      notes: z.string().max(20_000).optional().describe("The user's notes for this offer (pasted details, what matters)."),
    }).strict(),
    run({ urlOrText, ...hints }, ctx) {
      return surface(async () => {
        const saved = await fetchAndSaveJob(account(ctx), urlOrText, hints);
        const { job } = saved;
        return {
          id: job.id,
          refreshed: saved.refreshed,
          revision: saved.revision,
          source: job.source,
          extracted: saved.extracted,
          url: job.url,
          title: job.title,
          company: job.company,
          location: job.location,
          lang: job.lang,
          requirementsSaved: job.requirements.length,
          requirementLines: job.requirements.slice(0, 20),
          niceToHave: job.niceToHave.slice(0, 20),
          skills: job.skills,
          seniority: job.seniority,
          workplace: job.workplace,
          salary: job.salary,
          companyUrl: job.companyUrl,
          companyNote: saved.companyNote,
          text: job.text.slice(0, MAX_TEXT_RETURNED),
          textTruncated: job.text.length > MAX_TEXT_RETURNED,
          next: `Read the text; if the saved requirement/nice-to-have lines are missing or wrong, call knife_cv_job_save with id '${job.id}' and corrected lines${job.title && job.company ? "" : ", plus the missing title/company"}. To tailor the CV: knife_cv_tailor_context {jobId:'${job.id}'}.`,
        };
      });
    },
  }),
  defineTool({
    name: "knife_cv_job_match",
    scope: "account",
    description:
      "Deterministic profile<->job comparison in `lang`: requirementCoveragePct (share of saved requirement lines with profile evidence) and techCoveragePct (tech-dictionary terms only) are the numbers to trust; coveragePct (all terms) is noisy, matched terms each with evidence (profile id-paths readable with knife_cv_get), missing terms, missingRequired (missing terms from the saved requirement lines) and requirementHits (best evidence per requirement line). Missing terms are GAPS in the user's profile: never claim, add or invent them; say so honestly or ask the user whether they really have the experience. Works best after knife_cv_job_save stored the requirement lines.",
    schema: z.object({ jobId: z.string().min(1).max(64), lang: z.enum(CV_LANGS) }).strict(),
    run({ jobId, lang }, ctx) {
      return surface(() => matchJob(account(ctx), jobId, lang));
    },
  }),
  defineTool({
    name: "knife_cv_variant_suggest",
    scope: "account",
    description:
      "Propose (NOT save) a per-job CV version: roles and bullets ranked by evidence for this job (required terms weigh 3, nice-to-have 2, posting prose 1), projects and skill groups that match, bulletScores with the terms behind each pick and whether a bullet still needs translation into `lang`. The `variant` field is ready for knife_cv_variant_create after you adjust it and write the headline/summary prose from existing profile facts only. Missing required terms are gaps: never fabricate them. maxBulletsPerRole defaults to 4.",
    schema: z.object({ jobId: z.string().min(1).max(64), lang: z.enum(CV_LANGS), maxBulletsPerRole: z.number().int().min(1).max(12).optional() }).strict(),
    run({ jobId, lang, maxBulletsPerRole }, ctx) {
      return surface(() => ({
        saved: false,
        ...suggestForJob(account(ctx), jobId, lang, maxBulletsPerRole),
        next: "Review the picks, write headline/summary ({pl,en}) from profile facts only, then call knife_cv_variant_create with this variant (it validates every id).",
      }));
    },
  }),
  defineTool({
    name: "knife_cv_job_board_links",
    scope: "account",
    description:
      "Search links for Polish/EU job boards (pracuj.pl, justjoin.it, NoFluffJobs via a site: search, LinkedIn, Indeed PL) for a query. LINKS ONLY, best-effort URL formats: the app never scrapes boards. Give them to the user to open; when they paste a posting URL or text, call knife_cv_job_fetch.",
    schema: z.object({ query: z.string().min(1).max(200), location: z.string().max(100).optional(), remote: z.boolean().optional() }).strict(),
    run({ query, location, remote }) {
      return { links: boardLinks(query, location ?? "", remote ?? false), note: "Boards are not scraped. Open a link, pick a posting, then paste its URL or text." };
    },
  }),
];
