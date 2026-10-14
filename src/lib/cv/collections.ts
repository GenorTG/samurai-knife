import {
  applicationSchema, jobSchema, variantSchema, IN_PROGRESS_STATUSES, OPEN_STATUSES,
  type Application, type ApplicationStatus, type CvData, type Job, type Variant,
} from "./schema";
import { danglingIds } from "./variant";

/** Pure upsert/remove helpers over CvData collections. Shared by the HTTP routes and the `knife_cv_*` tools. */

export class CvCollectionError extends Error {}

export function slugify(text: string): string {
  const folded = text.replace(/ł/g, "l").replace(/Ł/g, "L").normalize("NFKD").replace(/[̀-ͯ]/g, "");
  return folded.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 48).replace(/-+$/, "") || "item";
}

export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const root = slugify(base);
  if (!taken.has(root)) return root;
  for (let n = 2; ; n += 1) if (!taken.has(`${root}-${n}`)) return `${root}-${n}`;
}

export function todayIso(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function parseOrThrow<T>(result: { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } }): T {
  if (result.success) return result.data;
  const first = result.error.issues[0];
  throw new CvCollectionError(`invalid at ${first.path.join("/") || "/"}: ${first.message}`);
}

export function upsertJob(data: CvData, raw: unknown, now = new Date()): { data: CvData; job: Job } {
  const input = raw as { id?: unknown; company?: unknown; title?: unknown } | null;
  const taken = new Set(data.jobs.map((j) => j.id));
  const id = typeof input?.id === "string" && input.id ? input.id : uniqueId(`${String(input?.company ?? "")}-${String(input?.title ?? "job")}`, taken);
  const existing = data.jobs.find((j) => j.id === id);
  const job = parseOrThrow(jobSchema.safeParse({ savedAt: existing?.savedAt || now.toISOString(), ...existing, ...(raw as object), id }));
  const jobs = existing ? data.jobs.map((j) => (j.id === id ? job : j)) : [...data.jobs, job];
  return { data: { ...data, jobs }, job };
}

export function removeJob(data: CvData, id: string): CvData {
  if (!data.jobs.some((j) => j.id === id)) throw new CvCollectionError(unknownId("job", id, data.jobs));
  return { ...data, jobs: data.jobs.filter((j) => j.id !== id), applications: data.applications.map((a) => (a.jobId === id ? { ...a, jobId: null } : a)) };
}

export function upsertVariant(data: CvData, raw: unknown): { data: CvData; variant: Variant } {
  const variant = parseOrThrow(variantSchema.safeParse({ ...(data.variants.find((v) => v.id === (raw as { id?: unknown })?.id) ?? {}), ...(raw as object) }));
  const bad = danglingIds(data.profile, variant);
  if (bad.length) {
    const exp = data.profile.experience.map((e) => `${e.id}[${e.bullets.map((b) => b.id).join(",")}]`).join("; ");
    throw new CvCollectionError(`variant references ids the profile does not have: ${bad.join(", ")}. Valid: experience ${exp || "none"}; projects ${data.profile.projects.map((p) => p.id).join(", ") || "none"}; skill groups ${data.profile.skills.map((s) => s.id).join(", ") || "none"}.`);
  }
  if (variant.jobId && !data.jobs.some((j) => j.id === variant.jobId)) throw new CvCollectionError(unknownId("job", variant.jobId, data.jobs));
  const exists = data.variants.some((v) => v.id === variant.id);
  const variants = exists ? data.variants.map((v) => (v.id === variant.id ? variant : v)) : [...data.variants, variant];
  return { data: { ...data, variants }, variant };
}

export function removeVariant(data: CvData, id: string): CvData {
  if (!data.variants.some((v) => v.id === id)) throw new CvCollectionError(unknownId("variant", id, data.variants));
  return { ...data, variants: data.variants.filter((v) => v.id !== id), applications: data.applications.map((a) => (a.variantId === id ? { ...a, variantId: null } : a)) };
}

/** Create or update an application; a status change appends a dated history entry (`note` explains it). */
export function upsertApplication(data: CvData, raw: unknown, note = "", today = todayIso()): { data: CvData; application: Application } {
  const input = raw as { id?: unknown; company?: unknown; role?: unknown; status?: unknown } | null;
  const taken = new Set(data.applications.map((a) => a.id));
  const id = typeof input?.id === "string" && input.id ? input.id : uniqueId(`${String(input?.company ?? "")}-${String(input?.role ?? "role")}`, taken);
  const existing = data.applications.find((a) => a.id === id);
  const merged = parseOrThrow(applicationSchema.safeParse({ ...existing, ...(raw as object), id, history: existing?.history ?? [] }));
  if (merged.jobId && !data.jobs.some((j) => j.id === merged.jobId)) throw new CvCollectionError(unknownId("job", merged.jobId, data.jobs));
  if (merged.variantId && !data.variants.some((v) => v.id === merged.variantId)) throw new CvCollectionError(unknownId("variant", merged.variantId, data.variants));
  const statusChanged = !existing || existing.status !== merged.status;
  // "When was it sent" is recorded the moment the status becomes applied; a date the caller states (backfilling an old one) wins.
  if (merged.status === "applied" && merged.appliedOn === null && statusChanged) merged.appliedOn = today;
  if (statusChanged) merged.history = [...merged.history, { on: today, status: merged.status, note: existing ? note : note || "created" }];
  else if (note) merged.history = [...merged.history, { on: today, status: merged.status, note }];
  const applications = existing ? data.applications.map((a) => (a.id === id ? merged : a)) : [...data.applications, merged];
  return { data: { ...data, applications }, application: merged };
}

export function removeApplication(data: CvData, id: string): CvData {
  if (!data.applications.some((a) => a.id === id)) throw new CvCollectionError(unknownId("application", id, data.applications));
  return { ...data, applications: data.applications.filter((a) => a.id !== id) };
}

/** Open applications whose next action is due on or before today + withinDays, soonest first. */
export function dueApplications(apps: readonly Application[], today = todayIso(), withinDays = 0): Application[] {
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + withinDays);
  const cutoff = limit.toISOString().slice(0, 10);
  return apps
    .filter((a) => (OPEN_STATUSES as readonly ApplicationStatus[]).includes(a.status) && a.nextActionDue !== null && a.nextActionDue <= cutoff)
    .sort((a, b) => (a.nextActionDue ?? "").localeCompare(b.nextActionDue ?? ""));
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

export interface ApplicationSummary {
  id: string;
  company: string;
  role: string;
  status: ApplicationStatus;
  url: string;
  jobId: string | null;
  variantId: string | null;
  appliedOn: string | null;
  /** Whole days since it was sent (null when appliedOn is unknown). */
  daysSinceApplied: number | null;
  /** Sent and still alive: applied, screening or interview. */
  inProgress: boolean;
  /** Not finished: wishlist or in progress. */
  open: boolean;
  nextAction: string;
  nextActionDue: string | null;
  overdue: boolean;
  /** Date of the entry that closed it (offer/rejected/withdrawn/ghosted), if it is closed. */
  closedOn: string | null;
  lastUpdate: string | null;
}

/** Everything an "open applications" view or tool needs, derived from one record and today's date. */
export function summarizeApplication(app: Application, today = todayIso()): ApplicationSummary {
  const open = (OPEN_STATUSES as readonly ApplicationStatus[]).includes(app.status);
  const closing = open ? undefined : [...app.history].reverse().find((h) => h.status === app.status);
  return {
    id: app.id, company: app.company, role: app.role, status: app.status, url: app.url, jobId: app.jobId, variantId: app.variantId,
    appliedOn: app.appliedOn,
    daysSinceApplied: app.appliedOn ? daysBetween(app.appliedOn, today) : null,
    inProgress: (IN_PROGRESS_STATUSES as readonly ApplicationStatus[]).includes(app.status),
    open,
    nextAction: app.nextAction, nextActionDue: app.nextActionDue,
    overdue: open && app.nextActionDue !== null && app.nextActionDue < today,
    closedOn: closing?.on ?? null,
    lastUpdate: app.history.at(-1)?.on ?? null,
  };
}

function unknownId(kind: string, id: string, list: readonly { id: string }[]): string {
  return `no ${kind} '${id}' (have: ${list.map((x) => x.id).join(", ") || "none"})`;
}
