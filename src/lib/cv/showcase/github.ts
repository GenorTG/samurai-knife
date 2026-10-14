import { NOT_FOUND, result, runOk, type Runner, type RunResult } from "./runner";
import { emptyFacts, ShowcaseError, type Release, type RepoFacts, type RepoSummary } from "./types";

/** GitHub evidence via the already-authenticated `gh` CLI (SERVER-ONLY: argv arrays through the injectable runner). */

export const README_CHARS = 6000;
export const LIST_FIELDS =
  "name,nameWithOwner,description,primaryLanguage,stargazerCount,forkCount,repositoryTopics,pushedAt,isFork,isPrivate,isArchived,diskUsage,url";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const TEST_DIRS = new Set(["test", "tests", "spec", "specs", "__tests__", "e2e"]);
const CI_ENTRIES = new Set([".gitlab-ci.yml", ".circleci", "Jenkinsfile", "azure-pipelines.yml", ".travis.yml"]);
const LAST_PAGE = /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/;

type Json = Record<string, unknown>;

export async function ensureAuth(runner: Runner): Promise<void> {
  const res = await runner(["gh", "auth", "status"]);
  if (res.returncode === NOT_FOUND) throw new ShowcaseError("the `gh` CLI is not installed. Install GitHub CLI (https://cli.github.com), then run `gh auth login`.", 502);
  if (!runOk(res)) throw new ShowcaseError(`gh is not authenticated. Fix: run \`gh auth login\` on the host, then retry. (${res.stderr.trim().slice(0, 200)})`, 502);
}

export function checkOwner(owner: string): string {
  if (!NAME.test(owner)) throw new ShowcaseError(`invalid GitHub owner '${owner}' (letters, digits, '-', '_', '.').`);
  return owner;
}

export function checkFullName(repo: string): string {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts.every((p) => NAME.test(p) && p !== "." && p !== "..")) {
    throw new ShowcaseError(`repo must look like 'owner/name', got '${repo.slice(0, 100)}'.`);
  }
  return repo;
}

/** A bare `name` expands to the authenticated `gh` user's repo. */
export async function qualifyRepo(runner: Runner, repo: string): Promise<string> {
  if (repo.includes("/")) return checkFullName(repo);
  checkOwner(repo);
  const res = await runner(["gh", "api", "user", "--jq", ".login"]);
  const login = res.stdout.trim();
  if (!runOk(res) || !login) throw new ShowcaseError(`cannot resolve the authenticated gh user to expand '${repo}': use 'owner/name'.`, 502);
  return checkFullName(`${login}/${repo}`);
}

function parseJson(res: RunResult, what: string): unknown {
  if (res.truncated) throw new ShowcaseError(`gh output for ${what} was too large to read.`, 502);
  try {
    return JSON.parse(res.stdout);
  } catch (error) {
    throw new ShowcaseError(`gh returned non-JSON for ${what}: ${(error as Error).message}`, 502);
  }
}

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function topics(raw: unknown): string[] {
  const out: string[] = [];
  for (const t of Array.isArray(raw) ? raw : []) {
    const name = isObj(t) ? (str(t.name) ?? (isObj(t.topic) ? str(t.topic.name) : null)) : str(t);
    if (name) out.push(name);
  }
  return out;
}

function summary(r: Json): RepoSummary {
  const name = str(r.name);
  const url = str(r.url);
  if (!name || !url) throw new ShowcaseError("gh repo list returned an entry without name/url.", 502);
  return {
    name,
    fullName: str(r.nameWithOwner) ?? name,
    description: str(r.description),
    language: isObj(r.primaryLanguage) ? str(r.primaryLanguage.name) : null,
    stars: num(r.stargazerCount) ?? 0,
    forks: num(r.forkCount) ?? 0,
    topics: topics(r.repositoryTopics),
    pushedAt: str(r.pushedAt),
    isFork: r.isFork === true,
    isPrivate: r.isPrivate === true,
    isArchived: r.isArchived === true,
    sizeKb: num(r.diskUsage) ?? 0,
    url,
  };
}

export async function listRepos(runner: Runner, owner?: string, limit = 100): Promise<RepoSummary[]> {
  await ensureAuth(runner);
  const argv = ["gh", "repo", "list"];
  if (owner) argv.push(checkOwner(owner));
  argv.push("--limit", String(limit), "--json", LIST_FIELDS);
  const res = await runner(argv);
  if (!runOk(res)) throw new ShowcaseError(`gh repo list failed: ${res.stderr.trim().slice(0, 300)}`, 502);
  const parsed = parseJson(res, "repo list");
  if (!Array.isArray(parsed)) throw new ShowcaseError("gh repo list returned an unexpected shape.", 502);
  return parsed.filter(isObj).map(summary);
}

/** `gh api` wrapper: 404/409 (missing / empty repo) -> null, other failures -> ShowcaseError. */
class Api {
  readonly base: string;
  private readonly runner: Runner;
  constructor(runner: Runner, fullName: string) {
    this.runner = runner;
    this.base = `repos/${fullName}`;
  }

  private async call(path: string, extra: string[]): Promise<RunResult | null> {
    const res = await this.runner(["gh", "api", ...extra, `${this.base}${path}`]);
    if (runOk(res)) return res;
    if (res.stderr.includes("HTTP 404") || res.stderr.includes("HTTP 409")) return null;
    throw new ShowcaseError(`gh api ${this.base}${path} failed: ${res.stderr.trim().slice(0, 300)}`, 502);
  }

  async json(path: string): Promise<unknown> {
    const res = await this.call(path, []);
    return res ? parseJson(res, path) : null;
  }

  async raw(path: string): Promise<string> {
    return (await this.call(path, ["-H", "Accept: application/vnd.github.raw"]))?.stdout ?? "";
  }

  /** Total items of a list endpoint via per_page=1 + Link header; also page 1's item. */
  async pagedCount(path: string): Promise<{ count: number; first: unknown }> {
    const res = await this.call(path, ["-i"]);
    if (!res) return { count: 0, first: null };
    const [head, ...rest] = res.stdout.replace(/\r\n/g, "\n").split("\n\n");
    const body = parseJson(result(0, rest.join("\n\n")), path);
    const items = Array.isArray(body) ? body : [];
    const last = LAST_PAGE.exec(head);
    return { count: last ? Number(last[1]) : items.length, first: items[0] ?? null };
  }
}

function commitDate(commit: unknown): string | null {
  if (!isObj(commit) || !isObj(commit.commit) || !isObj(commit.commit.author)) return null;
  const raw = str(commit.commit.author.date);
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function release(raw: unknown): Release | null {
  if (!isObj(raw) || !str(raw.tag_name)) return null;
  return { tag: String(raw.tag_name), name: str(raw.name), publishedAt: str(raw.published_at) };
}

export async function repoFacts(runner: Runner, fullName: string): Promise<RepoFacts> {
  checkFullName(fullName);
  await ensureAuth(runner);
  const api = new Api(runner, fullName);
  const [meta, readme, langs, commits, contributors, treeRaw, latest] = await Promise.all([
    api.json(""),
    api.raw("/readme"),
    api.json("/languages"),
    api.pagedCount("/commits?per_page=1"),
    api.pagedCount("/contributors?per_page=1&anon=true"),
    api.json("/contents/"),
    api.json("/releases/latest"),
  ]);
  if (!isObj(meta)) throw new ShowcaseError(`repo '${fullName}' not found (or not visible to the gh account).`, 404);
  const tree = (Array.isArray(treeRaw) ? treeRaw : []).filter(isObj).map((e) => str(e.name)).filter((n): n is string => n !== null);
  const [firstList, workflows] = await Promise.all([
    commits.count > 1 ? api.json(`/commits?per_page=1&page=${commits.count}`) : null,
    tree.includes(".github") ? api.json("/contents/.github/workflows") : null,
  ]);
  const lastCommit = commitDate(commits.first);
  const firstCommit = Array.isArray(firstList) && firstList.length ? commitDate(firstList[0]) : lastCommit;
  const lic = isObj(meta.license) ? meta.license : {};
  const spdx = str(lic.spdx_id);

  const languages: Record<string, number> = {};
  if (isObj(langs)) for (const [k, v] of Object.entries(langs)) if (typeof v === "number") languages[k] = v;

  return {
    ...emptyFacts("github", str(meta.full_name) ?? fullName),
    url: str(meta.html_url),
    description: str(meta.description),
    readme: readme.slice(0, README_CHARS),
    languages,
    topics: Array.isArray(meta.topics) ? meta.topics.filter((t): t is string => typeof t === "string") : [],
    license: spdx && spdx !== "NOASSERTION" ? spdx : str(lic.name),
    stars: num(meta.stargazers_count),
    forks: num(meta.forks_count),
    commitCount: commits.count,
    firstCommit,
    lastCommit,
    contributors: contributors.count,
    topLevel: tree,
    latestRelease: release(latest),
    hasCi: (Array.isArray(workflows) && workflows.length > 0) || tree.some((e) => CI_ENTRIES.has(e)),
    hasTests: tree.some((e) => TEST_DIRS.has(e.toLowerCase())),
    openIssuesInclPrs: num(meta.open_issues_count),
    isFork: meta.fork === true,
    isPrivate: meta.private === true,
  };
}
