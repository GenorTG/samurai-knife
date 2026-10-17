import { checkRepo, gh } from "@/lib/site/github";
import { SiteError } from "@/lib/site/net";
import { appJwt, loadApp } from "./config";

/**
 * Installation tokens: minted per call need with the app's JWT, scoped to ONE repository when one is named, valid one
 * hour; cached in memory until 5 minutes before they expire. Nothing is stored on disk.
 */

const KEY = Symbol.for("samurai-knife.github-installation-tokens.v1");
function cache(): Map<string, { token: string; expiresAt: number }> {
  const g = globalThis as unknown as Record<symbol, Map<string, { token: string; expiresAt: number }> | undefined>;
  return (g[KEY] ??= new Map());
}

function requireApp() {
  const app = loadApp();
  if (!app) throw new SiteError("this server has no GitHub App yet: an administrator creates it on the Users page (GitHub App panel)", 409);
  return app;
}

/** A token for `installationId`, limited to `repo` ("owner/name") when given. */
export async function installationToken(installationId: number, repo?: string): Promise<string> {
  const key = `${installationId}|${repo ?? "*"}`;
  const hit = cache().get(key);
  if (hit && hit.expiresAt - Date.now() > 5 * 60_000) return hit.token;
  const app = requireApp();
  const body = repo ? { repositories: [repo.split("/")[1]] } : {};
  let res: { token?: string; expires_at?: string };
  try {
    res = await gh(appJwt(app), "POST", `/app/installations/${installationId}/access_tokens`, body);
  } catch (error) {
    if (error instanceof SiteError && (error.status === 404 || error.status === 401)) {
      throw new SiteError("the GitHub App is no longer installed there (or lost access to the repository): install it again from Connect", 409);
    }
    throw error;
  }
  if (!res.token) throw new SiteError("GitHub returned no installation token", 502);
  const expiresAt = res.expires_at ? Date.parse(res.expires_at) : Date.now() + 55 * 60_000;
  cache().set(key, { token: res.token, expiresAt });
  return res.token;
}

export async function installationRepos(installationId: number): Promise<{ fullName: string; private: boolean; defaultBranch: string; htmlUrl: string }[]> {
  const token = await installationToken(installationId);
  const out: { fullName: string; private: boolean; defaultBranch: string; htmlUrl: string }[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const res = await gh<{ repositories?: Record<string, unknown>[] }>(token, "GET", `/installation/repositories?per_page=100&page=${page}`);
    const repos = res.repositories ?? [];
    for (const r of repos) out.push({ fullName: String(r.full_name), private: Boolean(r.private), defaultBranch: String(r.default_branch ?? "main"), htmlUrl: String(r.html_url ?? "") });
    if (repos.length < 100) break;
  }
  return out;
}

/** One repository of an installation as THIS user sees it (user-token list), with the user's own push right. */
export interface UserRepoAccess {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  push: boolean;
}

export const MAX_USER_REPOS = 300;

/**
 * The repositories of `installationId` that the signed-in GitHub user can access, with their permissions, from the
 * USER token (`GET /user/installations/{id}/repositories`). Unlike `installationRepos` (every repository the app is
 * installed on), this is what one person may touch: an org member does not get the org's other private repositories.
 */
export async function userInstallationRepos(userToken: string, installationId: number): Promise<UserRepoAccess[]> {
  const out: UserRepoAccess[] = [];
  for (let page = 1; page <= MAX_USER_REPOS / 100; page += 1) {
    const res = await gh<{ repositories?: Record<string, unknown>[] }>(userToken, "GET", `/user/installations/${installationId}/repositories?per_page=100&page=${page}`);
    const repos = res.repositories ?? [];
    for (const r of repos) {
      const permissions = (r.permissions ?? {}) as Record<string, unknown>;
      out.push({
        fullName: String(r.full_name ?? ""),
        private: Boolean(r.private),
        defaultBranch: String(r.default_branch ?? "main"),
        htmlUrl: String(r.html_url ?? ""),
        push: permissions.push === true || permissions.admin === true || permissions.maintain === true,
      });
    }
    if (repos.length < 100) break;
  }
  return out.filter((r) => r.fullName.includes("/")).slice(0, MAX_USER_REPOS);
}

export type RepoAccess = "push" | "read" | "none";

/**
 * Re-validation without the user's token (it is never stored): ask GitHub, with an installation token for that one
 * repository, what the linked GitHub user (`login`, checked against the stable `githubId`) may do there now.
 * `none` = no access or another user holds the login (renamed); a GitHub outage throws (fail closed, nothing dropped).
 */
export async function repoAccessOf(installationId: number, repo: string, login: string, githubId: number): Promise<RepoAccess> {
  const token = await installationToken(installationId, repo);
  let res: { permission?: string; user?: { id?: number; permissions?: Record<string, unknown> } | null };
  try {
    res = await gh(token, "GET", `/repos/${checkRepo(repo)}/collaborators/${encodeURIComponent(login)}/permission`);
  } catch (error) {
    if (error instanceof SiteError && error.status === 404) return "none";
    throw error;
  }
  if (!res.user || Number(res.user.id) !== githubId) return "none";
  const p = res.user.permissions ?? {};
  if (p.push === true || p.admin === true || p.maintain === true || res.permission === "admin" || res.permission === "write") return "push";
  return res.permission === "read" || p.pull === true ? "read" : "none";
}

/** Tests only. */
export function clearInstallationTokens(): void {
  cache().clear();
}
