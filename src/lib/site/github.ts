// SERVER ONLY. A small GitHub REST client for the website studio: the account's own token, the SSRF-guarded transport
// (net.ts), no git binary and no clone. Changes are made with the Git Data API (one commit per call, any number of files)
// on a work branch; the default branch is only ever changed by merging a pull request (docs/WEBSITE-STUDIO.md).
import { apiJson, SiteError, type NetDeps } from "./net";
import { msg, msgf } from "@/lib/i18n/msg";

export const GITHUB_API = (): string => (process.env.KNIFE_GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/+$/, "");

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** Largest text file read or written through the studio. */
export const MAX_FILE_BYTES = 1_000_000;

export function checkRepo(repo: string): string {
  const parts = repo.trim().split("/");
  if (parts.length !== 2 || !parts.every((p) => NAME.test(p) && p !== "." && p !== ".." && !p.endsWith(".git"))) {
    throw new SiteError(`the repository must look like 'owner/name', got '${repo.slice(0, 100)}'`);
  }
  return parts.join("/");
}

export function checkBranch(branch: string): string {
  if (!BRANCH.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.endsWith(".lock") || branch.includes("//")) {
    throw new SiteError(`'${branch.slice(0, 100)}' is not a usable branch name`);
  }
  return branch;
}

/**
 * A repo-relative file path the studio may write. Refused: absolute or `..` paths, `.git/`, workflow files (they need a
 * token with the `workflow` scope and run code in CI), and real env files (secrets never go through an agent into git).
 */
export function checkPath(path: string, forWrite = false): string {
  const p = path.trim().replace(/^\.\//, "");
  if (!p || p.length > 400 || p.startsWith("/") || /[\u0000-\u001f\\]/.test(p)) throw new SiteError(`'${path.slice(0, 120)}' is not a repository path`);
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) throw new SiteError(`'${path.slice(0, 120)}' is not a repository path`);
  if (parts[0] === ".git") throw new SiteError("the .git directory is not part of the files");
  if (forWrite && parts[0] === ".github" && parts[1] === "workflows") throw new SiteError("CI workflow files are not edited from the studio (they run code in GitHub Actions)");
  const base = parts.at(-1)!;
  if (forWrite && /^\.env(\..+)?$/.test(base) && !/^\.env\.(example|sample|template)$/.test(base)) throw new SiteError(msgf("{base} holds secrets: it is not written from the studio", { base }));
  return p;
}

type Json = Record<string, unknown>;

export interface GitHubDeps extends NetDeps {
  apiBase?: string;
}

/** One API call; maps GitHub's errors to readable SiteErrors (401 token, 403 permission/rate limit, 404 no access). */
export async function gh<T = unknown>(token: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown, deps: GitHubDeps = {}, accept = "application/vnd.github+json"): Promise<T> {
  const url = `${deps.apiBase ?? GITHUB_API()}${path}`;
  const res = await apiJson(url, {
    method,
    body,
    headers: { authorization: `Bearer ${token}`, accept, "x-github-api-version": "2022-11-28" },
  }, deps);
  if (res.status >= 200 && res.status < 300) return res.body as T;
  const message = typeof (res.body as Json | null)?.message === "string" ? String((res.body as Json).message).slice(0, 300) : `HTTP ${res.status}`;
  if (res.status === 401) throw new SiteError(msg("GitHub refused the token (expired or revoked): connect again with a new one"), 401);
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") throw new SiteError(msg("GitHub's API rate limit for this token is used up; try again later"), 429);
  if (res.status === 403) throw new SiteError(msgf("GitHub: the token may not do this ({message}). A fine-grained token needs Contents and Pull requests: read and write on the repository", { message }), 403);
  if (res.status === 404) throw new SiteError(msgf("GitHub: not found or no access ({method} {value})", { method, value: path.split("?")[0] }), 404);
  if (res.status === 409) throw new SiteError(msgf("GitHub: conflict ({message})", { message }), 409);
  if (res.status === 422) throw new SiteError(msgf("GitHub rejected the request: {message}", { message }), 422);
  throw new SiteError(msgf("GitHub answered HTTP {status}: {message}", { status: res.status, message }), 502);
}

export interface RepoInfo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  canPush: boolean;
  htmlUrl: string;
  homepage: string;
  description: string;
  pushedAt: string;
}

export async function getUser(token: string, deps?: GitHubDeps): Promise<{ login: string }> {
  const user = await gh<Json>(token, "GET", "/user", undefined, deps);
  return { login: String(user.login ?? "") };
}

export async function getRepo(token: string, repo: string, deps?: GitHubDeps): Promise<RepoInfo> {
  const r = await gh<Json>(token, "GET", `/repos/${checkRepo(repo)}`, undefined, deps);
  const perms = (r.permissions ?? {}) as Json;
  return {
    fullName: String(r.full_name ?? repo),
    defaultBranch: String(r.default_branch ?? "main"),
    private: Boolean(r.private),
    canPush: Boolean(perms.push ?? perms.admin ?? perms.maintain),
    htmlUrl: String(r.html_url ?? `https://github.com/${repo}`),
    homepage: String(r.homepage ?? ""),
    description: String(r.description ?? ""),
    pushedAt: String(r.pushed_at ?? ""),
  };
}

/** Head commit of a branch, or null when the branch does not exist. */
export async function branchSha(token: string, repo: string, branch: string, deps?: GitHubDeps): Promise<string | null> {
  try {
    const ref = await gh<Json>(token, "GET", `/repos/${checkRepo(repo)}/git/ref/heads/${encodeBranch(checkBranch(branch))}`, undefined, deps);
    return String(((ref.object ?? {}) as Json).sha ?? "") || null;
  } catch (error) {
    if (error instanceof SiteError && error.status === 404) return null;
    throw error;
  }
}

function encodeBranch(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export interface TreeEntry {
  path: string;
  type: "file" | "dir";
  size: number;
}

export async function getTree(token: string, repo: string, ref: string, deps?: GitHubDeps): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const tree = await gh<Json>(token, "GET", `/repos/${checkRepo(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`, undefined, deps);
  const entries = ((tree.tree ?? []) as Json[])
    .filter((e) => e.type === "blob" || e.type === "tree")
    .map((e) => ({ path: String(e.path), type: e.type === "tree" ? ("dir" as const) : ("file" as const), size: Number(e.size ?? 0) }));
  return { entries, truncated: Boolean(tree.truncated) };
}

export interface RepoFile {
  path: string;
  ref: string;
  sha: string;
  size: number;
  /** UTF-8 text, or null for binary files / files over MAX_FILE_BYTES. */
  text: string | null;
  note: string;
}

function looksBinary(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 8000);
  return head.includes(0);
}

export async function getFile(token: string, repo: string, path: string, ref: string, deps?: GitHubDeps): Promise<RepoFile> {
  const p = checkPath(path);
  const got = await gh<Json | Json[]>(token, "GET", `/repos/${checkRepo(repo)}/contents/${encodePath(p)}?ref=${encodeURIComponent(ref)}`, undefined, deps);
  if (Array.isArray(got)) throw new SiteError(msgf("{p} is a directory: list it with the file tree instead", { p }));
  const size = Number(got.size ?? 0);
  const sha = String(got.sha ?? "");
  if (size > MAX_FILE_BYTES) return { path: p, ref, sha, size, text: null, note: `larger than ${MAX_FILE_BYTES / 1_000_000} MB: not read` };
  let raw: Buffer;
  if (typeof got.content === "string" && got.encoding === "base64" && got.content.length > 0) raw = Buffer.from(got.content, "base64");
  else {
    // Files over 1 MB come without content from the contents API: the blob API has them.
    const blob = await gh<Json>(token, "GET", `/repos/${checkRepo(repo)}/git/blobs/${sha}`, undefined, deps);
    raw = Buffer.from(String(blob.content ?? ""), "base64");
  }
  if (looksBinary(raw)) return { path: p, ref, sha, size, text: null, note: "binary file" };
  return { path: p, ref, sha, size, text: raw.toString("utf8"), note: "" };
}

export interface SearchHit {
  path: string;
  fragments: string[];
}

/** GitHub code search inside the repo (its index covers the default branch only). */
export async function searchCode(token: string, repo: string, query: string, deps?: GitHubDeps): Promise<SearchHit[]> {
  const q = `${query.replace(/\s+/g, " ").trim().slice(0, 200)} repo:${checkRepo(repo)}`;
  const res = await gh<Json>(token, "GET", `/search/code?per_page=30&q=${encodeURIComponent(q)}`, undefined, deps, "application/vnd.github.text-match+json");
  return ((res.items ?? []) as Json[]).map((item) => ({
    path: String(item.path),
    fragments: ((item.text_matches ?? []) as Json[]).map((m) => String(m.fragment ?? "").slice(0, 400)),
  }));
}

export async function createBranch(token: string, repo: string, branch: string, fromSha: string, deps?: GitHubDeps): Promise<void> {
  await gh(token, "POST", `/repos/${checkRepo(repo)}/git/refs`, { ref: `refs/heads/${checkBranch(branch)}`, sha: fromSha }, deps);
}

export async function deleteBranch(token: string, repo: string, branch: string, deps?: GitHubDeps): Promise<void> {
  try {
    await gh(token, "DELETE", `/repos/${checkRepo(repo)}/git/refs/heads/${encodeBranch(checkBranch(branch))}`, undefined, deps);
  } catch (error) {
    if (!(error instanceof SiteError && (error.status === 404 || error.status === 422))) throw error;
  }
}

export type FileChange = { path: string; content: string } | { path: string; delete: true };

/**
 * One commit with every change on `branch` (which must exist): base tree + changed entries -> new tree -> commit ->
 * fast-forward the ref (never forced: a concurrent push makes this fail instead of being overwritten).
 */
export async function commitFiles(token: string, repo: string, branch: string, message: string, changes: FileChange[], deps?: GitHubDeps): Promise<{ sha: string; htmlUrl: string }> {
  const r = checkRepo(repo);
  const head = await branchSha(token, r, branch, deps);
  if (!head) throw new SiteError(`branch ${branch} does not exist`, 404);
  const commit = await gh<Json>(token, "GET", `/repos/${r}/git/commits/${head}`, undefined, deps);
  const baseTree = String(((commit.tree ?? {}) as Json).sha ?? "");
  const tree = changes.map((change) =>
    "delete" in change
      ? { path: checkPath(change.path, true), mode: "100644", type: "blob", sha: null }
      : { path: checkPath(change.path, true), mode: "100644", type: "blob", content: change.content },
  );
  const newTree = await gh<Json>(token, "POST", `/repos/${r}/git/trees`, { base_tree: baseTree, tree }, deps);
  const created = await gh<Json>(token, "POST", `/repos/${r}/git/commits`, { message, tree: String(newTree.sha), parents: [head] }, deps);
  const sha = String(created.sha);
  await gh(token, "PATCH", `/repos/${r}/git/refs/heads/${encodeBranch(checkBranch(branch))}`, { sha, force: false }, deps);
  return { sha, htmlUrl: String(created.html_url ?? `https://github.com/${r}/commit/${sha}`) };
}

export interface CompareResult {
  aheadBy: number;
  behindBy: number;
  commits: { sha: string; message: string; date: string; url: string }[];
  files: { path: string; status: string; additions: number; deletions: number; patch: string }[];
  htmlUrl: string;
}

export const PATCH_CHARS = 20_000;

export async function compare(token: string, repo: string, base: string, head: string, deps?: GitHubDeps): Promise<CompareResult> {
  const r = checkRepo(repo);
  const c = await gh<Json>(token, "GET", `/repos/${r}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, undefined, deps);
  return {
    aheadBy: Number(c.ahead_by ?? 0),
    behindBy: Number(c.behind_by ?? 0),
    commits: ((c.commits ?? []) as Json[]).map((k) => {
      const inner = (k.commit ?? {}) as Json;
      return { sha: String(k.sha), message: String(inner.message ?? "").slice(0, 500), date: String(((inner.committer ?? {}) as Json).date ?? ""), url: String(k.html_url ?? "") };
    }),
    files: ((c.files ?? []) as Json[]).map((f) => ({
      path: String(f.filename),
      status: String(f.status),
      additions: Number(f.additions ?? 0),
      deletions: Number(f.deletions ?? 0),
      patch: String(f.patch ?? "").slice(0, PATCH_CHARS),
    })),
    htmlUrl: String(c.html_url ?? ""),
  };
}

export interface PullRequest {
  number: number;
  url: string;
  title: string;
  state: string;
  merged: boolean;
  draft: boolean;
  headSha: string;
  mergeable: boolean | null;
  mergeableState: string;
}

function toPull(p: Json): PullRequest {
  return {
    number: Number(p.number),
    url: String(p.html_url ?? ""),
    title: String(p.title ?? ""),
    state: String(p.state ?? ""),
    merged: Boolean(p.merged ?? p.merged_at),
    draft: Boolean(p.draft),
    headSha: String(((p.head ?? {}) as Json).sha ?? ""),
    mergeable: p.mergeable === null || p.mergeable === undefined ? null : Boolean(p.mergeable),
    mergeableState: String(p.mergeable_state ?? ""),
  };
}

export async function openPullFor(token: string, repo: string, branch: string, deps?: GitHubDeps): Promise<PullRequest | null> {
  const r = checkRepo(repo);
  const owner = r.split("/")[0];
  const list = await gh<Json[]>(token, "GET", `/repos/${r}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`, undefined, deps);
  if (!list.length) return null;
  return getPull(token, r, Number(list[0].number), deps);
}

export async function getPull(token: string, repo: string, number: number, deps?: GitHubDeps): Promise<PullRequest> {
  return toPull(await gh<Json>(token, "GET", `/repos/${checkRepo(repo)}/pulls/${number}`, undefined, deps));
}

export async function createPull(token: string, repo: string, input: { title: string; body: string; head: string; base: string }, deps?: GitHubDeps): Promise<PullRequest> {
  return toPull(await gh<Json>(token, "POST", `/repos/${checkRepo(repo)}/pulls`, input, deps));
}

export async function updatePull(token: string, repo: string, number: number, input: { title?: string; body?: string; state?: "open" | "closed" }, deps?: GitHubDeps): Promise<PullRequest> {
  return toPull(await gh<Json>(token, "PATCH", `/repos/${checkRepo(repo)}/pulls/${number}`, input, deps));
}

/** Squash-merges the pull request, only if its head is still `sha` (what the user reviewed). */
export async function mergePull(token: string, repo: string, number: number, sha: string, title: string, deps?: GitHubDeps): Promise<{ sha: string }> {
  const res = await gh<Json>(token, "PUT", `/repos/${checkRepo(repo)}/pulls/${number}/merge`, { merge_method: "squash", sha, commit_title: title }, deps);
  return { sha: String(res.sha ?? "") };
}

export interface CommitChecks {
  /** success | failure | pending | none */
  state: string;
  items: { name: string; state: string; url: string; description: string }[];
  /** A deployment preview of this commit (Vercel, Netlify, Pages...): the newest successful environment URL. */
  previewUrl: string;
}

/** Statuses + check runs of a commit and the preview URL its deployments report. */
export async function commitChecks(token: string, repo: string, sha: string, deps?: GitHubDeps): Promise<CommitChecks> {
  const r = checkRepo(repo);
  const combined = await gh<Json>(token, "GET", `/repos/${r}/commits/${sha}/status`, undefined, deps);
  const items: CommitChecks["items"] = ((combined.statuses ?? []) as Json[]).map((s) => ({
    name: String(s.context ?? ""),
    state: String(s.state ?? ""),
    url: String(s.target_url ?? ""),
    description: String(s.description ?? "").slice(0, 200),
  }));
  try {
    const runs = await gh<Json>(token, "GET", `/repos/${r}/commits/${sha}/check-runs?per_page=50`, undefined, deps);
    for (const run of (runs.check_runs ?? []) as Json[]) {
      const conclusion = run.status === "completed" ? String(run.conclusion ?? "") : "pending";
      items.push({ name: String(run.name ?? ""), state: conclusion === "success" || conclusion === "neutral" || conclusion === "skipped" ? "success" : conclusion === "pending" ? "pending" : "failure", url: String(run.html_url ?? ""), description: String(((run.output ?? {}) as Json).title ?? "").slice(0, 200) });
    }
  } catch (error) {
    if (!(error instanceof SiteError && (error.status === 403 || error.status === 404))) throw error; // fine-grained tokens without Checks: read
  }
  let previewUrl = "";
  const deployments = await gh<Json[]>(token, "GET", `/repos/${r}/deployments?sha=${sha}&per_page=10`, undefined, deps);
  for (const deployment of deployments) {
    const statuses = await gh<Json[]>(token, "GET", `/repos/${r}/deployments/${String(deployment.id)}/statuses?per_page=10`, undefined, deps);
    const ok = statuses.find((s) => s.state === "success" && (s.environment_url || s.target_url));
    if (ok) {
      previewUrl = String(ok.environment_url || ok.target_url);
      break;
    }
    if (statuses.some((s) => s.state === "in_progress" || s.state === "queued" || s.state === "pending")) items.push({ name: `deployment ${String(deployment.environment ?? "")}`, state: "pending", url: "", description: "building" });
  }
  const states = items.map((i) => i.state);
  const state = !items.length ? "none" : states.some((s) => s === "failure" || s === "error") ? "failure" : states.some((s) => s === "pending") ? "pending" : "success";
  return { state, items, previewUrl };
}
