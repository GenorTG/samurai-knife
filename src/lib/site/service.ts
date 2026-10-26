import { randomBytes } from "node:crypto";
import { isAdmin } from "@/lib/accounts/authz";
import { getAccount, type Account } from "@/lib/accounts/store";
import { getRunner, runOk } from "@/lib/cv/showcase/runner";
import { installationToken, repoAccessOf, userInstallationRepos, type UserRepoAccess } from "@/lib/github-app/installations";
import { recordSecurityEvent } from "@/lib/security/events";
import { consumeOutbound, outboundLimitMessage } from "@/lib/net/outbound";
import * as github from "./github";
import { verifyProductionUrl } from "./ownership";
import { SiteError } from "./net";
import { loadSite, mutateSite, siteView, type LinkedInstallation, type SiteConnection } from "./store";
import { normalizePaths } from "./audit/run";
import { msg, msgf } from "@/lib/i18n/msg";

/**
 * Website studio operations (docs/WEBSITE-STUDIO.md), shared by the HTTP routes and the knife_site_* tools. Every change
 * goes to the account's work branch (`knife/<date>-<id>`, created from the base branch on the first write) and reaches the
 * base branch only through `publish` (squash-merge of the pull request), which the tools never call: the user publishes.
 */

export interface ConnectInput {
  repo: string;
  baseBranch?: string;
  productionUrl?: string;
  pages?: string[];
  /** "pat" needs `token` (unless already connected with one and only settings change); "host-gh" is for admins; "app" needs `installationId`. */
  tokenSource?: "pat" | "host-gh" | "app";
  installationId?: number;
  token?: string;
  psiKey?: string;
}

function account(accountId: string): Account {
  const a = getAccount(accountId);
  if (!a) throw new SiteError("unknown account", 404);
  return a;
}

function spend(a: Account): void {
  const budget = consumeOutbound(a, "github", github.GITHUB_API());
  if (!budget.ok) throw new SiteError(outboundLimitMessage(budget.retryAfterSeconds), 429);
}

async function hostToken(a: Account): Promise<string> {
  if (!isAdmin(a)) throw new SiteError("only an administrator may use the server's GitHub login; connect with your own token", 403);
  const res = await getRunner()(["gh", "auth", "token"]);
  const token = res.stdout.trim();
  if (!runOk(res) || !token) throw new SiteError("the server's gh CLI is not logged in (run `gh auth login` on the host) or not installed", 502);
  return token;
}

/* ------------------------------------------------------------------ GitHub App: who may use which repository */

/**
 * An app installation's token can write every repository the app is installed on, so the app path is scoped per USER
 * (audit H1): at link time we store, per installation, the repositories GitHub lists for the user's own token with
 * their push right; connecting needs the repository in that list with push; and every site operation re-checks the
 * linked GitHub user's current permission (cached ACCESS_TTL): unlinked, uninstalled or lost access drops the connection.
 */
const ACCESS_KEY = Symbol.for("samurai-knife.github-app-access.v1");
const MAX_ACCESS_CACHE = 2_000;

function accessTtlMs(): number {
  const raw = Number(process.env.KNIFE_GITHUB_ACCESS_TTL_SEC ?? "");
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 3_600) * 1_000 : 5 * 60_000;
}

function accessCache(): Map<string, number> {
  const g = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  const m = g[ACCESS_KEY];
  return m instanceof Map ? m : (g[ACCESS_KEY] = new Map());
}

/** Tests only. */
export function clearAppAccessCache(): void {
  accessCache().clear();
}

function linkedRepo(site: ReturnType<typeof loadSite>, installationId: number, repo: string): UserRepoAccess | null {
  const inst = site.github?.installations.find((i) => i.id === installationId);
  return inst?.repos.find((r) => r.fullName.toLowerCase() === repo.toLowerCase()) ?? null;
}

function dropAppConnection(accountId: string, why: string): never {
  mutateSite(accountId, (s) => {
    if (s.connection?.token.source !== "app") return;
    s.connection = null;
    s.work = null;
    s.lastAction = { kind: "disconnected", at: new Date().toISOString(), detail: why };
  });
  recordSecurityEvent({ kind: "github_app_access_lost", account: accountId, detail: { reason: why.slice(0, 120) } });
  throw new SiteError(msgf("the website connection was removed: {why}. Connect again (Connect tab) if you still have access.", { why }), 403);
}

/** May this account (still) use the app installation on `repo`? Throws (and drops the connection) when not. */
async function assertAppAccess(a: Account, installationId: number, repo: string, fresh = false): Promise<void> {
  const github = getAccount(a.id)?.github;
  if (!github) dropAppConnection(a.id, "GitHub is no longer linked to this account");
  const site = loadSite(a.id);
  const listed = linkedRepo(site, installationId, repo);
  if (!listed?.push) dropAppConnection(a.id, msgf("your GitHub user @{login} has no push access to {repo} in the linked installation", { login: github.login, repo }));
  const key = `${a.id}|${installationId}|${repo.toLowerCase()}|${github.id}`;
  const cache = accessCache();
  const at = cache.get(key);
  if (!fresh && at !== undefined && Date.now() - at < accessTtlMs()) return;
  let access: Awaited<ReturnType<typeof repoAccessOf>>;
  try {
    access = await repoAccessOf(installationId, repo, github.login, github.id);
  } catch (error) {
    // "No longer installed" is a definite loss; anything else (an outage) refuses this operation and keeps the connection.
    if (error instanceof SiteError && error.status === 409) dropAppConnection(a.id, error.message);
    throw error;
  }
  if (access !== "push") {
    cache.delete(key);
    dropAppConnection(a.id, msgf("GitHub says @{login} can no longer push to {repo}", { login: github.login, repo }));
  }
  if (cache.size >= MAX_ACCESS_CACHE) cache.delete(cache.keys().next().value as string);
  cache.set(key, Date.now());
}

async function tokenOf(a: Account, c: SiteConnection): Promise<string> {
  if (c.token.source === "pat") return c.token.value;
  if (c.token.source === "app") {
    await assertAppAccess(a, c.token.installationId, c.repo);
    return installationToken(c.token.installationId, c.repo);
  }
  return hostToken(a);
}

export function checkUrl(value: string): string {
  const v = value.trim();
  if (!v) return "";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new SiteError(msgf("'{v}' is not a valid URL", { v: v.slice(0, 200) }));
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new SiteError("the site URL must be http(s) without credentials");
  return u.origin + (u.pathname === "/" ? "" : u.pathname.replace(/\/$/, ""));
}

export async function connect(accountId: string, input: ConnectInput) {
  const a = account(accountId);
  const current = loadSite(accountId).connection;
  const repo = github.checkRepo(input.repo);
  const source = input.tokenSource ?? (input.token ? "pat" : current?.token.source ?? "pat");
  let token: string;
  let stored: SiteConnection["token"];
  if (source === "host-gh") {
    token = await hostToken(a);
    stored = { source: "host-gh", login: "" };
  } else if (source === "app") {
    const site = loadSite(accountId);
    const installationId = input.installationId ?? (current?.token.source === "app" ? current.token.installationId : undefined);
    const linked = site.github?.installations.find((i) => i.id === installationId);
    if (!installationId || !linked) throw new SiteError("that GitHub App installation is not linked to your account: use Connect with GitHub first", 403);
    if (!getAccount(accountId)?.github) throw new SiteError("link GitHub to this account first (Account settings, or Connect with GitHub)", 403);
    // Only repositories GitHub listed for THIS user's own token, with push (never the installation's whole list).
    const access = linkedRepo(site, installationId, repo);
    if (!access) throw new SiteError(msgf("{repo} is not one of your repositories in that installation (or the app is not installed on it): add it on GitHub, then Connect with GitHub again", { repo }), 403);
    if (!access.push) throw new SiteError(msgf("your GitHub user has no write access to {repo}: ask its owner for write access, then Connect with GitHub again", { repo }), 403);
    spend(a);
    await assertAppAccess(a, installationId, repo, true);
    token = await installationToken(installationId, repo);
    stored = { source: "app", installationId, login: site.github?.login ?? linked.account };
  } else {
    const given = input.token?.trim();
    if (given) {
      if (!/^[A-Za-z0-9_]{20,255}$/.test(given)) throw new SiteError("that does not look like a GitHub token (ghp_..., github_pat_...)");
      token = given;
    } else if (current?.token.source === "pat") token = current.token.value;
    else throw new SiteError("a GitHub token is needed: create a fine-grained token for this repository with Contents and Pull requests (read and write)");
    stored = { source: "pat", value: token, login: "" };
  }
  if (stored.source !== "app") spend(a); // the app path paid before its live permission check
  // Installation tokens are not a user: /user answers 403 for them (the login comes from the linked sign-in instead).
  if (stored.source !== "app") stored.login = (await github.getUser(token)).login;
  const info = await github.getRepo(token, repo);
  const baseBranch = github.checkBranch(input.baseBranch?.trim() || info.defaultBranch);
  if (!(await github.branchSha(token, repo, baseBranch))) throw new SiteError(msgf("branch {baseBranch} does not exist in {repo}", { baseBranch, repo }), 404);
  const productionUrl = checkUrl(input.productionUrl ?? current?.productionUrl ?? info.homepage ?? "");
  const pages = normalizePaths(input.pages ?? current?.pages ?? []);
  const psiKey = input.psiKey === undefined ? current?.psiKey ?? "" : input.psiKey.trim();
  if (psiKey && !/^[A-Za-z0-9_-]{20,100}$/.test(psiKey)) throw new SiteError("that does not look like a Google API key");
  // Proof that the production URL is this repository's site (ownership.ts), checked with the same token.
  const verifiedOrigin = await verifyProductionUrl(token, info.fullName, productionUrl, info.homepage);
  const connection: SiteConnection = { repo: info.fullName, baseBranch, productionUrl, pages, token: stored, psiKey, verifiedOrigin, connectedAt: current?.connectedAt ?? new Date().toISOString() };
  mutateSite(accountId, (s) => {
    // A different repository or base branch: the old work branch belongs to the old target.
    if (s.connection && (s.connection.repo !== connection.repo || s.connection.baseBranch !== connection.baseBranch)) s.work = null;
    s.connection = connection;
  });
  // An installation token carries the app's permissions (contents: write), not a user's: GitHub reports none for it.
  const canPush = info.canPush || stored.source === "app";
  return { view: siteView(loadSite(accountId)), repo: { ...info, canPush }, warning: canPush ? "" : "this token can read the repository but not push: audits work, changes will be refused" };
}

export function disconnect(accountId: string) {
  mutateSite(accountId, (s) => {
    s.connection = null;
    s.work = null;
  });
  return siteView(loadSite(accountId));
}

interface Ctx {
  a: Account;
  c: SiteConnection;
  token: string;
}

async function ctx(accountId: string): Promise<Ctx> {
  const a = account(accountId);
  const c = loadSite(accountId).connection;
  if (!c) throw new SiteError("no repository connected: connect one in the website studio (Connect tab) first", 409);
  spend(a);
  return { a, c, token: await tokenOf(a, c) };
}

/** The ref reads should use: the work branch when it exists (it has the newest edits), else the base branch. */
async function readRef(accountId: string, x: Ctx): Promise<string> {
  const work = loadSite(accountId).work;
  if (work && (await github.branchSha(x.token, x.c.repo, work.branch))) return work.branch;
  return x.c.baseBranch;
}

export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md", "CONTENT_BRIEF.md", "README.md"];
const INSTRUCTION_CHARS = 6_000;

/** Connection + the repository's own instructions for agents (AGENTS.md, CLAUDE.md...) + latest audit summary. */
export async function status(accountId: string) {
  const site = loadSite(accountId);
  const view = siteView(site);
  if (!site.connection) return { ...view, instructions: [] as { path: string; text: string }[], repo: null };
  const x = await ctx(accountId);
  const info = await github.getRepo(x.token, x.c.repo);
  const repo = { ...info, canPush: info.canPush || x.c.token.source === "app" };
  const ref = await readRef(accountId, x);
  const { entries } = await github.getTree(x.token, x.c.repo, ref);
  const instructions: { path: string; text: string }[] = [];
  for (const path of INSTRUCTION_FILES) {
    if (!entries.some((e) => e.type === "file" && e.path === path)) continue;
    const file = await github.getFile(x.token, x.c.repo, path, ref);
    if (file.text) instructions.push({ path, text: file.text.slice(0, INSTRUCTION_CHARS) + (file.text.length > INSTRUCTION_CHARS ? "\n…(truncated: read the whole file with knife_site_read)" : "") });
  }
  return { ...view, repo, ref, instructions };
}

export async function listFiles(accountId: string, prefix = "", ref?: string) {
  const x = await ctx(accountId);
  const r = ref || (await readRef(accountId, x));
  const p = prefix.trim().replace(/^\/+|\/+$/g, "");
  if (p) github.checkPath(p);
  const { entries, truncated } = await github.getTree(x.token, x.c.repo, r);
  const under = entries.filter((e) => !p || e.path === p || e.path.startsWith(`${p}/`));
  // Directly inside the prefix only, plus a file count per sub-directory: a big repo stays readable.
  const depth = p ? p.split("/").length + 1 : 1;
  const direct = under.filter((e) => e.path.split("/").length === depth);
  const dirs = direct.filter((e) => e.type === "dir").map((d) => ({ path: d.path, type: "dir" as const, files: under.filter((e) => e.type === "file" && e.path.startsWith(`${d.path}/`)).length }));
  const files = direct.filter((e) => e.type === "file").map((f) => ({ path: f.path, type: "file" as const, size: f.size }));
  return { ref: r, prefix: p, entries: [...dirs, ...files].slice(0, 500), totalFiles: under.filter((e) => e.type === "file").length, truncated };
}

export async function readFile(accountId: string, path: string, ref?: string) {
  const x = await ctx(accountId);
  return github.getFile(x.token, x.c.repo, path, ref || (await readRef(accountId, x)));
}

export async function search(accountId: string, query: string) {
  if (!query.trim()) throw new SiteError("give a search text");
  const x = await ctx(accountId);
  return { note: "GitHub's code index covers the default branch only.", hits: await github.searchCode(x.token, x.c.repo, query) };
}

async function ensureWorkBranch(accountId: string, x: Ctx): Promise<string> {
  const work = loadSite(accountId).work;
  if (work && (await github.branchSha(x.token, x.c.repo, work.branch))) return work.branch;
  const baseSha = await github.branchSha(x.token, x.c.repo, x.c.baseBranch);
  if (!baseSha) throw new SiteError(msgf("the base branch {baseBranch} is gone", { baseBranch: x.c.baseBranch }), 404);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const branch = `knife/${stamp}-${randomBytes(3).toString("hex")}`;
  await github.createBranch(x.token, x.c.repo, branch, baseSha);
  mutateSite(accountId, (s) => {
    s.work = { branch, base: x.c.baseBranch, createdAt: new Date().toISOString(), pull: null };
  });
  return branch;
}

export const MAX_CHANGED_FILES = 25;

export async function writeFiles(accountId: string, message: string, changes: github.FileChange[]) {
  const msg = message.trim();
  if (!msg) throw new SiteError("a commit message is needed (what changes and why)");
  if (!changes.length) throw new SiteError("nothing to write");
  if (changes.length > MAX_CHANGED_FILES) throw new SiteError(`at most ${MAX_CHANGED_FILES} files per commit`);
  for (const ch of changes) {
    github.checkPath(ch.path, true);
    if ("content" in ch && Buffer.byteLength(ch.content) > github.MAX_FILE_BYTES) throw new SiteError(msgf("{path} is larger than 1 MB", { path: ch.path }));
  }
  const x = await ctx(accountId);
  const branch = await ensureWorkBranch(accountId, x);
  const commit = await github.commitFiles(x.token, x.c.repo, branch, msg.slice(0, 2000), changes);
  mutateSite(accountId, () => undefined); // revision bump: open pages refresh
  return { branch, commit, files: changes.map((c) => c.path), next: "Open (or update) the pull request with knife_site_pr; the user reviews and publishes it." };
}

/** Exact text replacement in one file of the work branch (the safest edit for copy changes). */
export async function replaceText(accountId: string, path: string, find: string, replace: string, message: string, all = false) {
  if (!find) throw new SiteError("`find` must not be empty");
  const file = await readFile(accountId, path);
  if (file.text === null) throw new SiteError(msgf("{path} cannot be edited as text ({note})", { path, note: file.note }));
  const count = file.text.split(find).length - 1;
  if (count === 0) throw new SiteError(msgf("the text to replace was not found in {path} (read the file again: it may have changed)", { path }), 409);
  if (count > 1 && !all) throw new SiteError(msgf("the text occurs {count} times in {path}: give a longer, unique snippet or set all=true", { count, path }), 409);
  const next = all ? file.text.split(find).join(replace) : file.text.replace(find, () => replace);
  const result = await writeFiles(accountId, message, [{ path: file.path, content: next }]);
  return { ...result, replaced: all ? count : 1 };
}

export async function openPull(accountId: string, title: string, body: string) {
  const x = await ctx(accountId);
  const work = loadSite(accountId).work;
  if (!work || !(await github.branchSha(x.token, x.c.repo, work.branch))) throw new SiteError("there are no changes yet: write files first (knife_site_write / knife_site_replace)", 409);
  const t = title.trim().slice(0, 250) || "Website update from Smart Knife";
  const b = msgf("{value}\n\n---\nPrepared in the Smart Knife website studio. Review the preview, then publish from the studio (or merge here).", { value: body.trim().slice(0, 20_000) });
  let pull = await github.openPullFor(x.token, x.c.repo, work.branch);
  pull = pull ? await github.updatePull(x.token, x.c.repo, pull.number, { title: t, body: b }) : await github.createPull(x.token, x.c.repo, { title: t, body: b, head: work.branch, base: x.c.baseBranch });
  const number = pull.number;
  mutateSite(accountId, (s) => {
    if (s.work) s.work.pull = number;
  });
  return pull;
}

/** Everything the Changes view shows: work branch vs base (commits, files with patches), the PR, checks, preview URL. */
export async function changes(accountId: string) {
  const site = loadSite(accountId);
  if (!site.connection) throw new SiteError("no repository connected", 409);
  const x = await ctx(accountId);
  const work = site.work;
  if (!work) return { work: null, compare: null, pull: null, checks: null, lastAction: site.lastAction };
  const head = await github.branchSha(x.token, x.c.repo, work.branch);
  if (!head) {
    // Deleted on GitHub (merged and cleaned up there, or by hand): forget it.
    mutateSite(accountId, (s) => {
      s.work = null;
      s.lastAction = { kind: "gone", at: new Date().toISOString(), detail: msgf("branch {branch} no longer exists on GitHub", { branch: work.branch }) };
    });
    return { work: null, compare: null, pull: null, checks: null, lastAction: loadSite(accountId).lastAction };
  }
  const compare = await github.compare(x.token, x.c.repo, x.c.baseBranch, work.branch);
  const pull = work.pull ? await github.getPull(x.token, x.c.repo, work.pull) : await github.openPullFor(x.token, x.c.repo, work.branch);
  if (pull?.merged) {
    mutateSite(accountId, (s) => {
      s.work = null;
      s.lastAction = { kind: "published", at: new Date().toISOString(), detail: msgf("pull request #{number} was merged on GitHub", { number: pull.number }) };
    });
  }
  const checks = await github.commitChecks(x.token, x.c.repo, head);
  return { work: { ...work, head }, compare, pull, checks, lastAction: site.lastAction };
}

/**
 * Publish = squash-merge the pull request into the base branch (the host deploys it to production). Only from the UI,
 * after the user saw the diff: `expectedHead` must still be the branch head (no change slipped in since).
 */
export async function publish(accountId: string, expectedHead: string) {
  const x = await ctx(accountId);
  const work = loadSite(accountId).work;
  if (!work) throw new SiteError("there is nothing to publish", 409);
  const head = await github.branchSha(x.token, x.c.repo, work.branch);
  if (!head) throw new SiteError("the work branch is gone", 409);
  if (head !== expectedHead) throw new SiteError("the changes moved on since you reviewed them: look at the diff again, then publish", 409);
  let pull = work.pull ? await github.getPull(x.token, x.c.repo, work.pull) : await github.openPullFor(x.token, x.c.repo, work.branch);
  if (!pull) pull = await openPull(accountId, "Website update from Smart Knife", "");
  if (pull.mergeable === false) throw new SiteError(msg("GitHub cannot merge this pull request (conflicts with the base branch): resolve them on GitHub"), 409);
  const merged = await github.mergePull(x.token, x.c.repo, pull.number, head, `${pull.title} (#${pull.number})`);
  await github.deleteBranch(x.token, x.c.repo, work.branch);
  mutateSite(accountId, (s) => {
    s.work = null;
    s.lastAction = { kind: "published", at: new Date().toISOString(), detail: `#${pull.number} merged into ${x.c.baseBranch} as ${merged.sha.slice(0, 7)}` };
  });
  return { merged: merged.sha, pull: pull.number, url: pull.url };
}

/** Throw the work away: close the pull request and delete the branch. Only from the UI. */
export async function discard(accountId: string) {
  const x = await ctx(accountId);
  const work = loadSite(accountId).work;
  if (!work) throw new SiteError("there are no changes to discard", 409);
  const pull = work.pull ? await github.getPull(x.token, x.c.repo, work.pull).catch(() => null) : await github.openPullFor(x.token, x.c.repo, work.branch);
  if (pull && pull.state === "open") await github.updatePull(x.token, x.c.repo, pull.number, { state: "closed" });
  await github.deleteBranch(x.token, x.c.repo, work.branch);
  mutateSite(accountId, (s) => {
    s.work = null;
    s.lastAction = { kind: "discarded", at: new Date().toISOString(), detail: `branch ${work.branch}${pull ? ` and #${pull.number}` : ""} discarded` };
  });
  return { discarded: work.branch };
}

/** Installations whose repositories are read per link (each costs up to 3 GitHub calls). */
export const MAX_LINKED_INSTALLATIONS = 20;

/**
 * After a GitHub sign-in or link: the installations GitHub lists for this user, each with the repositories THIS user can
 * access there (user token) and their push right. Replaces the previous list, so a lost repository disappears; an app
 * connection whose repository is no longer listed with push is dropped at once.
 */
export async function linkInstallations(accountId: string, login: string, userToken: string, installations: { id: number; account: string; accountType: string }[]) {
  const linked: LinkedInstallation[] = [];
  for (const inst of installations.slice(0, MAX_LINKED_INSTALLATIONS)) {
    let repos: UserRepoAccess[] = [];
    let reposVerified = false;
    try {
      repos = await userInstallationRepos(userToken, inst.id);
      reposVerified = true;
    } catch {
      /* listed without repositories: nothing in it is connectable until the next sign-in */
    }
    linked.push({ ...inst, repos, reposVerified });
  }
  let dropped = false;
  mutateSite(accountId, (site) => {
    site.github = { login, installations: linked, checkedAt: new Date().toISOString() };
    const c = site.connection;
    if (c?.token.source === "app" && !linkedRepo(site, c.token.installationId, c.repo)?.push) {
      site.connection = null;
      site.work = null;
      site.lastAction = { kind: "disconnected", at: new Date().toISOString(), detail: msgf("GitHub no longer lists push access to {repo} for @{login}", { repo: c.repo, login }) };
      dropped = true;
    }
  });
  if (dropped) recordSecurityEvent({ kind: "github_app_access_lost", account: accountId, detail: { reason: "relink" } });
}

/** GitHub unlinked: the installation list goes, and so does a connection that used the app (it was this user's right). */
export function forgetInstallations(accountId: string) {
  mutateSite(accountId, (site) => {
    site.github = null;
    if (site.connection?.token.source === "app") {
      site.connection = null;
      site.work = null;
      site.lastAction = { kind: "disconnected", at: new Date().toISOString(), detail: "GitHub was unlinked from this account" };
    }
  });
}

/** For the Connect picker: per linked installation, only the repositories this user may push to (no GitHub call). */
export function appRepositories(accountId: string) {
  const site = loadSite(accountId);
  if (!site.github) return { login: null, installations: [] as { id: number; account: string; accountType: string; repos: UserRepoAccess[]; error: string }[] };
  const installations = site.github.installations.map(({ repos, reposVerified, ...inst }) => ({
    ...inst,
    repos: repos.filter((r) => r.push),
    error: reposVerified ? "" : "the repository list could not be read at sign-in: use Connect with GitHub again",
  }));
  return { login: site.github.login, installations, checkedAt: site.github.checkedAt };
}
