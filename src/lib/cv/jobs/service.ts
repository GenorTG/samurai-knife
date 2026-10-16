// SERVER ONLY. Shared by the `knife_cv_job_*` tools and the /api/cv/jobs|variants routes.
import { CvCollectionError } from "../collections";
import type { CvLang, Job, Profile } from "../schema";
import { loadCv, mutateCv } from "../store";
import { fetchPageText, fetchPosting, FetchError } from "./fetch";
import { jobForMatching, match, type MatchReport } from "./match";
import { applyFetchedJob, type JobHints } from "./save";
import { classifyInput } from "./posting";
import { suggestVariant, type Suggestion } from "./tailor";
import { atsCheck, printedText, type AtsReport } from "./ats";
import { resolveVariant } from "../variant";
import { getAccount } from "@/lib/accounts/store";
import { consumeOutbound, outboundLimitMessage } from "@/lib/net/outbound";

/** A domain failure with the HTTP status a route should answer (the tools just surface the message). */
export class CvJobError extends Error {
  constructor(message: string, readonly status: 404 | 422 | 429) {
    super(message);
  }
}

export interface SavedPosting {
  job: Job;
  refreshed: boolean;
  revision: number;
  /** "jsonld" | "html" | "paste" | "justjoin": how the text was obtained */
  extracted: string;
  /** Why the company website could not be read ("" = read, or none given). Never fails the save. */
  companyNote: string;
}

/** Every page fetch counts against the account's outbound budget (public mode, non-admins: `src/lib/net/outbound.ts`). */
function spendFetch(accountId: string): void {
  const account = getAccount(accountId);
  if (!account) throw new CvJobError("unknown account", 404);
  const budget = consumeOutbound(account, "page");
  if (!budget.ok) throw new CvJobError(outboundLimitMessage(budget.retryAfterSeconds), 429);
}

function isUrlInput(urlOrText: string): boolean {
  try {
    return classifyInput(urlOrText).kind === "url";
  } catch {
    return false; // fetchPosting reports the problem
  }
}

/** Read a company website for context; a failure is a note, not an error (the offer still saves). */
async function companyContext(url: string): Promise<{ text?: string; note: string }> {
  try {
    const page = await fetchPageText(url);
    if (!page.text.trim()) return { text: "", note: `${page.url} has no readable text (a JavaScript-only site?).` };
    return { text: [page.title, page.text].filter(Boolean).join("\n\n"), note: "" };
  } catch (error) {
    return { note: `could not read the company website: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function fetchAndSaveJob(accountId: string, urlOrText: string, hints: JobHints): Promise<SavedPosting> {
  if (isUrlInput(urlOrText)) spendFetch(accountId);
  let got;
  try {
    got = await fetchPosting(urlOrText);
  } catch (error) {
    if (error instanceof FetchError) throw new CvJobError(error.message, 422);
    throw error;
  }
  // The user's company site wins; else the board's (justjoin.it states it). Read only when there is no text yet.
  const existing = got.url ? loadCv(accountId).jobs.find((j) => j.url === got.url) : undefined;
  const companyUrl = hints.companyUrl?.trim() || existing?.companyUrl || got.extra?.companyUrl || "";
  let companyNote = "";
  if (companyUrl && (hints.companyUrl?.trim() || !existing?.companyText)) {
    spendFetch(accountId);
    const ctx = await companyContext(companyUrl);
    companyNote = ctx.note;
    if (ctx.text !== undefined) hints = { ...hints, companyText: ctx.text };
  }
  try {
    const { data, result } = mutateCv(accountId, (current) => {
      const saved = applyFetchedJob(current, got, hints);
      return { data: saved.data, result: saved };
    });
    return { job: result.job, refreshed: result.refreshed, revision: data.revision, extracted: got.source, companyNote };
  } catch (error) {
    if (error instanceof CvCollectionError) throw new CvJobError(error.message, 422);
    throw error;
  }
}

function jobAndProfile(accountId: string, jobId: string): { job: Job; profile: Profile } {
  const data = loadCv(accountId);
  const job = data.jobs.find((j) => j.id === jobId);
  if (!job) throw new CvJobError(`no job '${jobId}' (have: ${data.jobs.map((j) => j.id).join(", ") || "none"})`, 404);
  const p = data.profile;
  if (!(p.experience.length || p.projects.length || p.skills.length || p.summary.pl || p.summary.en)) {
    throw new CvJobError("the CV profile is empty: import it first (knife_cv_import).", 422);
  }
  return { job, profile: p };
}

export function matchJob(accountId: string, jobId: string, lang: CvLang): MatchReport {
  const { job, profile } = jobAndProfile(accountId, jobId);
  return match(profile, jobForMatching(job), lang);
}

export function suggestForJob(accountId: string, jobId: string, lang: CvLang, maxBulletsPerRole?: number): Suggestion {
  const { job, profile } = jobAndProfile(accountId, jobId);
  return suggestVariant(profile, jobForMatching(job), lang, maxBulletsPerRole);
}

/** (Re)read the company website of a saved job (`url` replaces the saved one). */
export async function refreshCompany(accountId: string, jobId: string, url?: string): Promise<{ job: Job; revision: number; note: string }> {
  const job = loadCv(accountId).jobs.find((j) => j.id === jobId);
  if (!job) throw new CvJobError(`no job '${jobId}'`, 404);
  const target = url?.trim() || job.companyUrl;
  if (!target) throw new CvJobError("this offer has no company website: pass one.", 422);
  spendFetch(accountId);
  const ctx = await companyContext(target);
  const { data, result } = mutateCv(accountId, (current) => {
    const next = current.jobs.map((j) => (j.id === jobId ? { ...j, companyUrl: target.slice(0, 2_000), companyText: (ctx.text ?? j.companyText).slice(0, 20_000) } : j));
    return { data: { ...current, jobs: next }, result: next.find((j) => j.id === jobId)! };
  });
  return { job: result, revision: data.revision, note: ctx.note };
}

/**
 * ATS check of a saved version (its job and language), or of the master profile against a job when no version is
 * given. The version must be linked to an offer (variant.jobId) unless `jobId` is passed.
 */
export function atsForAccount(accountId: string, input: { variantId?: string; jobId?: string; lang?: CvLang }): AtsReport & { variantId: string | null; printed: string } {
  const data = loadCv(accountId);
  const variant = input.variantId ? data.variants.find((v) => v.id === input.variantId) : undefined;
  if (input.variantId && !variant) throw new CvJobError(`no variant '${input.variantId}' (have: ${data.variants.map((v) => v.id).join(", ") || "none"})`, 404);
  const jobId = input.jobId ?? variant?.jobId ?? null;
  if (!jobId) throw new CvJobError("this version is not linked to an offer: pass jobId.", 422);
  const job = data.jobs.find((j) => j.id === jobId);
  if (!job) throw new CvJobError(`no job '${jobId}'`, 404);
  const lang = input.lang ?? variant?.lang ?? "pl";
  const version = variant ? resolveVariant(data.profile, variant) : data.profile;
  return { ...atsCheck(data.profile, version, job, lang, new Date(), variant), variantId: variant?.id ?? null, printed: printedText(version, lang) };
}
