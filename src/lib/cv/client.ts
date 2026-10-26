import type { Application, CvData, CvLang, Job, Variant } from "./schema";
import type { CvOp } from "./ops";
import { msgf } from "@/lib/i18n/msg";
import { cmsg } from "@/lib/i18n/client-locale";

/**
 * Typed browser helpers for the CV routes. Same-origin relative URLs so the browser sends the Origin header the
 * server's guard checks on every mutating call; the error text is always the API's own `error` field when it has one.
 * Lane routes (audit, jobs match/fetch, variants suggest, showcase) may not exist yet: callers use `isUnavailable`.
 */

export class CvApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CvApiError";
  }
}

/** The route is missing or not implemented yet (as opposed to the server rejecting a request). */
export function isUnavailable(error: unknown): boolean {
  return error instanceof CvApiError && (error.status === 404 || error.status === 405 || error.status === 501);
}

/** The error's message, in the interface language when the catalogue knows it (browser only). */
export function errorText(error: unknown): string {
  return cmsg(error instanceof Error ? error.message : String(error));
}

async function request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new CvApiError(msgf("Network error: {error}", { error: errorText(error) }), 0);
  }
  const raw = await response.text();
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const reason = typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string" ? parsed.error : "";
    throw new CvApiError(reason || (response.status === 404 || response.status === 501 ? "Not available yet." : `Request failed (${response.status}).`), response.status);
  }
  return parsed as T;
}

const q = encodeURIComponent;

/* ------------------------------------------------------------- core data */

export type CvSnapshot = CvData & { changed: true };
export type CvPoll = CvSnapshot | { changed: false; revision: number };

export function getCv(knownRevision?: number): Promise<CvPoll> {
  return request("GET", knownRevision ? `/api/cv?revision=${knownRevision}` : "/api/cv");
}

export interface PatchResult {
  revision: number;
  changes: { op: string; path: string; before?: unknown; after?: unknown }[];
}
export const patchCv = (ops: CvOp[]): Promise<PatchResult> => request("POST", "/api/cv/patch", { ops });
export const undoCv = (): Promise<{ revision: number }> => request("POST", "/api/cv/undo", {});
export const importCv = (profile: unknown, overwrite: boolean): Promise<{ revision: number; replaced: boolean }> =>
  request("POST", "/api/cv/import", { profile, overwrite });

/* ------------------------------------------------------------ collections */

export const saveJob = (job: Partial<Job>): Promise<{ revision: number; job: Job }> => request("POST", "/api/cv/jobs", { job });
export const deleteJob = (id: string): Promise<{ revision: number }> => request("DELETE", `/api/cv/jobs?id=${q(id)}`);
export const saveVariant = (variant: Partial<Variant>): Promise<{ revision: number; variant: Variant }> => request("POST", "/api/cv/variants", { variant });
export const deleteVariant = (id: string): Promise<{ revision: number }> => request("DELETE", `/api/cv/variants?id=${q(id)}`);
export const saveApplication = (application: Partial<Application>): Promise<{ revision: number; application: Application }> =>
  request("POST", "/api/cv/applications", { application });
export const deleteApplication = (id: string): Promise<{ revision: number }> => request("DELETE", `/api/cv/applications?id=${q(id)}`);

/* ------------------------------------------------------------------ photo */

export interface CvPhotoMeta {
  bytes: number;
  updatedAt: string;
}
export const getPhotoMeta = (): Promise<{ photo: CvPhotoMeta | null }> => request("GET", "/api/cv/photo?meta=1");
export const uploadPhoto = (dataUrl: string): Promise<{ photo: CvPhotoMeta }> => request("POST", "/api/cv/photo", { dataUrl });
export const removePhoto = (): Promise<{ removed: boolean }> => request("DELETE", "/api/cv/photo");
/** Image URL for a stored photo; the timestamp busts the browser cache after a new upload. */
export const photoUrl = (meta: CvPhotoMeta): string => `/api/cv/photo?v=${q(meta.updatedAt)}`;

/* ------------------------------------------------------------ lane routes */

export interface AuditFinding {
  rule: string;
  severity: string;
  message: string;
  fix: string;
}
export interface AuditResult {
  lang: CvLang;
  scope: string;
  counts: Record<string, number>;
  byRule: Record<string, number>;
  findings: Record<string, AuditFinding[]>;
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const numMap = (v: unknown): Record<string, number> => Object.fromEntries(Object.entries(rec(v)).map(([k, n]) => [k, num(n)]));

/** The text lane's finding shape is only loosely fixed: read the fields we show defensively. */
function normaliseFinding(raw: unknown): AuditFinding {
  const f = rec(raw);
  return {
    rule: str(f.rule ?? f.id ?? f.code) || "finding",
    severity: str(f.severity ?? f.level) || "info",
    message: str(f.message ?? f.text ?? f.detail ?? f.reason),
    fix: str(f.hint ?? f.fix ?? f.suggestion),
  };
}

export async function getAudit(lang: CvLang): Promise<AuditResult> {
  const raw = rec(await request<unknown>("GET", `/api/cv/audit?lang=${lang}`));
  const findings: Record<string, AuditFinding[]> = {};
  for (const [path, list] of Object.entries(rec(raw.findings))) {
    if (Array.isArray(list)) findings[path] = list.map(normaliseFinding);
  }
  return { lang: raw.lang === "pl" ? "pl" : lang, scope: str(raw.scope), counts: numMap(raw.counts), byRule: numMap(raw.byRule), findings };
}

export interface MatchEvidence {
  path: string;
  text: string;
}
export interface MatchResult {
  coveragePct: number;
  /** null when the posting has no recognised technologies. */
  techCoveragePct: number | null;
  matched: { term: string; section: string; evidence: MatchEvidence[] }[];
  missing: string[];
  missingRequired: string[];
  requirementHits: { requirement: string; hit: boolean; terms: string[]; evidence: MatchEvidence | null }[];
  notes: string[];
}

function evidenceOf(v: unknown): MatchEvidence | null {
  const r = rec(v);
  return str(r.path) ? { path: str(r.path), text: str(r.text) } : null;
}

export async function getMatch(jobId: string, lang: CvLang): Promise<MatchResult> {
  const raw = rec(await request<unknown>("GET", `/api/cv/jobs/match?id=${q(jobId)}&lang=${lang}`));
  const matched = Array.isArray(raw.matched)
    ? raw.matched.map((m) => {
        const r = rec(m);
        const evidence = Array.isArray(r.evidence) ? r.evidence.flatMap((e) => evidenceOf(e) ?? []) : [];
        return { term: str(r.term ?? m), section: str(r.section), evidence };
      })
    : [];
  const hits = Array.isArray(raw.requirementHits)
    ? raw.requirementHits.map((h) => {
        const r = rec(h);
        const terms = strList(r.matchedTerms ?? r.terms);
        const evidence = evidenceOf(r.evidence);
        return { requirement: str(r.requirement ?? r.text ?? r.line), hit: terms.length > 0 || evidence !== null || r.hit === true, terms, evidence };
      })
    : [];
  return {
    coveragePct: num(raw.coveragePct),
    techCoveragePct: typeof raw.techCoveragePct === "number" ? raw.techCoveragePct : null,
    matched,
    missing: strList(raw.missing),
    missingRequired: strList(raw.missingRequired),
    requirementHits: hits,
    notes: strList(raw.notes),
  };
}

/** Add an offer from a link or pasted posting text. Falls back to the plain jobs route when the fetch route is missing. */
export async function addJob(input: { urlOrText: string; title?: string; company?: string; companyUrl?: string; notes?: string }): Promise<{ revision: number; job: Job; viaFetch: boolean; companyNote?: string }> {
  try {
    const res = await request<{ revision: number; job: Job; companyNote?: string }>("POST", "/api/cv/jobs/fetch", input);
    return { ...res, viaFetch: true };
  } catch (error) {
    if (!isUnavailable(error)) throw error;
  }
  const text = input.urlOrText.trim();
  const isLink = /^https?:\/\/\S+$/i.test(text);
  const res = await saveJob({
    title: input.title ?? "",
    company: input.company ?? "",
    ...(isLink ? { url: text, source: "url" as const } : { text, source: "paste" as const }),
    ...(input.companyUrl ? { companyUrl: input.companyUrl } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  });
  return { ...res, viaFetch: false };
}

export const suggestVariant = async (input: { jobId: string; lang: CvLang; maxBulletsPerRole?: number }): Promise<Variant> =>
  (await request<{ variant: Variant }>("POST", "/api/cv/variants/suggest", input)).variant;

export interface ShowcaseRepo {
  fullName: string;
  url: string;
  score: number;
  breakdown: { label: string; points: number }[];
  reasons: string[];
  improve: string[];
}
export interface ShowcaseRanking {
  repos: ShowcaseRepo[];
  note: string;
  considered: number;
  skipped: { repo: string; error: string }[];
}
export async function getShowcaseRank(owner: string): Promise<ShowcaseRanking> {
  const raw = rec(await request<unknown>("GET", `/api/cv/showcase/rank${owner ? `?owner=${q(owner)}` : ""}`));
  const list = Array.isArray(raw.ranked) ? raw.ranked : Array.isArray(raw.repos) ? raw.repos : [];
  const repos = list.map((r) => {
    const x = rec(r);
    return {
      fullName: str(x.repo ?? x.fullName ?? x.name),
      url: str(x.url),
      score: num(x.score),
      breakdown: Object.entries(rec(x.breakdown)).map(([label, points]) => ({ label, points: num(points) })),
      reasons: strList(x.reasons),
      improve: strList(x.improveFirst ?? x.improve),
    };
  });
  const skipped = Array.isArray(raw.skipped) ? raw.skipped.map((s) => ({ repo: str(rec(s).repo), error: str(rec(s).error) })) : [];
  return { repos, note: str(raw.note), considered: num(raw.considered), skipped };
}

export interface ShowcaseDetail {
  fullName: string;
  url: string;
  score: number;
  facts: [string, string][];
  checklist: { id: string; passed: boolean | null; advice: string; weight: number }[];
}

const FACT_ORDER: [string, string][] = [
  ["description", "Description"], ["languages", "Languages"], ["topics", "Topics"], ["license", "License"], ["stars", "Stars"],
  ["forks", "Forks"], ["commitCount", "Commits"], ["contributors", "Contributors"], ["firstCommit", "First commit"],
  ["lastCommit", "Last commit"], ["hasCi", "CI"], ["hasTests", "Tests"], ["latestRelease", "Latest release"],
];

function factText(key: string, value: unknown): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (key === "languages") {
    const entries = Object.entries(rec(value)).map(([k, n]) => [k, num(n)] as const);
    const total = entries.reduce((sum, [, n]) => sum + n, 0) || 1;
    return entries.sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} ${Math.round((n / total) * 100)}%`).join(", ");
  }
  if (Array.isArray(value)) return value.map(str).filter(Boolean).join(", ");
  if (typeof value === "object" && value !== null) return str(rec(value).tag ?? rec(value).name);
  return str(value);
}

export async function getShowcaseRepo(repo: string): Promise<ShowcaseDetail> {
  const raw = rec(await request<unknown>("GET", `/api/cv/showcase/repo?repo=${q(repo)}`));
  const facts = FACT_ORDER.flatMap(([key, label]): [string, string][] => {
    const text = factText(key, raw[key]);
    return text ? [[label, text]] : [];
  });
  const items = Array.isArray(raw.checklist) ? raw.checklist : [];
  const checklist = items.map((it) => {
    const r = rec(it);
    const flag = r.passed ?? r.ok ?? r.pass;
    return { id: str(r.id ?? r.label), passed: typeof flag === "boolean" ? flag : null, advice: str(r.advice ?? r.detail), weight: num(r.weight) };
  });
  return { fullName: str(raw.name) || repo, url: str(raw.url), score: num(raw.showcaseScore ?? raw.score), facts, checklist };
}

/* --------------------------------------------------------- tailoring */

export const readCompany = (jobId: string, url?: string): Promise<{ revision: number; job: Job; companyNote: string }> =>
  request("POST", "/api/cv/jobs/company", { jobId, ...(url ? { url } : {}) });

export interface AtsKeyword {
  term: string;
  section: "required" | "nice" | "text";
  kind: "tech" | "keyword";
  status: "present" | "dropped" | "missing";
  postingSpelling: string;
  spellingDiffers: boolean;
  evidence: string[];
}
export interface AtsResult {
  jobId: string;
  variantId: string | null;
  lang: CvLang;
  score: number;
  requiredCoveragePct: number | null;
  niceCoveragePct: number | null;
  keywords: AtsKeyword[];
  checks: { id: string; level: "ok" | "warn" | "fail" | "info"; message: string }[];
  pages: number;
  actions: string[];
  fixable: string[];
  gaps: string[];
  printed: string;
}
export const getAts = (input: { variantId: string } | { jobId: string; lang: CvLang }): Promise<AtsResult> => request("POST", "/api/cv/variants/ats", input);

export const rewriteVariant = (variantId: string, set: { path: string; text: { pl?: string; en?: string } }[], remove: string[] = []): Promise<{ revision: number; variant: Variant; warnings: string[] }> =>
  request("POST", "/api/cv/variants/rewrite", { variantId, set, remove });

export interface GithubProjectResult {
  revision: number;
  created: boolean;
  project: CvData["profile"]["projects"][number];
  facts: Record<string, unknown>;
}
export const projectFromGithub = (repo: string, pinned = false): Promise<GithubProjectResult> => request("POST", "/api/cv/showcase/project", { repo, pinned });
