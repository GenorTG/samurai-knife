import { getAccount, type Account } from "@/lib/accounts/store";
import { consumeOutbound, outboundLimitMessage } from "@/lib/net/outbound";
import { msg, msgf } from "@/lib/i18n/msg";
import { SiteError, type NetDeps } from "./net";
import { workHead } from "./service";
import { loadSite, mutateSite, siteView, type VercelLink } from "./store";
import * as vercel from "./vercel";
import type { AuditOptions } from "./audit/run";

/**
 * The optional Vercel link of the website studio (docs/WEBSITE-STUDIO.md "Vercel"), shared by the HTTP routes and the
 * knife_site_* tools. What it adds to the GitHub flow: the previews Vercel built for the work branch (state, URL, build
 * log), a preview deployment of the work branch on demand, and reading protected previews with the project's Protection
 * Bypass for Automation. It never deploys the production branch and never promotes anything: production stays the
 * user's Publish (merge) in the Changes tab.
 */

const ACTIVE = new Set(["QUEUED", "INITIALIZING", "BUILDING"]);
const FAILED = new Set(["ERROR", "CANCELED", "BLOCKED", "DELETED"]);

export interface VercelOAuthConfig {
  clientId: string;
  clientSecret: string;
  slug: string;
}

/** The Smart Knife Vercel integration (optional): KNIFE_VERCEL_CLIENT_ID / _CLIENT_SECRET / _INTEGRATION_SLUG. */
export function vercelOAuthConfig(): VercelOAuthConfig | null {
  const clientId = process.env.KNIFE_VERCEL_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.KNIFE_VERCEL_CLIENT_SECRET?.trim() ?? "";
  const slug = process.env.KNIFE_VERCEL_INTEGRATION_SLUG?.trim() ?? "";
  if (!clientId || !clientSecret || !/^[a-z0-9-]{1,64}$/.test(slug)) return null;
  return { clientId, clientSecret, slug };
}

function account(accountId: string): Account {
  const a = getAccount(accountId);
  if (!a) throw new SiteError("unknown account", 404);
  return a;
}

function spend(a: Account): void {
  const budget = consumeOutbound(a, "vercel", vercel.VERCEL_API());
  if (!budget.ok) throw new SiteError(outboundLimitMessage(budget.retryAfterSeconds), 429);
}

function scopeOf(v: VercelLink): vercel.VercelScope {
  return { token: v.token.value, team: v.team };
}

function linked(accountId: string): VercelLink {
  const v = loadSite(accountId).vercel;
  if (!v) throw new SiteError(msg("Vercel is not connected: connect it in the Website tab (Vercel, optional) first."), 409);
  return v;
}

function withProject(accountId: string): VercelLink & { projectId: string } {
  const v = linked(accountId);
  if (!v.projectId) throw new SiteError(msg("Vercel is connected but no project is chosen: pick the project that deploys this site in the Website tab."), 409);
  return v as VercelLink & { projectId: string };
}

function projectSummary(p: vercel.VercelProject) {
  return { id: p.id, name: p.name, repo: p.repo, productionBranch: p.productionBranch, framework: p.framework, protectedPreviews: p.protectedPreviews, hasBypass: p.bypassSecrets.length > 0 };
}

/** A Vercel project may only be chosen for the site whose repository it deploys. */
function assertSameRepo(accountId: string, p: vercel.VercelProject): void {
  const repo = loadSite(accountId).connection?.repo;
  if (repo && p.repo && p.repo.toLowerCase() !== repo.toLowerCase()) {
    throw new SiteError(msgf("the Vercel project {name} deploys {projectRepo}, not this site's repository {repo}", { name: p.name, projectRepo: p.repo, repo }), 409);
  }
}

export interface VercelConnectInput {
  /** A Vercel access token (Account settings > Tokens); omitted = keep the stored one and change settings. */
  token?: string;
  /** Team id (`team_...`) or slug; "" = the token owner's personal account. */
  team?: string;
  projectId?: string;
  /** A Protection Bypass for Automation secret; "" forgets it. */
  bypass?: string;
}

/**
 * Connect (or change settings): validates the token by listing its projects, picks the project that deploys the site's
 * repository when exactly one does, and adopts the project's existing bypass secret when none is stored.
 */
export async function vercelConnect(accountId: string, input: VercelConnectInput, deps?: NetDeps) {
  const a = account(accountId);
  const current = loadSite(accountId).vercel;
  const token = input.token?.trim() ? { source: "pat" as const, value: vercel.checkVercelToken(input.token) } : current?.token;
  if (!token) throw new SiteError(msg("A Vercel token is needed: create one in Vercel (Account settings > Tokens) with access to the site's team."));
  const team = input.team === undefined ? current?.team ?? "" : vercel.checkTeam(input.team);
  const scope = { token: token.value, team };
  spend(a);
  const projects = await vercel.listProjects(scope, deps);
  const user = input.token?.trim() ? await vercel.getUser(scope, deps) : current?.user ?? "";
  let projectId = input.projectId === undefined ? (current?.team === team ? current?.projectId ?? "" : "") : input.projectId.trim();
  const repo = loadSite(accountId).connection?.repo?.toLowerCase() ?? "";
  if (!projectId && repo) {
    const matches = projects.filter((p) => p.repo.toLowerCase() === repo);
    if (matches.length === 1) projectId = matches[0].id;
  }
  let chosen: vercel.VercelProject | null = null;
  if (projectId) {
    chosen = projects.find((p) => p.id === projectId || p.name === projectId) ?? (await vercel.getProject(scope, projectId, deps));
    assertSameRepo(accountId, chosen);
  }
  let bypass = current && current.projectId === chosen?.id ? current.bypass : "";
  if (input.bypass !== undefined) {
    const b = input.bypass.trim();
    if (b && !/^[A-Za-z0-9_-]{16,200}$/.test(b)) throw new SiteError(msg("That does not look like a Vercel bypass secret (Project settings > Deployment Protection > Protection Bypass for Automation)."));
    bypass = b;
  }
  if (!bypass && chosen?.bypassSecrets.length) bypass = chosen.bypassSecrets[0];
  mutateSite(accountId, (s) => {
    s.vercel = {
      token: token.source === "oauth" ? { ...token } : { source: "pat", value: token.value },
      team,
      user,
      projectId: chosen?.id ?? "",
      projectName: chosen?.name ?? "",
      bypass,
      connectedAt: current?.connectedAt ?? new Date().toISOString(),
    };
  });
  return { view: siteView(loadSite(accountId)), projects: projects.map(projectSummary), project: chosen ? projectSummary(chosen) : null };
}

/** After the integration's OAuth install: the token for the chosen scope (team or personal), then the project match. */
export async function storeOAuthToken(accountId: string, token: string, configurationId: string, teamId: string | null, deps?: NetDeps) {
  const current = loadSite(accountId).vercel;
  const team = teamId ? vercel.checkTeam(teamId) : "";
  mutateSite(accountId, (s) => {
    s.vercel = {
      token: { source: "oauth", value: token, configurationId: configurationId.slice(0, 100) },
      team,
      user: "",
      projectId: current && current.team === team ? current.projectId : "",
      projectName: current && current.team === team ? current.projectName : "",
      bypass: current && current.team === team ? current.bypass : "",
      connectedAt: new Date().toISOString(),
    };
  });
  // Pick the project now when it is unambiguous; a failure here leaves the token stored for the Website tab's picker.
  try {
    return await vercelConnect(accountId, {}, deps);
  } catch {
    return { view: siteView(loadSite(accountId)), projects: [], project: null };
  }
}

export function vercelDisconnect(accountId: string) {
  mutateSite(accountId, (s) => {
    s.vercel = null;
  });
  return siteView(loadSite(accountId));
}

export async function vercelProjects(accountId: string, deps?: NetDeps) {
  const v = linked(accountId);
  spend(account(accountId));
  return (await vercel.listProjects(scopeOf(v), deps)).map(projectSummary);
}

/** UI only: creates a Protection Bypass for Automation secret on the project and stores it. */
export async function vercelGenerateBypass(accountId: string, deps?: NetDeps) {
  const v = withProject(accountId);
  spend(account(accountId));
  const secret = await vercel.generateBypass(scopeOf(v), v.projectId, v.token.source === "oauth", deps);
  mutateSite(accountId, (s) => {
    if (s.vercel && s.vercel.projectId === v.projectId) s.vercel.bypass = secret;
  });
  return siteView(loadSite(accountId));
}

function publicDeployment(d: vercel.VercelDeployment, head: string | null) {
  return { id: d.id, url: d.url, state: d.state, target: d.target, branch: d.branch, sha: d.sha, isHead: !!head && d.sha === head, createdAt: d.createdAt, inspectorUrl: d.inspectorUrl, error: d.errorMessage };
}

/**
 * The previews of the work branch (newest first) and the one built from its head commit, if any. Without a work branch:
 * the newest deployments of the project. `next` tells the agent what to do with the head preview's state.
 */
export async function previews(accountId: string, deps?: NetDeps) {
  const v = withProject(accountId);
  const work = loadSite(accountId).connection ? await workHead(accountId) : null;
  spend(account(accountId));
  const scope = scopeOf(v);
  const project = await vercel.getProject(scope, v.projectId, deps);
  const list = await vercel.listDeployments(scope, v.projectId, work?.branch ? { branch: work.branch, limit: 10 } : { limit: 10 }, deps);
  const head = work?.head ?? null;
  const headDeployment = head ? list.find((d) => d.sha === head) ?? null : null;
  let next: string;
  if (!work?.branch) next = "No work branch yet: these are the project's newest deployments. Write changes first; Vercel then builds a preview of the work branch.";
  else if (!headDeployment) next = "No preview of the work branch's head commit yet: Vercel usually starts one within a minute of a push. Call knife_site_previews again shortly, or knife_site_deploy to start one.";
  else if (ACTIVE.has(headDeployment.state)) next = "The head preview is still building: call knife_site_previews again in 20-60 s.";
  else if (FAILED.has(headDeployment.state)) next = "The head preview failed: read knife_site_deploy_logs {id} for the build error, fix it on the work branch, and check again.";
  else next = "The head preview is ready: check it with knife_site_audit {target:\"preview\"} or knife_site_page {url}.";
  return {
    project: projectSummary(project),
    branch: work?.branch ?? null,
    head,
    protectedPreviews: project.protectedPreviews,
    canReadProtected: !project.protectedPreviews || !!v.bypass,
    headDeployment: headDeployment ? publicDeployment(headDeployment, head) : null,
    deployments: list.map((d) => publicDeployment(d, head)),
    next,
  };
}

/** The build output of one deployment of the linked project (never another project's). */
export async function deployLog(accountId: string, deploymentId: string, deps?: NetDeps) {
  const v = withProject(accountId);
  spend(account(accountId));
  const scope = scopeOf(v);
  const d = await vercel.getDeployment(scope, vercel.checkId(deploymentId, "deployment id"), deps);
  if (d.projectId && d.projectId !== v.projectId) throw new SiteError(msg("That deployment belongs to another Vercel project."), 403);
  return { deployment: publicDeployment(d, null), lines: await vercel.deploymentLog(scope, d.id, 200, deps) };
}

/**
 * A preview deployment of the work branch's head commit. Returns the existing one when Vercel already built (or is
 * building) that commit, unless `force`. Refuses without a work branch and for the base or production branch.
 */
export async function deployWorkBranch(accountId: string, force = false, deps?: NetDeps) {
  const v = withProject(accountId);
  if (!loadSite(accountId).connection) throw new SiteError(msg("Connect the site's GitHub repository first: the preview is built from its work branch."), 409);
  const work = await workHead(accountId);
  if (!work.branch || !work.head) throw new SiteError(msg("There is no work branch yet: write changes first (knife_site_replace / knife_site_write)."), 409);
  spend(account(accountId));
  const scope = scopeOf(v);
  const project = await vercel.getProject(scope, v.projectId, deps);
  assertSameRepo(accountId, project);
  if (work.branch === project.productionBranch || work.branch === work.baseBranch) {
    throw new SiteError(msgf("{branch} is the production branch: only the work branch is deployed from here, production changes go through Publish", { branch: work.branch }), 409);
  }
  if (!force) {
    const existing = (await vercel.listDeployments(scope, v.projectId, { sha: work.head, limit: 5 }, deps)).find((d) => !FAILED.has(d.state));
    if (existing) return { created: false, deployment: publicDeployment(existing, work.head), next: "Vercel already has this commit: follow it with knife_site_previews." };
  }
  const d = await vercel.createGitDeployment(scope, project, work.branch, work.head, deps);
  mutateSite(accountId, () => undefined); // revision bump: open pages refresh
  return { created: true, deployment: publicDeployment(d, work.head), next: "Building: call knife_site_previews in 20-60 s until the head preview is READY (or ERROR: then knife_site_deploy_logs)." };
}

/** For an audit of the preview: the READY head preview's URL, with the bypass header for its host when one is stored. */
export async function previewTarget(accountId: string, deps?: NetDeps): Promise<{ url: string; hostHeaders?: NetDeps["hostHeaders"]; protectedWithoutBypass: boolean }> {
  const p = await previews(accountId, deps);
  const d = p.headDeployment;
  if (!d) throw new SiteError(p.next, 409);
  if (d.state !== "READY") throw new SiteError(msgf("the head preview is {state}: {next}", { state: d.state, next: p.next }), 409);
  const bypass = loadSite(accountId).vercel?.bypass ?? "";
  return { url: d.url, hostHeaders: bypass ? bypassHeaders(d.url, bypass) : undefined, protectedWithoutBypass: p.protectedPreviews && !bypass };
}

function bypassHeaders(url: string, secret: string): NetDeps["hostHeaders"] {
  return { host: new URL(url).host, headers: { "x-vercel-protection-bypass": secret } };
}

/**
 * The bypass header for a URL the agent passes (knife_site_page): only when Vercel says that host is a deployment of
 * the linked project. Anything else (another site, an unknown host, Vercel unreachable) gets no header.
 */
export async function bypassFor(accountId: string, url: string, deps?: NetDeps): Promise<NetDeps["hostHeaders"] | undefined> {
  const v = loadSite(accountId).vercel;
  if (!v?.bypass || !v.projectId) return undefined;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return undefined;
  }
  try {
    spend(account(accountId));
    const d = await vercel.getDeployment(scopeOf(v), host, deps);
    return d.projectId === v.projectId ? bypassHeaders(url, v.bypass) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Audit options with Vercel applied: `target: "preview"` without a URL audits the READY head preview of the work
 * branch, and a URL on a deployment of the linked project carries the bypass header. PageSpeed cannot send that header
 * (and must never receive the secret), so a protected preview is audited without Lighthouse.
 */
export async function withVercelAudit(accountId: string, options: AuditOptions): Promise<{ options: AuditOptions; note: string }> {
  if (!loadSite(accountId).vercel?.projectId) return { options, note: "" };
  if (options.target === "preview" && !options.url) {
    const t = await previewTarget(accountId, options.deps);
    if (t.protectedWithoutBypass) {
      throw new SiteError(msg("The preview is behind Vercel Deployment Protection and no bypass secret is stored: create one in the Website tab (Vercel), then audit again."), 409);
    }
    if (!t.hostHeaders) return { options: { ...options, url: t.url }, note: "" };
    return { options: { ...options, url: t.url, lighthouse: false, deps: { ...options.deps, hostHeaders: t.hostHeaders } }, note: "Protected Vercel preview read with the bypass secret; PageSpeed (Lighthouse) skipped: it cannot pass the bypass." };
  }
  if (options.url) {
    const hostHeaders = await bypassFor(accountId, options.url, options.deps);
    if (hostHeaders) return { options: { ...options, lighthouse: false, deps: { ...options.deps, hostHeaders } }, note: "Protected Vercel preview read with the bypass secret; PageSpeed (Lighthouse) skipped: it cannot pass the bypass." };
  }
  return { options, note: "" };
}
