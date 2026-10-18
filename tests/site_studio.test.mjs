// Website studio (src/lib/site, docs/WEBSITE-STUDIO.md) against the fake world of tests/mock_site_world.mjs: page,
// copy and CV-alignment analysis, PageSpeed parsing, path rules, the GitHub flow through the service (connect, read,
// write on a work branch, exact replace, pull request, changes with preview URL, publish only at the reviewed head,
// discard), the token never leaving the server or the sealed file, and a full audit run with history.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/site_studio.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGithub, createSite, INITIAL_FILES, psiBody, REPO, serveGithub, servePsi, serveSite, SITE_PAGES, TOKEN } from "./mock_site_world.mjs";

const dataDir = mkdtempSync(join(tmpdir(), "knife-site-"));
process.env.KNIFE_DATA_DIR = dataDir;
const gh = createGithub(INITIAL_FILES);
const ghServer = await serveGithub(gh);
const siteServer = await serveSite(createSite());
const psiServer = await servePsi();
process.env.KNIFE_GITHUB_API_URL = `http://127.0.0.1:${ghServer.port}`;
process.env.KNIFE_PSI_API_URL = `http://127.0.0.1:${psiServer.port}/run`;
const SITE = `http://127.0.0.1:${siteServer.port}`;
test.after(() => {
  ghServer.server.close();
  siteServer.server.close();
  psiServer.server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const { analyzePage } = await import("../src/lib/site/audit/page.ts");
const { analyzeCopy, copyIssues } = await import("../src/lib/site/audit/copy.ts");
const { alignCvWithSite, fold } = await import("../src/lib/site/audit/align.ts");
const { parsePsi } = await import("../src/lib/site/audit/lighthouse.ts");
const github = await import("../src/lib/site/github.ts");
const service = await import("../src/lib/site/service.ts");
const store = await import("../src/lib/site/store.ts");
const { runAudit, normalizePaths, siteTargetProblem } = await import("../src/lib/site/audit/run.ts");
const cvStore = await import("../src/lib/cv/store.ts");
const { emptyCvData } = await import("../src/lib/cv/schema.ts");
const { accountScope } = await import("../src/lib/storage/scope.ts");

const fakePage = (body, url = "https://jan.example.test/") => ({ url, finalUrl: url, hops: [{ url, status: 200 }], status: 200, headers: {}, contentType: "text/html", body, bytes: body.length, ttfbMs: 50, totalMs: 60 });

test("page analysis: title, description, headings, alt, contacts, profiles, JSON-LD, CTAs", () => {
  const { facts, issues } = analyzePage(fakePage(SITE_PAGES["/"]));
  assert.equal(facts.lang, "pl");
  assert.match(facts.title, /Inżynier AI/);
  assert.equal(facts.headings.filter((h) => h.level === 1).length, 1);
  assert.deepEqual(facts.images, { count: 1, missingAlt: 1 });
  assert.deepEqual(facts.links.contacts, ["mailto:jan@example.test"]);
  assert.equal(facts.links.profiles.length, 2);
  assert.deepEqual(facts.jsonLdTypes, ["Person"]);
  assert.ok(facts.ctas.some((c) => /Napisz do mnie/.test(c)), facts.ctas.join("|"));
  assert.match(facts.text, /Projekty/, "nav/header text is kept (CTAs live there)");
  const ids = issues.map((i) => i.id);
  assert.ok(ids.includes("a11y.img-alt") && ids.includes("seo.og"), ids.join(","));
  assert.ok(!ids.includes("seo.title.missing") && !ids.includes("seo.h1.missing"));
  assert.ok(analyzePage(fakePage("<html><body><p>x</p></body></html>")).issues.some((i) => i.id === "seo.title.missing"));
});

test("copy benchmarks in Polish: FOG-PL, CTA, proof, buzzwords, reader focus with ę/ó words, stale year", () => {
  const { facts } = analyzePage(fakePage(SITE_PAGES["/"]));
  const copy = analyzeCopy(facts, new Date("2026-10-17"));
  assert.equal(copy.lang, "pl");
  assert.equal(copy.readability.formula, "fog-pl");
  assert.ok(copy.readability.value > 3 && copy.readability.value < 25, String(copy.readability.value));
  assert.ok(copy.ctaCount >= 1);
  assert.ok(copy.proofSignals >= 2, `proof ${copy.proofSignals}`);
  assert.deepEqual(copy.buzzwords.sort(), ["innowacyjn", "kompleksow"]);
  assert.ok(copy.youShare > 0, "Ciebie/Twoich count as reader words (Unicode word boundaries)");
  assert.equal(copy.copyrightYear, 2023);
  const ids = copyIssues(copy, "/", new Date("2026-10-17")).map((i) => i.id);
  assert.ok(ids.includes("copy.buzzwords") && ids.includes("content.copyright-year"), ids.join(","));
  const en = analyzeCopy({ text: "We build things. ".repeat(3) + "You get a clear plan, a working prototype in two weeks and a fixed price. Our team shipped 30 projects for clients in 2025. Contact us today.", headings: [{ level: 1, text: "We build AI tools for small teams" }], ctas: ["Contact us"], links: { contacts: [], profiles: [] } });
  assert.equal(en.readability.formula, "flesch");
});

test("CV alignment: present and missing projects, skills, role; site-only tech; folding", () => {
  assert.equal(fold("Używam Docker. Next.js, Łódź!"), "uzywam docker next.js lodz");
  const cv = emptyCvData();
  cv.profile.contact.name = "Jan Kowalski";
  cv.profile.contact.headline = { pl: "Inżynier systemów AI", en: "AI systems engineer" };
  cv.profile.experience = [{ id: "e1", org: "Smart Samurai", role: { pl: "Właściciel", en: "Founder" }, start: "2024-01", end: null, location: "", note: { pl: "", en: "" }, bullets: [], pinned: true }];
  cv.profile.projects = [
    { id: "p1", name: "Samurai Knife", url: "", summary: { pl: "", en: "" }, tech: ["TypeScript"], bullets: [], pinned: true, source: "" },
    { id: "p2", name: "Toberenamed RTS", url: "", summary: { pl: "", en: "" }, tech: [], bullets: [], pinned: false, source: "" },
  ];
  cv.profile.skills = [{ id: "s1", name: { pl: "Narzędzia", en: "Tools" }, items: ["Docker", "Kubernetes"], pinned: false }];
  const { facts } = analyzePage(fakePage(SITE_PAGES["/"]));
  const a = alignCvWithSite(cv, facts.text, facts.links.profiles, facts.links.contacts);
  const on = (label) => a.items.find((i) => i.label === label)?.onSite;
  assert.equal(on("Jan Kowalski"), true);
  assert.equal(on("Samurai Knife"), true);
  assert.equal(on("Toberenamed RTS"), false);
  assert.equal(on("Docker"), true);
  assert.equal(on("Kubernetes"), false);
  assert.equal(a.items.find((i) => i.kind === "role").onSite, false, "Smart Samurai is not named on the page");
  assert.ok(a.siteOnly.includes("python") && a.siteOnly.includes("next.js"), a.siteOnly.join(","));
  assert.ok(a.score > 0 && a.score < 100);
});

test("PageSpeed result parsing: categories, metrics, failing audits by weight", () => {
  const r = parsePsi(psiBody(0.72), "mobile");
  assert.deepEqual(r.scores, { performance: 72, accessibility: 91, "best-practices": 100, seo: 85 });
  assert.equal(r.metrics.lcp, "4.1 s");
  assert.equal(r.failing[0].id, "largest-contentful-paint");
  assert.ok(r.failing.some((f) => f.id === "image-alt"));
  assert.ok(!r.failing.some((f) => f.id === "meta-description"), "passing audits are not failing");
  assert.equal(parsePsi({}, "desktop").ok, false);
});

test("path, branch and repo rules", () => {
  for (const bad of ["../x", "/abs", "a//b", ".git/config", "a\\b"]) assert.throws(() => github.checkPath(bad), /not a repository path|\.git/);
  assert.throws(() => github.checkPath(".github/workflows/x.yml", true), /workflow/);
  assert.throws(() => github.checkPath("app/.env.local", true), /secrets/);
  assert.equal(github.checkPath(".env.example", true), ".env.example");
  assert.throws(() => github.checkRepo("nope"), /owner\/name/);
  assert.throws(() => github.checkBranch("a..b"), /branch/);
  assert.deepEqual(normalizePaths(["/classic", "/", " /v2 "]), ["/", "/classic", "/v2"]);
  assert.throws(() => normalizePaths(["classic"]), /start with/);
});

test("connect: a wrong token is refused, the right one stored sealed and never shown", async () => {
  await assert.rejects(service.connect("genor", { repo: REPO, token: "ghp_wrongTokenWrongTokenWrong00000000", productionUrl: SITE }), /refused the token/);
  const { view, warning } = await service.connect("genor", { repo: REPO, token: TOKEN, productionUrl: SITE, pages: ["/projekty"] });
  assert.equal(warning, "");
  assert.equal(view.connection.repo, REPO);
  assert.equal(view.connection.baseBranch, "main");
  assert.deepEqual(view.connection.pages, ["/", "/projekty"]);
  assert.equal(view.connection.token.login, "genor");
  assert.ok(!JSON.stringify(view).includes(TOKEN), "the view never carries the token");
  const raw = readFileSync(accountScope("genor").siteFile);
  assert.ok(!raw.includes(Buffer.from(TOKEN)), "sealed at rest");
  // Settings change without re-entering the token keeps it.
  const again = await service.connect("genor", { repo: REPO, productionUrl: SITE, pages: ["/projekty"] });
  assert.equal(again.view.connection.token.source, "pat");
});

test("status, files, read, search: the repo's AGENTS.md reaches the agent", async () => {
  const s = await service.status("genor");
  assert.equal(s.instructions[0].path, "AGENTS.md");
  assert.match(s.instructions[0].text, /lib\/site-data\.ts/);
  const root = await service.listFiles("genor");
  assert.ok(root.entries.some((e) => e.path === "lib" && e.type === "dir" && e.files === 1));
  const file = await service.readFile("genor", "lib/site-data.ts");
  assert.match(file.text, /Samurai Knife/);
  const found = await service.search("genor", "hero");
  assert.equal(found.hits[0].path, "lib/site-data.ts");
});

test("write + replace go to a work branch; main is untouched; secrets and workflows refused", async () => {
  const w = await service.writeFiles("genor", "Add a projects page", [{ path: "app/projekty/page.tsx", content: "export default function P() { return 'Projekty'; }\n" }]);
  assert.match(w.branch, /^knife\/\d{8}-[0-9a-f]{6}$/);
  assert.equal(gh.fileAt("main", "app/projekty/page.tsx"), undefined, "the base branch is never written");
  assert.match(gh.fileAt(w.branch, "app/projekty/page.tsx"), /Projekty/);
  const r = await service.replaceText("genor", "lib/site-data.ts", '["Samurai Knife"]', '["Samurai Knife", "Finetune Studio"]', "List Finetune Studio");
  assert.equal(r.branch, w.branch, "the same work branch collects every change");
  assert.match(gh.fileAt(w.branch, "lib/site-data.ts"), /Finetune Studio/);
  await assert.rejects(service.replaceText("genor", "lib/site-data.ts", "does-not-exist", "x", "m"), /not found/);
  await assert.rejects(service.replaceText("genor", "lib/site-data.ts", "export const", "x", "m"), /occurs 2 times/);
  await assert.rejects(service.writeFiles("genor", "m", [{ path: ".env", content: "SECRET=1" }]), /secrets/);
  await assert.rejects(service.writeFiles("genor", "m", [{ path: ".github/workflows/ci.yml", content: "x" }]), /workflow/);
  await assert.rejects(service.writeFiles("genor", "", [{ path: "a.txt", content: "x" }]), /commit message/);
});

test("pull request, changes with the preview URL, publish only at the reviewed head", async () => {
  const pr = await service.openPull("genor", "Projects page", "Adds /projekty and Finetune Studio.");
  assert.equal(pr.number, 1);
  const again = await service.openPull("genor", "Projects page v2", "");
  assert.equal(again.number, 1, "a second call updates the same pull request");
  const ch = await service.changes("genor");
  assert.equal(ch.compare.aheadBy, 2);
  assert.deepEqual(ch.compare.files.map((f) => f.path).sort(), ["app/projekty/page.tsx", "lib/site-data.ts"]);
  assert.match(ch.checks.previewUrl, /^https:\/\/preview-[0-9a-f]{7}\.example\.test$/);
  assert.equal(ch.checks.state, "success");
  await assert.rejects(service.publish("genor", "0".repeat(40)), /moved on since you reviewed/);
  const done = await service.publish("genor", ch.work.head);
  assert.equal(done.pull, 1);
  assert.match(gh.fileAt("main", "lib/site-data.ts"), /Finetune Studio/, "merged into main");
  assert.equal(gh.branches.has(ch.work.branch), false, "the work branch is deleted after publishing");
  const view = store.siteView(store.loadSite("genor"));
  assert.equal(view.work, null);
  assert.equal(view.lastAction.kind, "published");
});

test("discard closes the pull request and deletes the branch, main untouched", async () => {
  const w = await service.writeFiles("genor", "Try a new hero", [{ path: "lib/site-data.ts", content: 'export const hero = "Nowy";\n' }]);
  await service.openPull("genor", "New hero", "");
  await service.discard("genor");
  assert.equal(gh.branches.has(w.branch), false);
  assert.equal(gh.pulls.at(-1).state, "closed");
  assert.match(gh.fileAt("main", "lib/site-data.ts"), /Finetune Studio/);
  await assert.rejects(service.openPull("genor", "x", ""), /no changes yet/);
});

test("public non-admin site fetches are restricted to the connected production origin, including preview requests", () => {
  process.env.KNIFE_AUTH_MODE = "public";
  try {
    const user = { role: "user" };
    const connection = { productionUrl: "https://portfolio.example/" };
    assert.equal(siteTargetProblem(user, connection, "https://portfolio.example/about"), null);
    assert.match(siteTargetProblem(user, connection, "https://preview-123.vercel.app/") ?? "", /production site only/);
    assert.match(siteTargetProblem(user, connection, "https://attacker.example/") ?? "", /production site only/);
    assert.equal(siteTargetProblem({ role: "admin" }, connection, "https://attacker.example/"), null);
  } finally {
    delete process.env.KNIFE_AUTH_MODE;
  }
});

test("audit run: pages, site checks, Lighthouse, CV alignment, scores, history; one at a time", async () => {
  const cv = emptyCvData();
  cv.profile.contact.name = "Jan Kowalski";
  cv.profile.projects = [{ id: "p1", name: "Finetune Studio", url: "", summary: { pl: "", en: "" }, tech: [], bullets: [], pinned: true, source: "" }];
  cvStore.saveCv("genor", cv);
  const pending = runAudit("genor", {});
  await assert.rejects(runAudit("genor", {}), /already running/);
  const run = await pending;
  assert.equal(run.pages.length, 2);
  assert.equal(run.site.robots.status, 200);
  assert.equal(run.site.sitemap.urls, 1);
  assert.equal(run.site.notFoundStatus, 404);
  assert.equal(run.lighthouse.length, 2);
  assert.equal(run.scores.performance, 72);
  assert.ok(run.scores.overall > 0 && run.scores.overall <= 100);
  for (const key of ["seo", "copy", "alignment", "security"]) assert.equal(typeof run.scores[key], "number", key);
  const ids = run.issues.map((i) => i.id);
  assert.ok(ids.includes("content.thin"), "the short /projekty page is thin");
  assert.ok(ids.includes("security.headers"));
  assert.ok(run.alignment.items.find((i) => i.label === "Finetune Studio").onSite);
  assert.ok(psiServer.requests.some((u) => u.includes("strategy=mobile")) && psiServer.requests.some((u) => u.includes("strategy=desktop")));
  const view = store.siteView(store.loadSite("genor"));
  assert.equal(view.latest.id, run.id);
  assert.equal(view.history.length, 1);
  const second = await runAudit("genor", { lighthouse: false });
  assert.equal(second.lighthouse.length, 0);
  assert.equal(store.siteView(store.loadSite("genor")).history[0].id, second.id, "newest first");
});

test("disconnect forgets the token and the work branch; accounts are separate", async () => {
  const accounts = await import("../src/lib/accounts/store.ts");
  accounts.mutateStore((s) => {
    s.accounts.push(accounts.newAccountRecord({ id: "other", displayName: "Other" }));
  });
  assert.equal(store.siteView(store.loadSite("other")).connected, false);
  await assert.rejects(service.listFiles("other"), /no repository connected/);
  const view = service.disconnect("genor");
  assert.equal(view.connected, false);
  assert.ok(!readFileSync(accountScope("genor").siteFile).includes(Buffer.from(TOKEN)));
});
