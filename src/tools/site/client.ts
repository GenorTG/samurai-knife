import type { AuditRun } from "@/lib/site/audit/types";
import type { SiteView as StoredSiteView } from "@/lib/site/store";
import { cmsg } from "@/lib/i18n/client-locale";
import { withProject } from "@/lib/cv/shown-project";

/** Typed browser helpers for /api/site/*. Errors carry the API's own `error` text. */

export type { AuditRun };
/** GET /api/site: the project's website view, plus whether checks of a website without a repository need the ownership proof. */
export type SiteView = StoredSiteView & { proofNeeded?: boolean };

export class SiteApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SiteApiError";
    this.status = status;
  }
}

/** The error's message, in the interface language when the catalogue knows it (browser only). */
export function errorText(error: unknown): string {
  return cmsg(error instanceof Error ? error.message : String(error));
}

export async function siteRequest<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(withProject(path), {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new SiteApiError(`Network error: ${errorText(error)}`, 0);
  }
  const raw = await response.text();
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const reason = parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string" ? parsed.error : "";
    throw new SiteApiError(reason || `Request failed (${response.status}).`, response.status);
  }
  return parsed as T;
}

export interface AuditProgressView {
  running: boolean;
  id?: string;
  phase?: string;
  done?: number;
  total?: number;
  finished?: boolean;
  error?: string;
}

export interface ChangesView {
  work: { branch: string; base: string; createdAt: string; pull: number | null; head: string } | null;
  compare: { aheadBy: number; behindBy: number; commits: { sha: string; message: string; date: string; url: string }[]; files: { path: string; status: string; additions: number; deletions: number; patch: string }[]; htmlUrl: string } | null;
  pull: { number: number; url: string; title: string; state: string; merged: boolean; mergeable: boolean | null; headSha: string } | null;
  checks: { state: string; items: { name: string; state: string; url: string; description: string }[]; previewUrl: string } | null;
  lastAction: { kind: string; at: string; detail: string } | null;
}

export const SCORE_LABELS: [keyof AuditRun["scores"], string][] = [
  ["overall", "Overall"],
  ["seo", "Technical SEO"],
  ["copy", "Copywriting"],
  ["alignment", "CV fit"],
  ["performance", "Performance"],
  ["accessibility", "Accessibility"],
  ["bestPractices", "Best practices"],
  ["lighthouseSeo", "Lighthouse SEO"],
  ["security", "Security headers"],
];

/** Stable for SSR/hydration: a fixed locale and the server's own ISO strings. */
export function when(iso: string): string {
  return iso ? iso.replace("T", " ").slice(0, 16) : "";
}

/** GET /api/site/vercel: the website's Vercel link (no secrets). */
export type VercelView = NonNullable<StoredSiteView["vercel"]>;

export interface VercelProjectView {
  id: string;
  name: string;
  repo: string;
  productionBranch: string;
  framework: string;
  protectedPreviews: boolean;
  hasBypass: boolean;
}

export interface VercelDeploymentView {
  id: string;
  url: string;
  state: string;
  target: string;
  branch: string;
  sha: string;
  isHead: boolean;
  createdAt: string;
  inspectorUrl: string;
  error: string;
}

export interface VercelPreviewsView {
  project: VercelProjectView;
  branch: string | null;
  head: string | null;
  protectedPreviews: boolean;
  canReadProtected: boolean;
  headDeployment: VercelDeploymentView | null;
  deployments: VercelDeploymentView[];
  next: string;
}
