import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

const runnerMod = await import("../src/lib/cv/showcase/runner.ts");
const github = await import("../src/lib/cv/showcase/github.ts");
const local = await import("../src/lib/cv/showcase/local.ts");
const score = await import("../src/lib/cv/showcase/score.ts");
const service = await import("../src/lib/cv/showcase/service.ts");
const { ShowcaseError } = await import("../src/lib/cv/showcase/types.ts");
const { NOT_FOUND, TIMED_OUT, execRunner, getRunner, result, setRunner } = runnerMod;

// Synthetic only: never real personal data.

// ---- fake `gh` runner (canned JSON) ---------------------------------------------------------------------------------

const ok = (body) => result(0, typeof body === "string" ? body : JSON.stringify(body));
const httpError = (code) => result(1, '{"message":"x"}', `gh: error (HTTP ${code})`);

class FakeRunner {
  constructor(routes = {}) {
    this.routes = { "gh auth status": ok("Logged in"), ...routes };
    this.calls = [];
    this.run = this.run.bind(this);
  }
  async run(argv) {
    this.calls.push(argv);
    const key = argv[0] === "gh" && argv[1] === "api" && argv.length > 2 && argv[2] !== "user" ? argv.at(-1) : argv.join(" ");
    return this.routes[key] ?? httpError(404);
  }
}

const withHeaders = (lastPage, body) =>
  ok(
    `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n${
      lastPage ? `Link: <https://api.github.com/r/x?per_page=1&page=2>; rel="next", <https://api.github.com/r/x?per_page=1&page=${lastPage}>; rel="last"\r\n` : ""
    }\r\n${JSON.stringify(body)}`,
  );
const commit = (date) => ({ sha: "abc", commit: { author: { name: "x", date } } });

const GOOD_README = `# Cool Tool

A fast command line tool that turns CSV files into charts for analysts.

![screenshot](docs/screenshot.png)
[![CI](https://img.shields.io/badge/ci-passing-green.svg)](https://x)

## Built with
Python, Typer

## Installation
\`\`\`
pip install cool-tool
\`\`\`

## Usage
\`\`\`
cool-tool data.csv --out chart.png
\`\`\`

## License
MIT
`;

function repoRoutes(full = "me/cool", o = {}) {
  const { stars = 5, commits = 40, last = "2026-10-01T10:00:00Z", first = "2026-01-01T10:00:00Z", readme = GOOD_README, topics = ["cli", "csv", "charts"], workflows = true, release = false, description = "Turns CSVs into charts", fork = false } = o;
  const tree = o.tree ?? [".github", "README.md", "LICENSE", "src", "tests"];
  const base = `repos/${full}`;
  const routes = {
    [base]: ok({ full_name: full, html_url: `https://github.com/${full}`, description, topics, license: { spdx_id: "MIT", name: "MIT License" }, stargazers_count: stars, forks_count: 1, open_issues_count: 2, fork, private: false }),
    [`${base}/readme`]: ok(readme),
    [`${base}/languages`]: ok({ Python: 9000, Shell: 100 }),
    [`${base}/commits?per_page=1`]: withHeaders(commits, [commit(last)]),
    [`${base}/contributors?per_page=1&anon=true`]: withHeaders(3, [{ login: "me" }]),
    [`${base}/contents/`]: ok(tree.map((name) => ({ name }))),
    [`${base}/releases/latest`]: release ? ok({ tag_name: "v1.0", name: "One", published_at: "2026-09-01T00:00:00Z" }) : httpError(404),
  };
  if (commits > 1) routes[`${base}/commits?per_page=1&page=${commits}`] = ok([commit(first)]);
  if (workflows) routes[`${base}/contents/.github/workflows`] = ok([{ name: "ci.yml" }]);
  return routes;
}

function listEntry(name, o = {}) {
  const { stars = 0, pushed = "2026-10-01T00:00:00Z", size = 500, fork = false, priv = false, archived = false, description = "d", owner = "me" } = o;
  return { name, nameWithOwner: `${owner}/${name}`, description, primaryLanguage: { name: "Python" }, stargazerCount: stars, forkCount: 0, repositoryTopics: null, pushedAt: pushed, isFork: fork, isPrivate: priv, isArchived: archived, diskUsage: size, url: `https://github.com/${owner}/${name}` };
}
const listing = (entries) => ({ [`gh repo list me --limit 100 --json ${github.LIST_FIELDS}`]: ok(entries) });
const rejectsShowcase = (promise, re) => assert.rejects(promise, (e) => e instanceof ShowcaseError && re.test(e.message));

// ---- runner (real execFile, argv only) -------------------------------------------------------------------------------

const node = (code) => [process.execPath, "-e", code];

test("runner captures stdout, stderr and exit code", async () => {
  const res = await execRunner()(node("process.stdout.write('hi'); process.stderr.write('bad'); process.exit(3)"));
  assert.deepEqual([res.returncode, res.stdout, res.stderr, res.truncated], [3, "hi", "bad", false]);
});

test("runner never goes through a shell", async () => {
  const res = await execRunner()(["echo", "a; echo injected $(whoami)"]);
  assert.equal(res.stdout.trim(), "a; echo injected $(whoami)");
});

test("runner caps output and kills the child", async () => {
  const res = await execRunner(10_000, 100)(node("process.stdout.write('x'.repeat(100000))"));
  assert.ok(res.truncated);
  assert.equal(res.stdout.length, 100);
});

test("runner times out", async () => {
  const res = await execRunner(300)(node("setTimeout(() => {}, 30000)"));
  assert.equal(res.returncode, TIMED_OUT);
  assert.match(res.stderr, /timed out/);
});

test("runner reports a missing binary", async () => {
  const res = await execRunner()(["definitely-not-a-real-binary-xyz"]);
  assert.equal(res.returncode, NOT_FOUND);
  assert.match(res.stderr, /not found/);
});

test("setRunner overrides and restores", async () => {
  const dflt = getRunner();
  const fake = async () => result(0, "fake");
  setRunner(fake);
  assert.equal(getRunner(), fake);
  setRunner(null);
  assert.equal(getRunner(), dflt);
});

// ---- github ----------------------------------------------------------------------------------------------------------

test("listRepos parses both topic shapes and null", async () => {
  const entry = { ...listEntry("a", { stars: 3 }), repositoryTopics: [{ name: "cli" }, { topic: { name: "csv" } }] };
  const fake = new FakeRunner(listing([entry, listEntry("b")]));
  const repos = await github.listRepos(fake.run, "me");
  assert.deepEqual(repos.map((r) => r.name), ["a", "b"]);
  assert.deepEqual(repos[0].topics, ["cli", "csv"]);
  assert.equal(repos[0].stars, 3);
  assert.deepEqual(repos[1].topics, []);
  assert.equal(repos[0].fullName, "me/a");
});

test("listRepos rejects bad owners before running anything but auth", async () => {
  for (const owner of ["--help", "a/b", "x y"]) await rejectsShowcase(github.listRepos(new FakeRunner().run, owner), /invalid GitHub owner/);
});

test("logged-out gh gives a fix hint, missing gh says install", async () => {
  await rejectsShowcase(github.listRepos(new FakeRunner({ "gh auth status": result(1, "", "You are not logged in") }).run), /gh auth login/);
  await rejectsShowcase(github.repoFacts(new FakeRunner({ "gh auth status": result(NOT_FOUND, "", "command not found: gh") }).run, "me/cool"), /not installed/);
});

test("repoFacts full picture", async () => {
  const fake = new FakeRunner(repoRoutes("me/cool", { readme: `# T\n\n${"x".repeat(10_000)}`, release: true }));
  const f = await github.repoFacts(fake.run, "me/cool");
  assert.equal(f.readme.length, github.README_CHARS);
  assert.equal(f.commitCount, 40);
  assert.equal(f.contributors, 3);
  assert.ok(f.firstCommit?.startsWith("2026-01-01"));
  assert.ok(f.lastCommit?.startsWith("2026-10-01"));
  assert.deepEqual(f.languages, { Python: 9000, Shell: 100 });
  assert.equal(f.languageUnit, "bytes");
  assert.equal(f.license, "MIT");
  assert.deepEqual(f.topics, ["cli", "csv", "charts"]);
  assert.ok(f.hasCi && f.hasTests);
  assert.equal(f.latestRelease?.tag, "v1.0");
  assert.equal(f.stars, 5);
  assert.equal(f.openIssuesInclPrs, 2);
  assert.ok(f.topLevel.includes("src"));
  // read-only: only `gh auth status` / `gh api <GET>` were run
  assert.ok(fake.calls.every((c) => c[0] === "gh" && (c[1] === "api" || c[1] === "auth")));
  assert.ok(fake.calls.every((c) => !c.includes("-X") && !c.includes("--method")));
});

test("repoFacts without release, CI or tests", async () => {
  const f = await github.repoFacts(new FakeRunner(repoRoutes("me/cool", { tree: ["README.md", "main.py"], workflows: false })).run, "me/cool");
  assert.equal(f.latestRelease, null);
  assert.ok(!f.hasCi && !f.hasTests);
});

test("NOASSERTION license falls back to the license name", async () => {
  const routes = repoRoutes();
  routes["repos/me/cool"] = ok({ ...JSON.parse(routes["repos/me/cool"].stdout), license: { spdx_id: "NOASSERTION", name: "Other" } });
  assert.equal((await github.repoFacts(new FakeRunner(routes).run, "me/cool")).license, "Other");
});

test("empty repo (HTTP 409) has zero commits", async () => {
  const routes = repoRoutes("me/cool", { commits: 0, tree: [] });
  routes["repos/me/cool/commits?per_page=1"] = httpError(409);
  routes["repos/me/cool/contents/"] = httpError(404);
  const f = await github.repoFacts(new FakeRunner(routes).run, "me/cool");
  assert.equal(f.commitCount, 0);
  assert.equal(f.firstCommit, null);
  assert.equal(f.lastCommit, null);
  assert.deepEqual(f.topLevel, []);
});

test("single-commit repo: first equals last", async () => {
  const routes = repoRoutes("me/cool", { commits: 1 });
  routes["repos/me/cool/commits?per_page=1"] = ok(`HTTP/2.0 200 OK\r\n\r\n${JSON.stringify([commit("2026-02-02T00:00:00Z")])}`);
  const f = await github.repoFacts(new FakeRunner(routes).run, "me/cool");
  assert.equal(f.commitCount, 1);
  assert.equal(f.firstCommit, f.lastCommit);
});

test("unknown repo is honest (404), bad names are rejected", async () => {
  await assert.rejects(github.repoFacts(new FakeRunner({ "repos/me/nope": httpError(404) }).run, "me/nope"), (e) => e instanceof ShowcaseError && e.status === 404 && /not found/.test(e.message));
  for (const name of ["a", "a/b/c", "../x/y", "a/..", "-x/y", "a/b c"]) await rejectsShowcase(github.repoFacts(new FakeRunner().run, name), /owner\/name/);
});

test("other API failures are surfaced, not swallowed", async () => {
  const routes = repoRoutes();
  routes["repos/me/cool/languages"] = result(1, "", "gh: Server Error (HTTP 500)");
  await rejectsShowcase(github.repoFacts(new FakeRunner(routes).run, "me/cool"), /HTTP 500/);
});

test("bare repo name expands to the authenticated user", async () => {
  const fake = new FakeRunner({ "gh api user --jq .login": ok("me\n"), ...repoRoutes() });
  assert.equal((await service.githubRepoFacts("cool", fake.run)).name, "me/cool");
  await rejectsShowcase(service.githubRepoFacts("cool", new FakeRunner().run), /cannot resolve the authenticated gh user/);
});

// ---- local (real temp git repos) -------------------------------------------------------------------------------------

const SENTINEL = "TOPSECRET-SENTINEL-123";
const scratch = mkdtempSync(join(tmpdir(), "knife-showcase-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const roots = join(scratch, "work");
mkdirSync(roots);

function git(repo, args, date = "2026-03-01T12:00:00+00:00") {
  execFileSync("git", ["-C", repo, ...args], {
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "Jan Test", GIT_AUTHOR_EMAIL: "jan@example.test", GIT_COMMITTER_NAME: "Jan Test", GIT_COMMITTER_EMAIL: "jan@example.test", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}
function put(repo, rel, text) {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
}
function initRepo(parent, name) {
  const repo = join(parent, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  return repo;
}

const repo = initRepo(roots, "proj");
put(repo, "README.md", "# Proj\n\nA small synthetic project used only by the tests.\n");
put(repo, "src/app.py", "import os\n\n\ndef main():\n    return 1\n");
put(repo, "tests/test_app.py", "def test_x():\n    assert True\n");
put(repo, ".github/workflows/ci.yml", "name: ci\n");
put(repo, "LICENSE", "MIT\n");
put(repo, "pyproject.toml", '[project]\nname = "proj"\nversion = "9.9.9"\ndependencies = [\n  "httpx>=0.27",  # http\n  "pydantic[email]>=2",\n  "rich",\n]\n[project.urls]\nHomepage = "https://example.test/private"\n');
put(repo, "package.json", '{"name": "proj-web", "version": "7.7.7", "dependencies": {"react": "^18"}, "devDependencies": {"vite": "^5"}}');
put(repo, "web/package.json", '{"name": "nested-web"}');
put(repo, ".env", `API_KEY=${SENTINEL}\n`);
put(repo, ".env.local", `API_KEY=${SENTINEL}\n`);
put(repo, "config/secrets.json", `{"k": "${SENTINEL}"}`);
put(repo, "deploy/server.pem", SENTINEL);
put(repo, "id_rsa", SENTINEL);
git(repo, ["add", "-A"]);
git(repo, ["commit", "-q", "-m", "first"], "2026-01-10T09:00:00+00:00");
put(repo, "src/more.py", "x = 1\n");
git(repo, ["add", "-A"]);
git(repo, ["commit", "-q", "-m", "second"], "2026-03-01T12:00:00+00:00");

const realRunner = execRunner();
const deps = (extra = {}) => ({ roots: [roots], ...extra });

test("local facts from real git", async () => {
  const f = await local.localRepoFacts(realRunner, repo, deps());
  assert.deepEqual([f.source, f.name, f.commitCount, f.authors], ["local", "proj", 2, ["Jan Test"]]);
  assert.equal(f.firstCommit?.slice(0, 10), "2026-01-10");
  assert.equal(f.lastCommit?.slice(0, 10), "2026-03-01");
  assert.equal(f.languages.Python, 6);
  assert.equal(f.languageUnit, "loc");
  assert.ok(f.hasTests && f.hasCi);
  assert.equal(f.testFiles, 1);
  assert.ok(f.readme.startsWith("# Proj"));
  assert.equal(f.license, "see LICENSE");
  const byFile = Object.fromEntries(f.manifests.map((m) => [m.file, m]));
  assert.equal(byFile["pyproject.toml"].name, "proj");
  assert.deepEqual(byFile["pyproject.toml"].dependencies, ["httpx", "pydantic", "rich"]);
  assert.deepEqual(byFile["package.json"].dependencies, ["react", "vite"]);
  assert.equal(f.manifests.length, 2); // root manifests only
  const dumped = JSON.stringify(f);
  assert.ok(!dumped.includes("9.9.9") && !dumped.includes("7.7.7") && !dumped.includes("example.test/private")); // names only
});

test("secret-like files are never opened, listed or returned", async () => {
  const opened = [];
  const f = await local.localRepoFacts(realRunner, repo, deps({ readBytes: async (path, limit) => {
    opened.push(path.slice(repo.length + 1));
    const { readFile } = await import("node:fs/promises");
    return (await readFile(path)).subarray(0, limit);
  } }));
  assert.ok(opened.length > 0, "the spy is in the read path");
  assert.deepEqual(opened.filter((p) => local.isSecretLike(p)), []);
  for (const secret of [".env", ".env.local", "config/secrets.json", "deploy/server.pem", "id_rsa"]) assert.ok(!opened.includes(secret), secret);
  assert.ok(!JSON.stringify(f).includes(SENTINEL));
  assert.ok(![".env", ".env.local", "config", "id_rsa", "deploy"].some((n) => f.topLevel.includes(n)), JSON.stringify(f.topLevel));
});

test("one unreadable tracked file does not fail the whole facts (it is skipped)", async () => {
  const r = initRepo(roots, "unreadable");
  put(r, "ok.py", "a = 1\nb = 2\n");
  put(r, "locked.py", "secretless = True\n".repeat(10));
  put(r, "README.md", "# Title\n\nreadable text\n");
  git(r, ["add", "-A"]);
  git(r, ["commit", "-q", "-m", "files"]);
  chmodSync(join(r, "locked.py"), 0o000);
  try {
    const f = await local.localRepoFacts(realRunner, r, deps());
    assert.equal(f.languages.Python, 2, "only the readable file is counted");
    assert.match(f.readme, /readable text/);
  } finally {
    chmodSync(join(r, "locked.py"), 0o644);
  }
});

test("a throwing reader for the README or a source file is skipped, not propagated", async () => {
  const r = initRepo(roots, "throwing");
  put(r, "a.py", "x = 1\n");
  put(r, "README.md", "# T\n");
  git(r, ["add", "-A"]);
  git(r, ["commit", "-q", "-m", "f"]);
  const f = await local.localRepoFacts(realRunner, r, deps({ readBytes: async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } }));
  assert.equal(f.readme, "");
  assert.deepEqual(f.languages, {});
});

test("symlinked files inside the repo are not followed", async () => {
  const r = initRepo(roots, "linky");
  put(r, "main.py", "a = 1\n");
  const outside = join(scratch, "outside.py");
  writeFileSync(outside, `# ${SENTINEL}\n`.repeat(50));
  symlinkSync(outside, join(r, "leak.py"));
  symlinkSync(outside, join(r, "README.rst"));
  git(r, ["add", "-A"]);
  git(r, ["commit", "-q", "-m", "links"]);
  const f = await local.localRepoFacts(realRunner, r, deps());
  assert.equal(f.languages.Python, 1);
  assert.equal(f.readme, "");
  assert.ok(!JSON.stringify(f).includes(SENTINEL));
});

test("paths outside the roots are refused, even via symlink or ..", async () => {
  const elsewhere = initRepo(scratch, "elsewhere");
  await rejectsShowcase(local.localRepoFacts(realRunner, elsewhere, deps()), /outside the allowed repo roots/);
  symlinkSync(elsewhere, join(roots, "innocent"));
  await assert.rejects(local.localRepoFacts(realRunner, join(roots, "innocent"), deps()), (e) => e instanceof ShowcaseError && e.status === 403);
  await rejectsShowcase(local.localRepoFacts(realRunner, join(repo, "..", "..", "elsewhere"), deps()), /outside the allowed repo roots/);
  await rejectsShowcase(local.localRepoFacts(realRunner, "/etc", deps()), /outside the allowed repo roots/);
});

test("root itself, missing path and non-git dir", async () => {
  await rejectsShowcase(local.resolveRepo(roots, [roots]), /outside the allowed repo roots/);
  await assert.rejects(local.resolveRepo(join(roots, "nope"), [roots]), (e) => e instanceof ShowcaseError && e.status === 404);
  mkdirSync(join(roots, "plain"));
  await rejectsShowcase(local.resolveRepo(join(roots, "plain"), [roots]), /not a git repository/);
});

test("roots come from KNIFE_CV_REPO_ROOTS (colon-separated) or the home defaults", async () => {
  const other = join(scratch, "other");
  mkdirSync(other);
  assert.deepEqual(await local.allowedRoots(local.configuredRoots({ KNIFE_CV_REPO_ROOTS: `${roots}:${other}:${join(scratch, "missing")}` })), [roots, other]);
  assert.deepEqual(local.configuredRoots({}), ["~/work", "~/projects", "~/godot-projects"]);
});

test("empty git repo (no commits) works", async () => {
  const r = initRepo(roots, "fresh");
  put(r, "a.py", "x = 1\n");
  git(r, ["add", "-A"]);
  const f = await local.localRepoFacts(realRunner, r, deps());
  assert.equal(f.commitCount, 0);
  assert.equal(f.lastCommit, null);
});

test("isSecretLike", () => {
  for (const p of [".env", ".env.production", "a/.env", "x.pem", "keys/id_ed25519", "a/credentials.json", "secrets.yml", ".ssh/config", "secrets/a.txt", ".git/config", "terraform.tfvars", "token", "a/b/Secret.key"]) assert.ok(local.isSecretLike(p), p);
  for (const p of ["src/app.py", "README.md", "tokenizer.py", "docs/env.md", "a/b.ts"]) assert.ok(!local.isSecretLike(p), p);
});

test("pyproject reader tolerates extras with brackets and a missing table", () => {
  assert.deepEqual(local.pyproject('[project]\nname = "x"\ndependencies = ["a[b]>=1", "c"]\n').dependencies, ["a", "c"]);
  assert.deepEqual(local.pyproject("[tool.x]\na = 1\n"), { file: "pyproject.toml", name: null, dependencies: [] });
});

// ---- score (pure) ----------------------------------------------------------------------------------------------------

const NOW = new Date("2026-10-09T00:00:00Z");
const baseFacts = (o = {}) => ({
  source: "github", name: "me/x", url: null, description: "d", readme: GOOD_README, languages: {}, languageUnit: "bytes", topics: ["a", "b", "c"], license: "MIT",
  stars: 0, forks: 0, commitCount: 10, firstCommit: null, lastCommit: "2026-09-20T00:00:00Z", contributors: 1, authors: [], topLevel: [], latestRelease: null,
  hasCi: true, hasTests: true, testFiles: null, openIssuesInclPrs: 0, manifests: [], isFork: false, isPrivate: false, ...o,
});
const byId = (items) => Object.fromEntries(items.map((i) => [i.id, i]));

test("a well presented repo passes everything", () => {
  const items = score.showcaseChecklist(baseFacts(), NOW);
  assert.deepEqual(items.filter((i) => !i.passed).map((i) => i.id), []);
  assert.equal(score.showcaseScore(items), 100);
});

test("empty README fails README-dependent checks only", () => {
  const got = byId(score.showcaseChecklist(baseFacts({ readme: "" }), NOW));
  for (const k of ["readme", "tagline", "visual", "install_run", "usage_example", "tech_list", "badges"]) assert.ok(!got[k].passed, k);
  assert.ok(got.tests.passed && got.ci.passed);
});

test("tagline cases", () => {
  const cases = [
    ["# T\n\nA fast tool that converts CSV files into charts.\n", true],
    ["# T\n![logo](a.png)\nA fast tool that converts CSV into charts.\n", true],
    ["# T\n\n## Install\n\nrun it\n", false],
    ["# T\n\nToo short\n", false],
    ["# T\n\n[![b](https://shields.io/x.svg)](u)\n\nA tool for turning data into plots.\n", true],
    ["# T\n\n\n\n\n\n\nA very late tagline that comes after many lines.\n", true],
    ["# A\n## B\n## C\n## D\nA tagline that is buried under headings.\n", false],
    ["", false],
  ];
  for (const [readme, expected] of cases) assert.equal(score.hasTagline(readme), expected, readme);
});

test("badge-only images are not a screenshot; visual variants pass", () => {
  const badge = "# T\n\nA tool that does a useful thing well.\n![b](https://img.shields.io/x.svg)\n";
  const got = byId(score.showcaseChecklist(baseFacts({ readme: badge }), NOW));
  assert.ok(!got.visual.passed && got.badges.passed);
  for (const snippet of ["![d](demo.gif)", "<img src='shot.png'>", "[Live demo](x)"]) {
    assert.ok(byId(score.showcaseChecklist(baseFacts({ readme: `# T\n\nA tool that does a useful thing well.\n\n${snippet}\n` }), NOW)).visual.passed, snippet);
  }
});

test("install needs a heading and a code block", () => {
  const noCode = "# T\n\nTagline for the tool goes here now.\n\n## Install\nrun pip\n";
  assert.ok(!byId(score.showcaseChecklist(baseFacts({ readme: noCode }), NOW)).install_run.passed);
});

test("recent activity boundary is 90 days", () => {
  for (const [days, passed] of [[10, true], [89, true], [91, false], [400, false]]) {
    const last = new Date(NOW.getTime() - days * 86_400_000).toISOString();
    assert.equal(byId(score.showcaseChecklist(baseFacts({ lastCommit: last }), NOW)).recent_activity.passed, passed, String(days));
  }
  assert.ok(!byId(score.showcaseChecklist(baseFacts({ lastCommit: null }), NOW)).recent_activity.passed);
});

test("topics, description, license, tests, CI", () => {
  const got = byId(score.showcaseChecklist(baseFacts({ topics: ["a"], description: null, license: null, hasTests: false, hasCi: false, readme: GOOD_README.replace("## License\nMIT\n", "") }), NOW));
  for (const k of ["topics", "description", "license", "tests", "ci"]) assert.ok(!got[k].passed, k);
});

test("local source skips GitHub-only metadata", () => {
  const ids = score.showcaseChecklist(baseFacts({ source: "local", topics: [], description: null }), NOW).map((i) => i.id);
  assert.ok(!ids.includes("topics") && !ids.includes("description") && ids.includes("tests"));
});

test("score is weighted, advice is English, improvements heaviest first", () => {
  const items = score.showcaseChecklist(baseFacts({ readme: "", hasCi: false }), NOW);
  const s = score.showcaseScore(items);
  assert.ok(s > 0 && s < 100);
  assert.ok(items.every((i) => i.advice && /^[\x20-\x7e]+$/.test(i.advice)));
  const worst = score.topImprovements(items, 2);
  assert.equal(worst.length, 2);
  assert.ok(worst[0].weight >= worst[1].weight);
  assert.equal(worst[0].weight, Math.max(...items.filter((i) => !i.passed).map((i) => i.weight)));
});

// ---- ranking (service over the fake runner) --------------------------------------------------------------------------

test("rank orders by value, excludes noise and fetches no facts for it", async () => {
  const entries = [
    listEntry("star", { stars: 40 }),
    listEntry("nodoc", { stars: 1 }),
    listEntry("stale", { stars: 1, pushed: "2024-01-01T00:00:00Z" }),
    listEntry("fork", { stars: 500, fork: true }),
    listEntry("secret", { stars: 50, priv: true }),
    listEntry("old", { stars: 9, archived: true }),
    listEntry("me", { stars: 2 }), // profile README repo
  ];
  const routes = {
    ...listing(entries),
    ...repoRoutes("me/star", { stars: 40, commits: 300 }),
    ...repoRoutes("me/nodoc", { stars: 1, commits: 3, readme: "", topics: [], tree: ["a.py"], workflows: false }),
    ...repoRoutes("me/stale", { stars: 1, commits: 3, last: "2024-01-01T00:00:00Z", readme: "# stale" }),
  };
  const fake = new FakeRunner(routes);
  const out = await service.showcaseRank("me", fake.run, NOW);
  assert.deepEqual(out.ranked.map((e) => e.repo), ["me/star", "me/nodoc", "me/stale"]);
  assert.deepEqual(out.excluded, { forks: 1, private: 1, archived: 1, profileReadmeRepo: 1 });
  assert.equal(out.considered, 3);
  assert.ok(fake.calls.every((c) => !/me\/(fork|secret|old|me)\b/.test(c.join(" ").replace("gh repo list me", ""))));
  const scores = out.ranked.map((e) => e.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.ok(out.ranked[0].reasons.length > 0);
  assert.deepEqual(Object.keys(out.ranked[0].breakdown), ["stars", "recency", "commits", "presentation"]);
  assert.ok(out.ranked.at(-1).improveFirst.length > 0);
});

test("rank caps candidates at 12 and results at 10", async () => {
  const routes = listing(Array.from({ length: 15 }, (_, i) => listEntry(`r${i}`, { stars: i })));
  for (let i = 0; i < 15; i++) Object.assign(routes, repoRoutes(`me/r${i}`, { stars: i, commits: 10 }));
  const fake = new FakeRunner(routes);
  const out = await service.showcaseRank("me", fake.run, NOW);
  assert.equal(out.considered, 12);
  assert.equal(out.ranked.length, 10);
  assert.equal(out.ranked[0].repo, "me/r14");
  assert.ok(!fake.calls.some((c) => c.at(-1) === "repos/me/r0")); // pre-selection spared the weakest
});

test("rank reports a repo whose facts fail instead of failing everything", async () => {
  const routes = { ...listing([listEntry("good", { stars: 2 }), listEntry("bad", { stars: 1 })]), ...repoRoutes("me/good", { stars: 2 }) };
  routes["repos/me/bad"] = httpError(404);
  const out = await service.showcaseRank("me", new FakeRunner(routes).run, NOW);
  assert.deepEqual(out.ranked.map((e) => e.repo), ["me/good"]);
  assert.equal(out.skipped[0].repo, "me/bad");
});

test("rank surfaces gh auth problems", async () => {
  await rejectsShowcase(service.showcaseRank(undefined, new FakeRunner({ "gh auth status": result(1, "", "not logged in") }).run, NOW), /gh auth login/);
});

test("local facts through the service include checklist and score, and refuse /etc", async () => {
  const out = await service.localFacts(repo, realRunner, deps(), NOW);
  assert.ok(Array.isArray(out.checklist) && out.checklist.some((c) => c.id === "ci"));
  assert.equal(typeof out.showcaseScore, "number");
  await rejectsShowcase(service.localFacts("/etc", realRunner, deps(), NOW), /outside the allowed repo roots/);
});
