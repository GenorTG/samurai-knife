import { upsertJob } from "../collections";
import type { CvData, Job } from "../schema";
import type { FetchedPosting } from "./posting";

/** Pure: merge a fetched / pasted posting into the saved jobs (new job, or refresh when the same URL is already saved). */

export interface JobHints {
  title?: string;
  company?: string;
  /** The company's website, given by the user (wins over the board's). */
  companyUrl?: string;
  /** Readable text of the company website, when it was fetched. */
  companyText?: string;
  /** The user's notes for this offer (pasted details, recruiter call…). Replaces the saved notes when given. */
  notes?: string;
}

const MAX_REQUIREMENTS = 80;
const MAX_LINE = 500;

/** Trim, dedupe and bound requirement lines to what `jobSchema` accepts. */
export function cleanLines(lines: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim().replace(/^[-•*]\s*/, "").slice(0, MAX_LINE).trim();
    if (line) out.add(line);
  }
  return [...out].slice(0, MAX_REQUIREMENTS);
}

/**
 * Explicit hints (from the assistant, who read the posting) win over what the page claimed; the page fills gaps.
 * A saved URL is refreshed in place: text, language and location update, requirement lines the assistant saved are kept.
 */
export function applyFetchedJob(data: CvData, got: FetchedPosting, hints: JobHints = {}, now = new Date()): { data: CvData; job: Job; refreshed: boolean } {
  const existing = got.url ? data.jobs.find((j) => j.url === got.url) : undefined;
  const title = hints.title?.trim() || got.title || existing?.title || "";
  const company = hints.company?.trim() || got.company || existing?.company || "";
  const requirements = existing?.requirements.length ? existing.requirements : cleanLines(got.requirements);
  const extra = got.extra ?? {};
  const niceToHave = existing?.niceToHave.length ? existing.niceToHave : cleanLines(extra.niceToHave ?? []);
  const input: Record<string, unknown> = {
    url: got.url,
    title,
    company,
    location: got.location || existing?.location || "",
    lang: got.lang,
    text: got.text,
    requirements,
    niceToHave,
    source: got.source === "justjoin" || got.source === "nofluffjobs" ? got.source : got.url ? "url" : "paste",
  };
  // Board fields refresh with the posting; a field the board does not state keeps what was saved.
  if (extra.skills?.length) input.skills = extra.skills.slice(0, 80);
  if (extra.seniority) input.seniority = extra.seniority;
  if (extra.workplace) input.workplace = extra.workplace;
  if (extra.salary) input.salary = extra.salary;
  if (extra.languages?.length) input.languages = extra.languages;
  if (extra.applyUrl) input.applyUrl = extra.applyUrl;
  const companyUrl = hints.companyUrl?.trim() || existing?.companyUrl || extra.companyUrl || "";
  if (companyUrl) input.companyUrl = companyUrl;
  if (hints.companyText !== undefined) input.companyText = hints.companyText.slice(0, 20_000);
  if (hints.notes !== undefined) input.notes = hints.notes.slice(0, 20_000);
  if (existing) input.id = existing.id;
  const { data: next, job } = upsertJob(data, input, now);
  return { data: next, job, refreshed: Boolean(existing) };
}
