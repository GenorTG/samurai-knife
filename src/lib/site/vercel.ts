// SERVER ONLY. The Vercel REST API calls of the website studio (docs/WEBSITE-STUDIO.md "Vercel"): the project linked to
// the site's repository, its deployments (previews of the work branch), their build logs, a preview deployment of the
// work branch, and the project's Protection Bypass for Automation. Every call goes through `apiJson` (SSRF guard).
import { msgf } from "@/lib/i18n/msg";
import { apiJson, SiteError, type NetDeps } from "./net";

export const VERCEL_API = (): string => (process.env.KNIFE_VERCEL_API_URL?.trim() || "https://api.vercel.com").replace(/\/+$/, "");
export const VERCEL_WEB = (): string => (process.env.KNIFE_VERCEL_WEB_URL?.trim() || "https://vercel.com").replace(/\/+$/, "");

/** The team a call acts in: `team_...` ids go as teamId, anything else as the team slug; "" = the token's own account. */
export interface VercelScope {
  token: string;
  team: string;
}

const TEAM = /^[A-Za-z0-9_-]{1,100}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

export function checkTeam(team: string): string {
  const t = team.trim();
  if (t && !TEAM.test(t)) throw new SiteError(msgf("'{team}' is not a Vercel team id or slug", { team: t.slice(0, 60) }));
  return t;
}

export function checkVercelToken(token: string): string {
  const t = token.trim();
  if (!/^[A-Za-z0-9_.-]{16,500}$/.test(t)) throw new SiteError("that does not look like a Vercel access token (Account settings > Tokens)");
  return t;
}

export function checkId(value: string, what: string): string {
  const v = value.trim();
  if (!ID.test(v)) throw new SiteError(msgf("'{value}' is not a valid {what}", { value: v.slice(0, 60), what }));
  return v;
}

async function call(scope: VercelScope, method: "GET" | "POST" | "PATCH", path: string, query: Record<string, string | number | undefined> = {}, body?: unknown, deps: NetDeps = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") q.set(k, String(v));
  if (scope.team) q.set(scope.team.startsWith("team_") ? "teamId" : "slug", scope.team);
  const url = `${VERCEL_API()}${path}${q.size ? `?${q}` : ""}`;
  const res = await apiJson(url, { method, headers: { authorization: `Bearer ${scope.token}` }, body }, deps);
  if (res.status >= 200 && res.status < 300) return res.body;
  const err = (res.body && typeof res.body === "object" ? (res.body as { error?: { message?: string; code?: string } }).error : undefined) ?? {};
  const detail = String(err.message ?? err.code ?? `HTTP ${res.status}`).slice(0, 300);
  if (res.status === 401) throw new SiteError(msgf("Vercel refused the token ({detail}): connect Vercel again", { detail }), 401);
  if (res.status === 403) throw new SiteError(msgf("Vercel refused this for the token ({detail}): it may lack access to the project or team, or a scope", { detail }), 403);
  if (res.status === 404) throw new SiteError(msgf("Vercel: not found ({detail})", { detail }), 404);
  if (res.status === 429) throw new SiteError(msgf("Vercel rate limit ({detail}): try again in a minute", { detail }), 429);
  throw new SiteError(msgf("Vercel answered {status}: {detail}", { status: res.status, detail }), res.status >= 500 ? 502 : 400);
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

export interface VercelProject {
  id: string;
  name: string;
  framework: string;
  /** Git link: "github" + "owner/repo" + the repository id Vercel deploys from; empty when the project is not linked. */
  gitType: string;
  repo: string;
  repoId: string;
  productionBranch: string;
  /** Deployment Protection on previews (Vercel Authentication or password): a plain fetch gets 401 without a bypass. */
  protectedPreviews: boolean;
  /** Protection Bypass for Automation secrets of the project (values; never sent to a browser or a model). */
  bypassSecrets: string[];
}

function project(raw: unknown): VercelProject {
  const p = rec(raw);
  const link = rec(p.link);
  const org = str(link.org);
  const repoName = str(link.repo);
  // Every deploymentType of Vercel Authentication / Password Protection covers preview URLs.
  const protectedPreviews = !!p.ssoProtection || !!p.passwordProtection;
  return {
    id: str(p.id),
    name: str(p.name),
    framework: str(p.framework),
    gitType: str(link.type),
    repo: org && repoName ? `${org}/${repoName}` : "",
    repoId: str(link.repoId),
    productionBranch: str(link.productionBranch) || "main",
    protectedPreviews,
    bypassSecrets: Object.entries(rec(p.protectionBypass))
      .filter(([, v]) => /automation-bypass/.test(str(rec(v).scope)))
      .map(([k]) => k),
  };
}

export async function getUser(scope: VercelScope, deps?: NetDeps): Promise<string> {
  try {
    const body = rec(await call({ ...scope, team: "" }, "GET", "/v2/user", {}, undefined, deps));
    const user = rec(body.user);
    return str(user.username) || str(user.email);
  } catch (error) {
    // An integration token without the user scope cannot read it: not an error for the studio.
    if (error instanceof SiteError && error.status === 403) return "";
    throw error;
  }
}

export async function listProjects(scope: VercelScope, deps?: NetDeps): Promise<VercelProject[]> {
  const body = rec(await call(scope, "GET", "/v10/projects", { limit: 100 }, undefined, deps));
  return (Array.isArray(body.projects) ? body.projects : []).map(project).filter((p) => p.id);
}

export async function getProject(scope: VercelScope, idOrName: string, deps?: NetDeps): Promise<VercelProject> {
  return project(await call(scope, "GET", `/v9/projects/${encodeURIComponent(checkId(idOrName, "Vercel project"))}`, {}, undefined, deps));
}

export type DeploymentState = "QUEUED" | "INITIALIZING" | "BUILDING" | "READY" | "ERROR" | "CANCELED" | "BLOCKED" | "DELETED" | string;

export interface VercelDeployment {
  id: string;
  /** https URL of this deployment (a *.vercel.app host). */
  url: string;
  state: DeploymentState;
  target: string;
  projectId: string;
  branch: string;
  sha: string;
  createdAt: string;
  inspectorUrl: string;
  errorMessage: string;
}

function deployment(raw: unknown): VercelDeployment {
  const d = rec(raw);
  const meta = rec(d.meta);
  const host = str(d.url);
  const created = Number(d.createdAt ?? d.created ?? 0);
  return {
    id: str(d.uid) || str(d.id),
    // Vercel answers a bare host (always https); a full URL is kept as given (test doubles on loopback).
    url: host ? (/^https?:\/\//.test(host) ? host.replace(/\/+$/, "") : `https://${host}`) : "",
    state: str(d.readyState) || str(d.state),
    target: str(d.target) || "preview",
    projectId: str(d.projectId),
    branch: str(meta.githubCommitRef) || str(meta.gitlabCommitRef) || str(meta.bitbucketCommitRef),
    sha: str(meta.githubCommitSha) || str(meta.gitlabCommitSha) || str(meta.bitbucketCommitSha),
    createdAt: created ? new Date(created).toISOString() : "",
    inspectorUrl: str(d.inspectorUrl),
    errorMessage: str(d.errorMessage).slice(0, 500),
  };
}

export async function listDeployments(scope: VercelScope, projectId: string, filter: { branch?: string; sha?: string; limit?: number } = {}, deps?: NetDeps): Promise<VercelDeployment[]> {
  const body = rec(await call(scope, "GET", "/v7/deployments", { projectId: checkId(projectId, "Vercel project"), branch: filter.branch, sha: filter.sha, limit: filter.limit ?? 10 }, undefined, deps));
  return (Array.isArray(body.deployments) ? body.deployments : []).map(deployment).map((d) => ({ ...d, projectId: d.projectId || projectId }));
}

/** By id (`dpl_...`) or by its host (`my-site-abc123.vercel.app`). */
export async function getDeployment(scope: VercelScope, idOrHost: string, deps?: NetDeps): Promise<VercelDeployment> {
  const v = idOrHost.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[A-Za-z0-9_.:-]{1,253}$/.test(v)) throw new SiteError(msgf("'{value}' is not a deployment id or host", { value: v.slice(0, 80) }));
  return deployment(await call(scope, "GET", `/v13/deployments/${encodeURIComponent(v)}`, {}, undefined, deps));
}

/** The build output of a deployment: the last `max` lines (commands, stdout, stderr), oldest first. */
export async function deploymentLog(scope: VercelScope, id: string, max = 200, deps?: NetDeps): Promise<string[]> {
  const body = await call(scope, "GET", `/v3/deployments/${encodeURIComponent(checkId(id, "deployment id"))}/events`, { limit: -1, builds: 1 }, undefined, deps);
  const events = Array.isArray(body) ? body : [];
  const lines: string[] = [];
  for (const e of events) {
    const ev = rec(e);
    const text = str(ev.text) || str(rec(ev.payload).text);
    if (!text) continue;
    const type = str(ev.type);
    for (const line of text.split(/\r?\n/)) if (line.trim()) lines.push(type === "stderr" ? `! ${line}` : line);
  }
  return lines.slice(-max).map((l) => l.slice(0, 500));
}

/** A new preview deployment of `ref` at `sha` from the project's linked GitHub repository (Vercel fetches the source). */
export async function createGitDeployment(scope: VercelScope, p: VercelProject, ref: string, sha: string, deps?: NetDeps): Promise<VercelDeployment> {
  if (p.gitType !== "github" || !p.repoId) throw new SiteError("the Vercel project is not linked to a GitHub repository, so it cannot deploy a branch", 409);
  // target is left out on purpose: Vercel derives it from the branch, and the caller never passes the production branch.
  const body = { name: p.name, project: p.id, gitSource: { type: "github", repoId: p.repoId, ref, sha } };
  return deployment(await call(scope, "POST", "/v13/deployments", { forceNew: 1, skipAutoDetectionConfirmation: 1 }, body, deps));
}

/** Generates a Protection Bypass for Automation secret for the project; returns its value (Vercel answers the whole map). */
export async function generateBypass(scope: VercelScope, projectId: string, oauth: boolean, deps?: NetDeps): Promise<string> {
  const before = new Set((await getProject(scope, projectId, deps)).bypassSecrets);
  const body = rec(await call(scope, "PATCH", `/v1/projects/${encodeURIComponent(checkId(projectId, "Vercel project"))}/protection-bypass`, {}, { generate: { note: "Smart Knife website studio" } }, deps));
  const keys = Object.keys(rec(body.protectionBypass));
  const fresh = keys.find((k) => !before.has(k)) ?? (oauth ? keys.find((k) => /integration/.test(str(rec(rec(body.protectionBypass)[k]).scope))) : undefined);
  if (!fresh) throw new SiteError("Vercel did not return a new bypass secret: create one in the project's Deployment Protection settings and paste it", 502);
  return fresh;
}
