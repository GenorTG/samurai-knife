import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { runOk, type Runner } from "./runner";
import { emptyFacts, ShowcaseError, type Manifest, type RepoFacts } from "./types";

/** Facts about local (private) repos (SERVER-ONLY). Reads only inside an allow-listed root and never touches secret-like files. */

export const DEFAULT_ROOTS = ["~/work", "~/projects", "~/godot-projects"];
export const ROOTS_ENV = "KNIFE_CV_REPO_ROOTS";
export const README_CHARS = 6000;
const MAX_LOC_FILES = 4000;
const MAX_FILE_BYTES = 512_000;
const MAX_DEPS = 40;

const LANG_BY_EXT: Record<string, string> = {
  ".py": "Python", ".js": "JavaScript", ".mjs": "JavaScript", ".jsx": "JavaScript", ".ts": "TypeScript", ".tsx": "TypeScript",
  ".gd": "GDScript", ".cs": "C#", ".rs": "Rust", ".go": "Go", ".java": "Java", ".kt": "Kotlin", ".c": "C", ".h": "C",
  ".cpp": "C++", ".cc": "C++", ".hpp": "C++", ".rb": "Ruby", ".php": "PHP", ".swift": "Swift", ".lua": "Lua", ".sh": "Shell",
  ".fish": "Shell", ".html": "HTML", ".css": "CSS", ".scss": "CSS", ".vue": "Vue", ".svelte": "Svelte", ".sql": "SQL",
  ".glsl": "GLSL", ".gdshader": "GDShader", ".cu": "CUDA",
};

/** Basename globs (lowercase, `*` only) that may hold credentials: never opened, never listed. */
const SECRET_NAMES = [
  ".env*", "*.env", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "*.kdbx", "id_rsa*", "id_dsa*", "id_ecdsa*",
  "id_ed25519*", ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".htpasswd", "credentials*", "secret*", "*.secret",
  "*.secrets", "service-account*.json", "token", "token.*", "*.token", "*_token", "auth.json", "*.tfvars", "*.tfstate",
].map((glob) => new RegExp(`^${glob.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`));
const SECRET_DIRS = new Set([".git", ".ssh", ".aws", ".gnupg", ".gcloud", ".kube", "secrets", ".secrets"]);

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs|e2e)\/|(^|\/)test_[^/]*$|_test\.[a-z]+$|\.(test|spec)\.[a-z]+$/i;
const CI_FILE = /^(\.github\/workflows\/.+\.ya?ml|\.gitlab-ci\.yml|\.circleci\/.+|Jenkinsfile|azure-pipelines\.yml)$/;

/** True for paths that may contain credentials (by basename or any directory component). */
export function isSecretLike(relPath: string): boolean {
  const parts = relPath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) return false;
  if (parts.slice(0, -1).some((p) => SECRET_DIRS.has(p.toLowerCase()))) return true;
  const base = parts[parts.length - 1].toLowerCase();
  return SECRET_NAMES.some((re) => re.test(base));
}

export interface LocalDeps {
  /** Override the allow-list (already-resolved or raw paths); defaults to env/`DEFAULT_ROOTS`. */
  roots?: string[];
  /** The single choke point for reading file contents (tests spy on it). */
  readBytes?: (path: string, limit: number) => Promise<Buffer>;
}

function expand(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function configuredRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[ROOTS_ENV];
  return raw ? raw.split(delimiter).filter(Boolean) : DEFAULT_ROOTS;
}

/** Allow-listed roots with symlinks resolved; missing ones are dropped. */
export async function allowedRoots(entries: string[] = configuredRoots()): Promise<string[]> {
  const roots: string[] = [];
  for (const entry of entries) {
    try {
      const real = await realpath(expand(entry));
      if ((await stat(real)).isDirectory()) roots.push(real);
    } catch {
      // root does not exist on this host
    }
  }
  return roots;
}

/** Resolve symlinks, require a git repo strictly inside an allow-listed root (the root itself is refused). */
export async function resolveRepo(path: string, rootsOverride?: string[]): Promise<string> {
  const roots = await allowedRoots(rootsOverride ?? configuredRoots());
  const shown = roots.join(", ") || "(none exist)";
  let resolved: string;
  try {
    resolved = await realpath(expand(path));
  } catch {
    throw new ShowcaseError(`path '${path.slice(0, 200)}' does not exist.`, 404);
  }
  if (!roots.some((r) => resolved !== r && resolved.startsWith(r.endsWith(sep) ? r : r + sep))) {
    throw new ShowcaseError(`path '${path.slice(0, 200)}' resolves outside the allowed repo roots (${shown}). Roots are configurable with ${ROOTS_ENV} (colon-separated).`, 403);
  }
  const isDir = (await stat(resolved)).isDirectory();
  const hasGit = await stat(join(resolved, ".git")).then(() => true, () => false);
  if (!isDir || !hasGit) throw new ShowcaseError(`'${resolved}' is not a git repository root (no .git).`, 422);
  return resolved;
}

async function defaultReadBytes(path: string, limit: number): Promise<Buffer> {
  // O_NOFOLLOW closes the lstat -> open race: a file swapped for a symlink fails instead of leaking its target.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    // Sized from the file, not the limit: a 512 KB buffer per tracked file was ~2 GB of churn for a 4000-file repo.
    const length = Math.min(limit, (await handle.stat()).size);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function git(runner: Runner, repo: string, ...args: string[]): Promise<string> {
  const res = await runner(["git", "-C", repo, "-c", "core.fsmonitor=false", ...args]);
  if (!runOk(res)) throw new ShowcaseError(`git ${args[0]} failed in ${repo}: ${res.stderr.trim().slice(0, 300)}`, 502);
  return res.stdout;
}

const isoOrNull = (raw: string): string | null => {
  const t = Date.parse(raw.trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

async function isRegularFile(full: string): Promise<boolean> {
  try {
    const info = await lstat(full); // lstat: a symlink is never followed
    return info.isFile();
  } catch {
    return false;
  }
}

export async function localRepoFacts(runner: Runner, path: string, deps: LocalDeps = {}): Promise<RepoFacts> {
  const repo = await resolveRepo(path, deps.roots);
  const read = deps.readBytes ?? defaultReadBytes;
  const hasCommits = runOk(await runner(["git", "-C", repo, "rev-parse", "--verify", "HEAD"]));
  const files = (await git(runner, repo, "ls-files", "-z")).split("\0").filter((f) => f && !isSecretLike(f));
  const count = hasCommits ? Number((await git(runner, repo, "rev-list", "--count", "HEAD")).trim()) : 0;
  const license = files.find((f) => !f.includes("/") && /^(license|licence|copying)/i.test(f));
  const tests = files.filter((f) => TEST_FILE.test(f));

  const facts = emptyFacts("local", repo.split(sep).pop() ?? repo);
  facts.readme = await readme(repo, files, read);
  facts.languages = await locByLanguage(repo, files, read);
  facts.license = license ? `see ${license}` : null;
  facts.commitCount = count;
  facts.topLevel = [...new Set(files.map((f) => f.split("/")[0]))].sort();
  facts.hasCi = files.some((f) => CI_FILE.test(f));
  facts.hasTests = tests.length > 0;
  facts.testFiles = tests.length;
  facts.manifests = await manifests(repo, files, read);
  if (hasCommits) {
    const dates = (await git(runner, repo, "log", "--max-parents=0", "--format=%aI")).split("\n").map(isoOrNull).filter((d): d is string => d !== null);
    facts.firstCommit = dates.sort()[0] ?? null;
    facts.lastCommit = isoOrNull(await git(runner, repo, "log", "-1", "--format=%aI"));
    facts.authors = (await git(runner, repo, "shortlog", "-sn", "HEAD")).split("\n").filter((l) => l.includes("\t")).map((l) => l.split("\t")[1].trim()).slice(0, 10);
  }
  return facts;
}

async function readme(repo: string, files: string[], read: NonNullable<LocalDeps["readBytes"]>): Promise<string> {
  for (const f of files) {
    if (f.includes("/") || !f.toLowerCase().startsWith("readme")) continue;
    if (!(await isRegularFile(join(repo, f)))) continue;
    try {
      return (await read(join(repo, f), README_CHARS * 4)).toString("utf8").slice(0, README_CHARS);
    } catch {
      continue; // unreadable (mode 000, swapped for a symlink mid-scan): the facts are built without it instead of failing wholesale
    }
  }
  return "";
}

async function locByLanguage(repo: string, files: string[], read: NonNullable<LocalDeps["readBytes"]>): Promise<Record<string, number>> {
  const loc = new Map<string, number>();
  let scanned = 0;
  for (const f of files) {
    const dot = f.lastIndexOf(".");
    const lang = dot >= 0 ? LANG_BY_EXT[f.slice(dot).toLowerCase()] : undefined;
    if (!lang || !(await isRegularFile(join(repo, f)))) continue;
    if (scanned >= MAX_LOC_FILES) break;
    scanned += 1;
    let data: Buffer;
    try {
      data = await read(join(repo, f), MAX_FILE_BYTES);
    } catch {
      continue; // one unreadable tracked file must not turn the whole showcase into a 500
    }
    if (data.subarray(0, 1024).includes(0)) continue; // binary
    const lines = data.toString("utf8").split(/\r\n|\n|\r/).filter((l) => l.trim()).length;
    loc.set(lang, (loc.get(lang) ?? 0) + lines);
  }
  return Object.fromEntries([...loc].sort((a, b) => b[1] - a[1]));
}

async function manifests(repo: string, files: string[], read: NonNullable<LocalDeps["readBytes"]>): Promise<Manifest[]> {
  const out: Manifest[] = [];
  for (const f of files) {
    if ((f !== "pyproject.toml" && f !== "package.json") || !(await isRegularFile(join(repo, f)))) continue;
    try {
      const text = (await read(join(repo, f), MAX_FILE_BYTES)).toString("utf8");
      out.push(f === "package.json" ? packageJson(text) : pyproject(text));
    } catch {
      out.push({ file: f, name: null, dependencies: [] }); // present but unparsable: say so, no names
    }
  }
  return out;
}

const DEP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*/;

/** Minimal `[project]` reader (name + dependencies); no TOML dependency. Throws when the table is absent. */
export function pyproject(text: string): Manifest {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*\[project\]\s*(#.*)?$/.test(l));
  if (start < 0) return { file: "pyproject.toml", name: null, dependencies: [] };
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join("\n");
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(body)?.[1] ?? null;
  const deps = stringArray(body, /^\s*dependencies\s*=\s*\[/m).map((d) => DEP_NAME.exec(d)?.[0]).filter((d): d is string => Boolean(d));
  return { file: "pyproject.toml", name, dependencies: deps.slice(0, MAX_DEPS) };
}

/** Strings of the TOML array that opens at `opener`; a `]` inside a quoted string (extras like "pkg[x]") does not end it. */
function stringArray(body: string, opener: RegExp): string[] {
  const m = opener.exec(body);
  if (!m) return [];
  const out: string[] = [];
  for (let i = m.index + m[0].length; i < body.length; i++) {
    const ch = body[i];
    if (ch === "]") break;
    if (ch === "#") i = body.indexOf("\n", i) < 0 ? body.length : body.indexOf("\n", i);
    else if (ch === '"') {
      const close = body.indexOf('"', i + 1);
      if (close < 0) break;
      out.push(body.slice(i + 1, close));
      i = close;
    }
  }
  return out;
}

function packageJson(text: string): Manifest {
  const pkg: unknown = JSON.parse(text);
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) throw new Error("not an object");
  const rec = pkg as Record<string, unknown>;
  const keys = (v: unknown): string[] => (typeof v === "object" && v !== null ? Object.keys(v) : []);
  return {
    file: "package.json",
    name: typeof rec.name === "string" ? rec.name : null,
    dependencies: [...keys(rec.dependencies), ...keys(rec.devDependencies)].slice(0, MAX_DEPS),
  };
}
