// Website audit false positives (docs/WEBSITE-STUDIO.md "Audit"): non-HTML resources are checked as files, profile and
// project links are matched after normalising (JSON-LD included), a JavaScript-only page is one finding, PageSpeed's
// mobile noise is shown (median of several runs). Real cases from an audited personal site.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/site_audit_quality.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSite, servePsi, serveSite, SITE_PAGES } from "./mock_site_world.mjs";

const dataDir = mkdtempSync(join(tmpdir(), "knife-site-quality-"));
process.env.KNIFE_DATA_DIR = dataDir;
const site = createSite();
const siteServer = await serveSite(site);
const scores = { value: 0.72 };
const psiServer = await servePsi(0, scores);
process.env.KNIFE_PSI_API_URL = `http://127.0.0.1:${psiServer.port}/run`;
const SITE = `http://127.0.0.1:${siteServer.port}`;
test.after(() => {
  siteServer.server.close();
  psiServer.server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const { analyzePage } = await import("../src/lib/site/audit/page.ts");
const { alignCvWithSite, alignmentIssues } = await import("../src/lib/site/audit/align.ts");
const { normalizeUrl, isProfileUrl, linkPresent, jsonLdUrls } = await import("../src/lib/site/audit/links.ts");
const { resourceKind, checkResource, sitemapProblem } = await import("../src/lib/site/audit/resource.ts");
const { medianResult, lighthouseIssues, mobileRuns } = await import("../src/lib/site/audit/lighthouse.ts");
const { runAudit, computeScores } = await import("../src/lib/site/audit/run.ts");
const { siteIssues } = await import("../src/lib/site/audit/site.ts");
const { emptyCvData } = await import("../src/lib/cv/schema.ts");
const cvStore = await import("../src/lib/cv/store.ts");

const fake = (body, { url = "https://jan.example.test/", status = 200, contentType = "text/html" } = {}) => ({ url, finalUrl: url, hops: [{ url, status }], status, headers: {}, contentType, body, bytes: body.length, ttfbMs: 50, totalMs: 60 });

test("resource kind: well-known names win over the Content-Type, then the type, then the extension", () => {
  assert.equal(resourceKind("/robots.txt", "text/plain"), "robots");
  assert.equal(resourceKind("/sitemap.xml", "application/xml"), "sitemap");
  assert.equal(resourceKind("/sitemap-0.xml", ""), "sitemap");
  assert.equal(resourceKind("/llms.txt", "text/html"), "llms", "a host's HTML 404 page for llms.txt is still llms.txt");
  assert.equal(resourceKind("/v2", "text/html"), "html");
  assert.equal(resourceKind("/about", "application/xhtml+xml"), "html");
  assert.equal(resourceKind("/feed.xml", "application/rss+xml"), "file");
  assert.equal(resourceKind("/data.json", ""), "file");
  assert.equal(resourceKind("/about", ""), "html", "no type and no file extension: a page");
});

test("robots.txt, sitemap.xml and llms.txt get their own checks, never page checks", () => {
  const robots = checkResource("/robots.txt", fake("User-agent: *\nAllow: /\n", { contentType: "text/plain" }));
  assert.deepEqual(robots.issues, []);
  assert.equal(checkResource("/robots.txt", fake("<!doctype html><html><body>404</body></html>")).issues[0].id, "resource.robots.html");
  assert.equal(checkResource("/robots.txt", fake("hello", { contentType: "text/plain" })).issues[0].id, "resource.robots.invalid");
  assert.equal(sitemapProblem('<?xml version="1.0"?><urlset xmlns="x"><url><loc>https://a.test/</loc></url></urlset>'), "");
  assert.match(sitemapProblem("<urlset><url><loc>https://a.test/</loc></url>"), /never closed/);
  assert.match(sitemapProblem("<urlset></urlset>"), /<url><loc>/);
  assert.match(sitemapProblem("<html><body/></html>"), /HTML page/);
  assert.equal(checkResource("/sitemap.xml", fake("<urlset><url><loc>/</loc></url></urlset>", { contentType: "application/xml" })).issues[0].id, "resource.sitemap.relative");
  const llms404 = checkResource("/llms.txt", fake("<h1>404</h1>", { status: 404 }));
  assert.equal(llms404.issues.length, 1);
  assert.equal(llms404.issues[0].id, "resource.llms.missing");
  assert.equal(llms404.issues[0].severity, "low", "an optional well-known file missing is never high");
  assert.deepEqual(checkResource("/llms.txt", fake("# Jan Kowalski\n> AI engineer\n", { contentType: "text/markdown" })).issues, []);
  assert.equal(checkResource("/llms.txt", fake("Jan Kowalski", { contentType: "text/plain" })).issues[0].id, "resource.llms.h1");
  // resource.* findings never move the SEO score (the site-wide robots/sitemap checks score those once).
  const s = computeScores([...llms404.issues, { id: "resource.sitemap.invalid", severity: "medium", category: "seo", title: "", detail: "", page: "", fix: "" }], [], null, [], null, null);
  assert.equal(s.seo, 100);
});

test("the sitemap is compared with the audited HTML pages only", () => {
  const facts = { origin: "https://a.test", httpsRedirect: true, robots: { status: 200, sitemaps: [], blocksAll: false }, sitemap: { url: "https://a.test/sitemap.xml", status: 200, urls: 2 }, notFoundStatus: 404, securityHeaders: {} };
  assert.ok(!siteIssues(facts, ["/", "/v2"]).some((i) => i.id === "seo.sitemap.short"));
  assert.ok(siteIssues(facts, ["/", "/v2", "/projekty"]).some((i) => i.id === "seo.sitemap.short"));
});

test("URL normalisation: scheme, www, host case, trailing slash, fragment and tracking parameters", () => {
  assert.equal(normalizeUrl("https://WWW.LinkedIn.com/in/krzysztofkutniowski/?utm_source=site#top"), "linkedin.com/in/krzysztofkutniowski");
  assert.equal(normalizeUrl("http://linkedin.com/in/krzysztofkutniowski"), "linkedin.com/in/krzysztofkutniowski");
  assert.equal(normalizeUrl("genortg.github.io/finetune-studio/"), "genortg.github.io/finetune-studio");
  assert.equal(normalizeUrl("mailto:a@b.c"), "");
  assert.equal(isProfileUrl("https://github.com/GenorTG"), true);
  assert.equal(isProfileUrl("https://www.linkedin.com/in/krzysztofkutniowski/"), true);
  assert.equal(isProfileUrl("https://genortg.github.io/finetune-studio/"), false, "a GitHub Pages site is a project page");
  assert.equal(isProfileUrl("https://github.com/GenorTG/finetune-studio"), false, "a repository is a project");
  assert.ok(linkPresent("https://www.linkedin.com/in/jan/", ["https://linkedin.com/in/jan"]));
  assert.ok(linkPresent("https://github.com/jan", ["https://github.com/jan?tab=repositories"]));
  assert.ok(!linkPresent("https://github.com/jan", ["https://github.com/janusz"]));
  assert.deepEqual([...jsonLdUrls({ "@graph": [{ url: "https://a.test/", sameAs: ["https://github.com/x", "not a url"] }] })], ["https://a.test/", "https://github.com/x"]);
});

test("regression: a github.io project link from the CV that the site carries (JSON-LD sameAs) is found and is not a profile link", () => {
  // The real report: "Profile links from the CV are missing on the site: Finetune Studio (prezentacja, GitHub Pages)"
  // on every audit. Before: the CV filter /linkedin|github/ took the github.io page as a profile, and the site's links
  // were only anchors to profile hosts (github.io is not one), never JSON-LD, so it could never match.
  const cv = emptyCvData();
  cv.profile.contact.name = "Jan Kowalski";
  cv.profile.contact.links = [
    { label: "GitHub", url: "https://github.com/janko" },
    { label: "LinkedIn", url: "https://linkedin.com/in/janko" },
    { label: "Finetune Studio (prezentacja, GitHub Pages)", url: "https://janko.github.io/finetune-studio/" },
    { label: "Portfolio", url: "https://jan.example.test" },
  ];
  const { facts } = analyzePage(fake(SITE_PAGES["/"]));
  assert.ok(facts.links.jsonLd.includes("https://janko.github.io/finetune-studio/"), facts.links.jsonLd.join(","));
  const a = alignCvWithSite(cv, facts.text, [...facts.links.profiles, ...facts.links.all, ...facts.links.jsonLd], facts.links.contacts, "https://jan.example.test");
  const item = (label) => a.items.find((i) => i.label === label);
  assert.equal(item("GitHub").kind, "link");
  assert.equal(item("GitHub").onSite, true);
  assert.equal(item("LinkedIn").onSite, true, "www. and the trailing slash do not matter");
  assert.equal(item("Finetune Studio (prezentacja, GitHub Pages)").kind, "projectLink");
  assert.equal(item("Finetune Studio (prezentacja, GitHub Pages)").onSite, true, "found in JSON-LD sameAs");
  assert.equal(item("Portfolio"), undefined, "a link to the audited site itself is not checked");
  assert.ok(!alignmentIssues(a).some((i) => i.id === "align.links" || i.id === "align.project-links"));
  // Missing ones are named with their URL, in the fix too.
  cv.profile.contact.links.push({ label: "GitLab", url: "https://gitlab.com/janko" }, { label: "Demo", url: "https://demo.example.test/app" });
  const b = alignCvWithSite(cv, facts.text, [...facts.links.all, ...facts.links.jsonLd], [], "https://jan.example.test");
  const issues = alignmentIssues(b);
  const links = issues.find((i) => i.id === "align.links");
  assert.match(links.fix, /GitLab \(https:\/\/gitlab\.com\/janko\)/);
  assert.doesNotMatch(links.fix, /LinkedIn and GitHub/);
  const project = issues.find((i) => i.id === "align.project-links");
  assert.equal(project.severity, "low");
  assert.match(project.detail, /Demo/);
});

test("a JavaScript-only page is one finding, not no-H1 + thin + no-CTA", () => {
  const { facts, issues } = analyzePage(fake(SITE_PAGES["/v2"]));
  assert.equal(facts.wordCount, 0);
  const ids = issues.map((i) => i.id);
  assert.ok(ids.includes("content.js-only"), ids.join(","));
  for (const gone of ["seo.h1.missing", "content.thin"]) assert.ok(!ids.includes(gone), gone);
  const js = issues.find((i) => i.id === "content.js-only");
  assert.match(js.detail, /no H1/);
  assert.match(js.detail, /no call to action/);
  // A short but real page keeps its separate findings.
  assert.ok(analyzePage(fake(SITE_PAGES["/projekty"])).issues.some((i) => i.id === "content.thin"));
});

test("PageSpeed noise: median of several mobile runs with its spread; a single run is never high", () => {
  const r = (perf) => ({ strategy: "mobile", ok: true, error: "", scores: { performance: perf, seo: 92 }, metrics: { lcp: "3 s" }, failing: [] });
  const median = medianResult([r(49), r(87), r(64)]);
  assert.equal(median.scores.performance, 64);
  assert.equal(median.runs, 3);
  assert.deepEqual(median.spread, { min: 49, max: 87 });
  const issue = lighthouseIssues([median], "/")[0];
  assert.match(issue.title, /median of 3 runs/);
  assert.match(issue.detail, /lowest 49, highest 87/);
  const single = lighthouseIssues([r(45)], "/")[0];
  assert.equal(single.severity, "medium", "one noisy run below 50 is not high");
  assert.match(single.detail, /One PageSpeed run/);
  assert.equal(mobileRuns(true), 3);
  assert.equal(mobileRuns(false), 1);
});

test("audit run with robots.txt, sitemap.xml, llms.txt and a client-rendered page: no page checks on files, scores intact", async () => {
  const cv = emptyCvData();
  cv.profile.contact.name = "Jan Kowalski";
  cv.profile.contact.links = [{ label: "Finetune Studio (GitHub Pages)", url: "https://janko.github.io/finetune-studio/" }];
  cvStore.saveCv("genor", cv);
  process.env.KNIFE_PSI_MOBILE_RUNS = "3";
  const seen = psiServer.requests.length;
  const run = await runAudit("genor", { url: SITE, pages: ["/robots.txt", "/sitemap.xml", "/llms.txt", "/v2"] });
  delete process.env.KNIFE_PSI_MOBILE_RUNS;
  assert.deepEqual(run.pages.map((p) => new URL(p.finalUrl).pathname), ["/", "/v2"]);
  assert.deepEqual(run.resources.map((r) => `${r.path}:${r.kind}:${r.status}`), ["/robots.txt:robots:200", "/sitemap.xml:sitemap:200", "/llms.txt:llms:404"]);
  const onFiles = run.issues.filter((i) => /robots\.txt|sitemap\.xml|llms\.txt/.test(i.page));
  assert.ok(onFiles.every((i) => i.id.startsWith("resource.")), onFiles.map((i) => i.id).join(","));
  assert.ok(!run.issues.some((i) => i.severity === "high" && i.id.startsWith("resource.")));
  assert.equal(run.issues.find((i) => i.id === "resource.llms.missing")?.severity, "low");
  assert.ok(!run.issues.some((i) => i.id === "seo.sitemap.short" && /4|5/.test(i.title)), "the sitemap is compared with 2 HTML pages, not 5 paths");
  assert.ok(run.issues.some((i) => i.id === "content.js-only" && i.page.endsWith("/v2")));
  assert.ok(run.notes.some((n) => n.includes("/llms.txt") && n.includes("not as web pages")), run.notes.join(" | "));
  assert.equal(run.alignment.items.find((i) => i.kind === "projectLink").onSite, true);
  assert.equal(psiServer.requests.length - seen, 4, "3 mobile runs + 1 desktop");
  assert.equal(run.lighthouse[0].runs, 3);
  // The same audit without the files scores SEO the same: files never cost page points.
  const plain = await runAudit("genor", { url: SITE, pages: ["/v2"], lighthouse: false });
  assert.equal(run.scores.seo, plain.scores.seo);
});
