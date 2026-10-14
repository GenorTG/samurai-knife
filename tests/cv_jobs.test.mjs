// node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/cv_jobs.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

const { profileSchema, emptyCvData, variantSchema } = await import("../src/lib/cv/schema.ts");
const { readPath } = await import("../src/lib/cv/ops.ts");
const { resolveVariant, danglingIds } = await import("../src/lib/cv/variant.ts");
const { detectLang } = await import("../src/lib/cv/langdetect.ts");
const { extractTerms, match } = await import("../src/lib/cv/jobs/match.ts");
const { suggestVariant } = await import("../src/lib/cv/jobs/tailor.ts");
const { boardLinks } = await import("../src/lib/cv/jobs/boards.ts");
const { TECH } = await import("../src/lib/cv/jobs/terms.ts");
const { parsePage, classifyInput, FetchError } = await import("../src/lib/cv/jobs/posting.ts");
const { blockedAddressReason, parseIPv6 } = await import("../src/lib/cv/jobs/ssrf.ts");
const { fetchPosting, MAX_REDIRECTS } = await import("../src/lib/cv/jobs/fetch.ts");
const { applyFetchedJob } = await import("../src/lib/cv/jobs/save.ts");

// ---- synthetic fixtures (never real personal data) -----------------------------------------

const JSONLD_PAGE = `<!doctype html><html lang="en"><head><title>Careers</title>
<script type="application/ld+json">
{"@context": "https://schema.org", "@type": "JobPosting",
 "title": "Senior Python Developer",
 "hiringOrganization": {"@type": "Organization", "name": "Globex Sp. z o.o."},
 "jobLocation": {"@type": "Place", "address": {"@type": "PostalAddress",
    "addressLocality": "Wrocław", "addressCountry": "PL"}},
 "skills": "Python, FastAPI, PostgreSQL",
 "description": "<p>We are looking for an engineer to build and run our backend platform with
 the team.</p><ul><li>You have solid experience with Python and FastAPI</li>
 <li>You know Docker and Kubernetes</li><li>You care about code quality, testing and
 communication inside the team</li></ul><p>We offer a stable contract, flexible hours and a
 friendly atmosphere in the engineering department, plus a yearly training budget for
 conferences and books so you can keep growing.</p>"}
</script></head><body><div id="root"></div></body></html>`;

const LOREM_PL =
  "Szukamy doświadczonego programisty, który dołączy do naszego zespołu i będzie rozwijał usługi backendowe w Pythonie. " +
  "Oferujemy stabilną współpracę, elastyczne godziny pracy oraz budżet szkoleniowy. Wymagamy doświadczenia w Dockerze, " +
  "znajomości SQL oraz umiejętności komunikacji w zespole. Praca odbywa się w modelu hybrydowym, a zespół jest przyjazny. " +
  "Dla nas ważne jest, że kandydat jest samodzielny i potrafi przejąć odpowiedzialność za funkcjonalność od pomysłu po wdrożenie na produkcję.";

const HTML_PAGE_PL = `<html><head><title>Oferta | Portal</title>
<style>.x{color:red}</style><script>var tracking = 1;</script></head><body>
<nav>Strona główna Logowanie Rejestracja</nav>
<header>Portal pracy</header>
<main><h1>Programista Python</h1><p>${LOREM_PL}</p>
<ul><li>Python</li><li>Docker</li></ul></main>
<footer>Regulamin Polityka prywatności</footer></body></html>`;

const JS_SHELL_PAGE = '<html><head><title>Jobs</title><script src="/app.js"></script></head><body><div id="root"></div><noscript>Enable JavaScript</noscript></body></html>';

const LISTING_PAGE = `<html><body><script type="application/ld+json">
[{"@type": "JobPosting", "title": "A", "description": "x"},
 {"@type": "JobPosting", "title": "B", "description": "y"}]</script></body></html>`;

const bi = (pl, en) => ({ pl, en });
const makeProfile = () => profileSchema.parse({
  contact: { name: "Jan Test", headline: bi("Programista backend", "Backend dev") },
  summary: bi("Programista Pythona.", "Python developer."),
  experience: [
    {
      id: "exp-1", org: "Acme", role: bi("Programista backendowy", "Backend Developer"), start: "2020-01",
      bullets: [
        { id: "b1", text: bi("Zbudowałem REST API w Pythonie i FastAPI na PostgreSQL", "Built REST APIs in Python and FastAPI backed by PostgreSQL"), verified: true },
        { id: "b2", text: bi("Skonteneryzowałem usługi w Dockerze i wdrażałem na Kubernetes", "Containerized services with Docker and deployed to Kubernetes") },
        { id: "b3", text: bi("Organizowałem cotygodniowe planowanie sprintów", "Organised the weekly sprint planning") },
        { id: "b4", text: bi("", "Set up CI/CD pipelines in GitHub Actions"), tags: ["automation"] },
      ],
    },
    {
      id: "exp-2", org: "Beta", role: bi("Analityk", "Analyst"), start: "2017-03", end: "2019-12",
      bullets: [
        { id: "c1", text: bi("Pisałem makra", "Wrote spreadsheet macros") },
        { id: "c2", text: bi("Szkoliłem kolegów", "Trained colleagues") },
        { id: "c3", text: bi("Raportowałem wyniki", "Reported results") },
      ],
    },
  ],
  projects: [
    { id: "proj-1", name: "Agent toolkit", summary: bi("Zestaw narzędzi dla agentów", "Toolkit for agents"), tech: ["Python", "LLM", "RAG"], bullets: [{ id: "pb1", text: bi("Zaimplementowałem retrieval", "Built retrieval") }] },
    { id: "proj-2", name: "Pixel game", summary: bi("Gra 2D", "A 2D game"), tech: ["Godot"] },
  ],
  skills: [
    { id: "sk-1", name: bi("Backend", "Backend"), items: ["Python", "SQL", "FastAPI"] },
    { id: "sk-2", name: bi("Gry", "Games"), items: ["Godot", "GDScript"] },
  ],
});

const makeJob = (overrides = {}) => ({
  id: "globex-python-dev", url: "", title: "Python Developer", company: "Globex", location: "", lang: "en",
  text: "We need a Python developer. You will work with Docker and Kubernetes, write Terraform, and own CI/CD. PostgreSQL knowledge is a plus. Strong communication.",
  requirements: ["3+ years of Python", "Experience with Docker and Kubernetes", "Knowledge of Terraform", "Good communication skills"],
  niceToHave: ["PostgreSQL"], source: "paste", savedAt: "",
  ...overrides,
});

const labels = (text, lang = "en", options) => new Set(extractTerms(text, lang, options).map((t) => t.label));

// ---- language detection ---------------------------------------------------------------------

test("detectLang: PL, EN, and too-little-signal", () => {
  assert.equal(detectLang("We are looking for a developer to join our team and build things"), "en");
  assert.equal(detectLang("Szukamy programisty, który dołączy do naszego zespołu i będzie pracował"), "pl");
  assert.equal(detectLang("Python Docker"), "unknown");
  assert.equal(detectLang(""), "unknown");
});

// ---- term extraction ------------------------------------------------------------------------

test("dictionary has ~125+ terms", () => {
  assert.ok(Object.keys(TECH).length >= 125, String(Object.keys(TECH).length));
});

test("Polish inflection matches tech terms", () => {
  const got = labels("Wymagamy doświadczenia w Dockerze, Pythonie i Kubernetesie oraz SQLu", "pl");
  for (const t of ["Docker", "Python", "Kubernetes", "SQL"]) assert.ok(got.has(t), t);
  assert.ok(labels("doświadczenie w Dockerze", "pl", { keywords: false }).has("Docker"));
});

test("English mode does not apply Polish endings", () => {
  assert.ok(!labels("we use Dockerze", "en").has("Docker"));
  assert.ok(labels("we use Docker.", "en").has("Docker"));
});

test("aliases map to one canonical term", () => {
  const got = labels("JS, TS, k8s, Postgres, nodejs, CI/CD, LLMs, machine-learning, ML", "unknown", { keywords: false });
  assert.deepEqual([...got].sort(), ["CI/CD", "JavaScript", "Kubernetes", "LLM", "Machine Learning", "Node.js", "PostgreSQL", "TypeScript"]);
  const counts = Object.fromEntries(extractTerms("k8s and Kubernetes", "en").map((t) => [t.label, t.count]));
  assert.equal(counts.Kubernetes, 2);
});

test("symbol terms and word boundaries", () => {
  assert.deepEqual([...labels("C++, C# and .NET", "unknown", { keywords: false })].sort(), [".NET", "C#", "C++"]);
  assert.ok(!labels("JavaScript only", "unknown", { keywords: false }).has("Java"));
  assert.ok(!labels("GitHub only", "unknown", { keywords: false }).has("Git"));
  assert.ok(labels("GitHub only", "unknown", { keywords: false }).has("GitHub"));
});

test("ambiguous aliases are case-sensitive", () => {
  const kw = { keywords: false };
  assert.ok(!labels("we go to market and rest", "en", kw).has("Go"));
  assert.ok(labels("Backend in Go", "en", kw).has("Go"));
  assert.ok(!labels("the rest of the team", "en", kw).has("REST"));
  assert.ok(labels("REST and a RESTful API", "en", kw).has("REST"));
});

test("Polish multi-word wildcards", () => {
  assert.deepEqual([...labels("Znajomość uczenia maszynowego oraz sztucznej inteligencji", "pl", { keywords: false })].sort(), ["AI", "Machine Learning"]);
});

test("keywords use Polish stems and skip filler", () => {
  const terms = extractTerms("Cenimy komunikację. Dobra komunikacja i mentoring. Doświadczenie.", "pl");
  const kw = terms.filter((t) => t.kind === "keyword");
  const comm = kw.filter((t) => t.label.startsWith("komunikacj"));
  assert.equal(comm.reduce((n, t) => n + t.count, 0), 2);
  assert.ok(!kw.some((t) => /^doświad|^doswiad/.test(t.label)));
  assert.ok(!extractTerms("mentoring raz", "pl").some((t) => t.label === "mentoring"));
  assert.ok(extractTerms("mentoring raz", "pl", { minKeywordCount: 1 }).some((t) => t.label === "mentoring"));
});

test("a keyword stem matches another inflection in the profile", () => {
  const profile = makeProfile();
  profile.summary.pl = "Cenię komunikację i mentoring w zespole.";
  const job = makeJob({ lang: "pl", requirements: ["Umiejętność komunikacji"], niceToHave: [], text: "x" });
  const hit = match(profile, job, "pl").matched.find((m) => m.term.startsWith("komunikacj"));
  assert.equal(hit.evidence[0].path, "/summary/pl");
});

// ---- match report ---------------------------------------------------------------------------

test("coverage math, missing, sections", () => {
  const report = match(makeProfile(), makeJob(), "en");
  assert.deepEqual(report.matched.map((m) => m.term), ["Python", "Docker", "Kubernetes", "PostgreSQL", "CI/CD"]);
  assert.deepEqual(report.missing, ["Terraform", "communication"]);
  assert.deepEqual(report.missingRequired, ["Terraform", "communication"]);
  assert.equal(report.totalTerms, 7);
  assert.equal(report.coveragePct, 71.4); // 5 / 7
  assert.equal(report.techCoveragePct, 83.3); // 5 / 6
  assert.ok(!report.missingRequired.includes("CI/CD")); // only in the prose
  const sections = Object.fromEntries(report.matched.map((m) => [m.term, m.section]));
  assert.deepEqual([sections.Python, sections.PostgreSQL, sections["CI/CD"]], ["required", "nice", "text"]);
});

test("requirement hits point at the best evidence", () => {
  const hits = Object.fromEntries(match(makeProfile(), makeJob(), "en").requirementHits.map((h) => [h.requirement, h]));
  const docker = hits["Experience with Docker and Kubernetes"];
  assert.deepEqual(docker.matchedTerms, ["Docker", "Kubernetes"]);
  assert.equal(docker.evidence.path, "/experience/id=exp-1/bullets/id=b2/text/en");
  assert.equal(hits["Knowledge of Terraform"].evidence, null);
  assert.deepEqual(hits["Knowledge of Terraform"].matchedTerms, []);
});

test("every evidence path resolves with readPath (both languages)", () => {
  const profile = makeProfile();
  for (const lang of ["en", "pl"]) {
    const report = match(profile, makeJob(), lang);
    const paths = [...report.matched.flatMap((m) => m.evidence.map((e) => e.path)), ...report.requirementHits.flatMap((h) => (h.evidence ? [h.evidence.path] : []))];
    assert.ok(paths.length > 5, lang);
    for (const path of paths) {
      const node = readPath(profile, path);
      assert.ok(node !== undefined && node !== null && node !== "", path);
    }
  }
  // tags / tech / skill-list / headline paths resolve too
  const tagged = match(profile, makeJob({ requirements: ["automation"], niceToHave: [], text: "x" }), "en");
  assert.ok(tagged.matched.length === 0 || tagged.matched.every((m) => m.evidence.every((e) => readPath(profile, e.path) !== undefined)));
  const skill = match(profile, makeJob({ requirements: ["GDScript Godot"], niceToHave: [], text: "x" }), "en");
  const godot = skill.matched.find((m) => m.term === "Godot");
  assert.ok(godot.evidence.some((e) => e.path.startsWith("/projects/id=proj-2/")));
  for (const e of godot.evidence) assert.equal(typeof readPath(profile, e.path), "string");
});

test("matches Polish profile text and falls back to the other language", () => {
  const pl = match(makeProfile(), makeJob(), "pl");
  const docker = pl.matched.find((m) => m.term === "Docker");
  assert.ok(docker.evidence[0].path.endsWith("/bullets/id=b2/text/pl")); // "w Dockerze"
  const ci = pl.matched.find((m) => m.term === "CI/CD");
  assert.ok(ci.evidence[0].path.endsWith("/bullets/id=b4/text/en")); // b4 has no pl text: fallback
});

test("evidence prefers bullets over skill lists", () => {
  const python = match(makeProfile(), makeJob(), "en").matched.find((m) => m.term === "Python");
  assert.ok(python.evidence[0].path.includes("/bullets/"));
  assert.ok(python.evidence.some((e) => e.path.startsWith("/skills/")));
});

test("notes when no requirements are saved, and when nothing matches", () => {
  const raw = match(makeProfile(), makeJob({ requirements: [], niceToHave: [] }), "en");
  assert.ok(raw.notes.some((n) => n.includes("No requirements saved")));
  const empty = match(makeProfile(), makeJob({ requirements: [], niceToHave: [], text: "Hello." }), "en");
  assert.equal(empty.coveragePct, 0);
  assert.equal(empty.techCoveragePct, null);
  assert.ok(empty.notes.some((n) => n.includes("No matchable terms")));
});

test("an empty profile matches nothing", () => {
  const report = match(profileSchema.parse({}), makeJob(), "en");
  assert.deepEqual(report.matched, []);
  assert.equal(report.coveragePct, 0);
});

// ---- variant suggestion ---------------------------------------------------------------------

test("suggest orders bullets by weighted evidence and pads thin roles", () => {
  const s = suggestVariant(makeProfile(), makeJob(), "en");
  const exp = Object.fromEntries((s.variant.experience ?? []).map((e) => [e.id, e.bulletIds]));
  // b2 (Docker+Kubernetes, required) > b1 (Python required + PostgreSQL nice) > b4 (CI/CD, prose)
  assert.deepEqual(exp["exp-1"], ["b2", "b1", "b4"]);
  assert.deepEqual(exp["exp-2"], ["c1", "c2"]); // nothing matches: padded to 2 in master order
  const scores = Object.fromEntries(s.bulletScores.map((b) => [b.path.split("=").pop(), b.score]));
  assert.ok(scores.b2 > scores.b1 && scores.b1 > scores.b4 && scores.b4 > 0);
  assert.equal(scores.b2, 6); // Docker 3 + Kubernetes 3
  assert.equal(scores.b1, 5); // Python 3 + PostgreSQL 2
  assert.equal(scores.b4, 1); // CI/CD prose 1
  assert.deepEqual(Object.keys(s.projectScores), ["proj-1"]);
  assert.deepEqual(s.variant.projectIds, ["proj-1"]);
  assert.deepEqual(s.variant.skillGroupIds, ["sk-1"]);
  assert.deepEqual(s.droppedSkillGroups, ["sk-2"]);
  assert.deepEqual(s.matchedRequired, ["Python", "Docker", "Kubernetes"]);
  assert.deepEqual(s.missingRequired, ["Terraform", "communication"]);
  assert.equal(s.variant.id, "globex-python-dev-en");
  assert.equal(s.variant.target, "Python Developer @ Globex");
  assert.equal(s.variant.jobId, "globex-python-dev");
  assert.deepEqual(s.notes, []);
});

test("the proposal is a valid Variant that resolves against the profile", () => {
  const profile = makeProfile();
  const s = suggestVariant(profile, makeJob(), "en");
  assert.ok(variantSchema.safeParse(s.variant).success);
  assert.deepEqual(danglingIds(profile, s.variant), []);
  const resolved = resolveVariant(profile, s.variant);
  assert.deepEqual(resolved.experience[0].bullets.map((b) => b.id), ["b2", "b1", "b4"]);
  assert.deepEqual(resolved.projects.map((p) => p.id), ["proj-1"]);
});

test("suggest respects the cap and flags translation gaps", () => {
  const one = suggestVariant(makeProfile(), makeJob(), "en", 1);
  assert.deepEqual(one.variant.experience.map((e) => e.bulletIds), [["b2"], ["c1"]]);
  const pl = suggestVariant(makeProfile(), makeJob(), "pl");
  assert.ok(pl.bulletScores.find((b) => b.path.endsWith("b4")).needsTranslation);
  assert.ok(pl.notes.some((n) => n.includes("translate")));
});

test("suggest leaves unmatched sections unset", () => {
  const s = suggestVariant(makeProfile(), makeJob({ requirements: ["Rust"], niceToHave: [], text: "Rust systems role." }), "en");
  assert.equal(s.variant.projectIds, null);
  assert.equal(s.variant.skillGroupIds, null);
  assert.deepEqual(s.droppedSkillGroups, []);
  assert.ok(s.notes.length >= 2);
});

// ---- boards ---------------------------------------------------------------------------------

test("board links are encoded and the remote flag applied; five boards", () => {
  const links = Object.fromEntries(boardLinks("AI engineer", "Katowice", false).map((b) => [b.board, b.url]));
  assert.equal(Object.keys(links).length, 5);
  assert.equal(links["pracuj.pl"], "https://www.pracuj.pl/praca/AI%20engineer;kw/Katowice;wp");
  assert.ok(links["justjoin.it"].includes("keyword=AI+engineer") && links["justjoin.it"].includes("/katowice?"));
  assert.ok(links["nofluffjobs.com"].includes("site%3Anofluffjobs.com") && links["nofluffjobs.com"].includes("AI+engineer+Katowice"));
  assert.ok(links["linkedin.com/jobs"].includes("location=Katowice"));
  assert.ok(links["pl.indeed.com"].includes("l=Katowice"));
  const remote = Object.fromEntries(boardLinks("python", "", true).map((b) => [b.board, b.url]));
  assert.ok(remote["justjoin.it"].includes("/job-offers/remote?") && remote["linkedin.com/jobs"].includes("f_WT=2") && remote["pracuj.pl"].endsWith("?wm=home-office"));
  assert.equal(boardLinks("c++ / c#", "Łódź")[0].url, "https://www.pracuj.pl/praca/c%2B%2B%20%2F%20c%23;kw/%C5%81%C3%B3d%C5%BA;wp");
});

// ---- page parsing ---------------------------------------------------------------------------

test("JSON-LD JobPosting is parsed", () => {
  const got = parsePage(JSONLD_PAGE, "https://jobs.example/p/1");
  assert.equal(got.source, "jsonld");
  assert.equal(got.title, "Senior Python Developer");
  assert.equal(got.company, "Globex Sp. z o.o.");
  assert.equal(got.location, "Wrocław, PL");
  assert.deepEqual(got.requirements, ["Python", "FastAPI", "PostgreSQL"]);
  assert.ok(got.text.includes("- You know Docker and Kubernetes")); // <li> kept as bullets
  assert.equal(got.lang, "en");
});

test("plain-text fallback strips page chrome", () => {
  const got = parsePage(HTML_PAGE_PL, "https://jobs.example/p/2");
  assert.equal(got.source, "html");
  assert.equal(got.title, "Programista Python");
  assert.ok(got.text.includes("Docker") && got.text.includes("- Python"));
  for (const junk of ["Logowanie", "tracking", "Polityka prywatności", "Portal pracy"]) assert.ok(!got.text.includes(junk), junk);
  assert.equal(got.lang, "pl");
});

test("a JS-rendered shell tells the model to ask for a paste", () => {
  assert.throws(() => parsePage(JS_SHELL_PAGE, "https://jobs.example/p/3"), (e) => e instanceof FetchError && /JavaScript[\s\S]*paste/.test(e.message));
});

test("two or more JSON-LD postings are rejected as a listing page", () => {
  assert.throws(() => parsePage(LISTING_PAGE, "https://jobs.example/search"), (e) => e instanceof FetchError && /2 postings/.test(e.message));
});

test("entity-escaped HTML in a JSON-LD description, @graph nesting, raw newlines in strings", () => {
  const long = "Backend platform role with Docker and Python. ".repeat(12);
  const page = `<script type="application/ld+json">{"@graph":[{"@type":["Thing","JobPosting"],"title":"Dev &amp; Ops","description":"&lt;p&gt;${long}&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Go&lt;/li&gt;&lt;/ul&gt;
second line"}]}</script>`;
  const got = parsePage(page, "https://x.example/1");
  assert.equal(got.title, "Dev & Ops");
  assert.ok(got.text.includes("- Go") && !got.text.includes("<p>"));
});

test("windows-1250 style numeric entities and named Polish entities decode", () => {
  const body = `<main><h1>Dev</h1><p>${"Wymagamy znajomo&#347;ci Pythona, &oacute;sm&oacute;wka &amp; spó&#322;ka. ".repeat(10)}</p></main>`;
  const got = parsePage(body, "https://x.example/2");
  assert.ok(got.text.includes("znajomości Pythona, ósmówka & spółka"));
});

test("input classification: schemes, bare hosts, empty, pasted text", () => {
  for (const bad of ["ftp://example.com/job", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x"]) {
    assert.throws(() => classifyInput(bad), (e) => e instanceof FetchError && /only http/.test(e.message), bad);
  }
  assert.throws(() => classifyInput("example.com/job/1"), /no scheme/);
  assert.throws(() => classifyInput("   "), /empty/);
  assert.deepEqual(classifyInput("https://example.com/x"), { kind: "url", url: "https://example.com/x" });
  const text = "Szukamy programisty Pythona. Wymagamy doświadczenia w Dockerze oraz SQL.";
  assert.deepEqual(classifyInput(`  ${text}\n`), { kind: "text", text });
});

// ---- SSRF guard -----------------------------------------------------------------------------

test("address policy: blocked and allowed ranges", () => {
  const blocked = [
    "127.0.0.1", "127.255.255.254", "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1",
    "169.254.169.254", "100.64.0.1", "100.101.102.103", "100.127.255.255", "192.0.0.1", "192.0.2.5", "198.18.0.1", "198.51.100.1", "203.0.113.9",
    "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "::ffff:7f00:1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "ff02::1",
    "64:ff9b::7f00:1", "2001:db8::1", "2002:7f00:1::", "2001::1", "fec0::1", "::2", "not-an-ip", "1.2.3", "256.1.1.1", "01.2.3.4",
  ];
  for (const address of blocked) assert.ok(blockedAddressReason(address), `should block ${address}`);
  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.169.0.1", "198.20.0.1", "223.255.255.255", "2606:4700::1111", "2a00:1450:4001::200e"];
  for (const address of allowed) assert.equal(blockedAddressReason(address), null, `should allow ${address}`);
  assert.deepEqual(parseIPv6("::ffff:1.2.3.4"), [0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
});

const PUBLIC = "93.184.216.34";
const GOOD_PAGE = JSONLD_PAGE;

/** Fake network: `routes` maps URL -> {status, headers, body}; records every transport call. */
function fakeNet(routes, dns = {}) {
  const calls = { resolve: [], transport: [] };
  return {
    calls,
    deps: {
      resolve: async (host) => {
        calls.resolve.push(host);
        const answer = host in dns ? dns[host] : [PUBLIC];
        return answer.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
      },
      transport: async ({ url, ip, signal }) => {
        calls.transport.push({ url: url.href, ip: ip.address });
        const route = routes[url.href] ?? { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: GOOD_PAGE };
        if (route.hang) await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        const chunks = route.chunks ?? [new TextEncoder().encode(route.body ?? "")];
        return { status: route.status ?? 200, headers: route.headers ?? {}, body: (async function* () { yield* chunks; })(), close() {} };
      },
    },
  };
}

test("SSRF matrix: literal and obfuscated addresses are refused before any request", async () => {
  const urls = [
    "http://127.0.0.1/", "http://127.0.0.1:3322/", "http://localhost/", "http://LOCALHOST./", "http://api.localhost/", "http://[::1]/", "http://0.0.0.0/",
    "http://10.0.0.5/", "http://172.16.3.4/", "http://192.168.1.1/", "http://169.254.169.254/", "http://169.254.169.254/latest/meta-data/iam/",
    "http://100.101.102.103:3210/", "http://100.64.0.1/", "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:a00:1]/",
    "http://2130706433/", "http://0x7f.1/", "http://017700000001/", "http://127.1/", "http://0/", "http://printer.local/", "http://db.internal/",
    "http://user:pw@example.com/", "http://example.com:22/", "http://example.com:3210/", "http://[::]/",
  ];
  for (const url of urls) {
    const net = fakeNet({});
    await assert.rejects(fetchPosting(url, net.deps), (e) => e instanceof FetchError, url);
    assert.equal(net.calls.transport.length, 0, `${url} must not reach the transport`);
  }
});

test("SSRF matrix: names resolving to non-public addresses are refused (any bad address in the set)", async () => {
  const cases = {
    "10.0.0.1": ["10.0.0.1"], "loopback v6": ["::1"], "mapped v6": ["::ffff:10.0.0.1"], "ula": ["fd00::5"], "tailscale": ["100.100.100.100"],
    "metadata": ["169.254.169.254"], "mixed public + loopback": [PUBLIC, "127.0.0.1"], "mixed v6 public + ula": ["2606:4700::1111", "fc00::1"], "empty answer": [],
  };
  for (const [name, answer] of Object.entries(cases)) {
    const net = fakeNet({}, { "evil.example": answer });
    await assert.rejects(fetchPosting("https://evil.example/job", net.deps), (e) => e instanceof FetchError && /not a public address|did not resolve/.test(e.message), name);
    assert.equal(net.calls.transport.length, 0, name);
  }
  const net = fakeNet({}, {});
  net.deps.resolve = async () => { throw new Error("ENOTFOUND"); };
  await assert.rejects(fetchPosting("https://nxdomain.example/", net.deps), /could not resolve/);
});

test("the connection is pinned to the validated address (resolver asked once per hop)", async () => {
  let n = 0;
  const net = fakeNet({});
  net.deps.resolve = async () => {
    n += 1;
    return n === 1 ? [{ address: PUBLIC, family: 4 }] : [{ address: "127.0.0.1", family: 4 }]; // a rebinding answer that must never be asked for
  };
  const got = await fetchPosting("https://rebind.example/job", net.deps);
  assert.equal(got.title, "Senior Python Developer");
  assert.equal(n, 1);
  assert.deepEqual(net.calls.transport, [{ url: "https://rebind.example/job", ip: PUBLIC }]);
});

test("the transport gets only validated addresses, IPv4 first, for per-family fallback", async () => {
  const seen = [];
  const net = fakeNet({}, { "dual.example": ["2606:4700::1111", PUBLIC, "2606:4700::1112"] });
  const inner = net.deps.transport;
  net.deps.transport = async (request) => {
    seen.push({ ip: request.ip.address, addresses: request.addresses.map((a) => a.address) });
    return inner(request);
  };
  await fetchPosting("https://dual.example/job", net.deps);
  assert.deepEqual(seen, [{ ip: PUBLIC, addresses: [PUBLIC, "2606:4700::1111", "2606:4700::1112"] }]);
});

test("every redirect hop is re-validated", async () => {
  const redirect = (to) => ({ status: 302, headers: { location: to }, body: "" });
  const targets = ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:3322/api/cv", "http://[::1]/", "http://100.101.102.103:3210/", "http://10.1.2.3/", "http://internal-alias.example/", "//localhost/x", "file:///etc/passwd", "ftp://example.com/x"];
  for (const target of targets) {
    const net = fakeNet({ "https://jobs.example/start": redirect(target) }, { "internal-alias.example": ["192.168.0.9"] });
    await assert.rejects(fetchPosting("https://jobs.example/start", net.deps), (e) => e instanceof FetchError, target);
    assert.deepEqual(net.calls.transport.map((c) => c.url), ["https://jobs.example/start"], `${target}: only the first hop may connect`);
  }
  // public -> public -> private: the second hop is fine, the third is refused
  const net = fakeNet({
    "https://a.example/1": redirect("https://b.example/2"),
    "https://b.example/2": redirect("http://169.254.169.254/"),
  });
  await assert.rejects(fetchPosting("https://a.example/1", net.deps), /not a public address/);
  assert.equal(net.calls.transport.length, 2);
});

test("redirect cap: exactly 5 hops are followed, the 6th is refused; relative Location works", async () => {
  const chain = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`https://r.example/${i}`, { status: 301, headers: { location: `/${i + 1}` }, body: "" }]));
  const ok = fakeNet({ ...chain(MAX_REDIRECTS) });
  assert.equal((await fetchPosting("https://r.example/0", ok.deps)).source, "jsonld");
  assert.equal(ok.calls.transport.length, MAX_REDIRECTS + 1);
  const loop = fakeNet({ ...chain(MAX_REDIRECTS + 1) });
  await assert.rejects(fetchPosting("https://r.example/0", loop.deps), /redirects more than 5 times/);
  const noLocation = fakeNet({ "https://r.example/0": { status: 302, headers: {}, body: "" } });
  await assert.rejects(fetchPosting("https://r.example/0", noLocation.deps), /without a Location/);
});

test("content types, status codes and size cap", async () => {
  const html = { "content-type": "text/html" };
  await assert.rejects(fetchPosting("https://x.example/a", fakeNet({ "https://x.example/a": { status: 403, headers: html, body: "no" } }).deps), /HTTP 403/);
  await assert.rejects(fetchPosting("https://x.example/a", fakeNet({ "https://x.example/a": { headers: { "content-type": "application/pdf" }, body: "%PDF" } }).deps), /not a web page/);
  await assert.rejects(fetchPosting("https://x.example/a", fakeNet({ "https://x.example/a": { headers: { "content-type": "image/png" }, body: "x" } }).deps), /image\/png/);
  // declared length over the cap
  await assert.rejects(fetchPosting("https://x.example/a", fakeNet({ "https://x.example/a": { headers: { ...html, "content-length": "2000001" }, body: "x" } }).deps), /larger than 2 MB/);
  // streamed past the cap without a Content-Length
  const big = new Uint8Array(1_000_000).fill(97);
  const net = fakeNet({ "https://x.example/a": { headers: html, chunks: [big, big, big] } });
  await assert.rejects(fetchPosting("https://x.example/a", net.deps), /larger than 2 MB/);
  // custom cap
  await assert.rejects(fetchPosting("https://x.example/a", { ...fakeNet({ "https://x.example/a": { headers: html, body: "x".repeat(500) } }).deps, maxBytes: 100 }), /larger than/);
});

test("JSON and plain-text documents are understood; other JSON is not", async () => {
  const ld = JSON.stringify({ "@type": "JobPosting", title: "Dev", description: "Python and Docker backend role. ".repeat(20), hiringOrganization: { name: "Initech" } });
  const json = await fetchPosting("https://x.example/p.json", fakeNet({ "https://x.example/p.json": { headers: { "content-type": "application/json" }, body: ld } }).deps);
  assert.deepEqual([json.source, json.company, json.title], ["jsonld", "Initech", "Dev"]);
  await assert.rejects(fetchPosting("https://x.example/p.json", fakeNet({ "https://x.example/p.json": { headers: { "content-type": "application/json" }, body: '{"a":1}' } }).deps), /not a schema\.org JobPosting/);
  const plain = await fetchPosting("https://x.example/p.txt", fakeNet({ "https://x.example/p.txt": { headers: { "content-type": "text/plain" }, body: `${LOREM_PL}\n` } }).deps);
  assert.equal(plain.lang, "pl");
  assert.equal(plain.url, "https://x.example/p.txt");
});

test("timeout covers a hanging server", async () => {
  const net = fakeNet({ "https://slow.example/a": { hang: true } });
  const started = Date.now();
  await assert.rejects(fetchPosting("https://slow.example/a", { ...net.deps, timeoutMs: 80 }), /timed out/);
  assert.ok(Date.now() - started < 2_000);
});

test("a fetched page keeps the URL the user gave, and pasted text needs no network", async () => {
  const net = fakeNet({ "https://jobs.example/p/1": { status: 200, headers: { "content-type": "text/html" }, body: JSONLD_PAGE } });
  assert.equal((await fetchPosting("https://jobs.example/p/1", net.deps)).url, "https://jobs.example/p/1");
  const text = "Szukamy programisty Pythona. Wymagamy doświadczenia w Dockerze oraz SQL.";
  const none = fakeNet({});
  const pasted = await fetchPosting(`  ${text}\n`, none.deps);
  assert.deepEqual([pasted.source, pasted.text, pasted.lang], ["paste", text, "pl"]);
  assert.deepEqual(none.calls, { resolve: [], transport: [] });
  await assert.rejects(fetchPosting("file:///etc/passwd", none.deps), /only http/);
  await assert.rejects(fetchPosting("https://x.example/shell", fakeNet({ "https://x.example/shell": { headers: { "content-type": "text/html" }, body: JS_SHELL_PAGE } }).deps), /JavaScript[\s\S]*paste/);
});

// ---- saving ---------------------------------------------------------------------------------

test("applyFetchedJob: new job, hints win, refresh keeps saved requirement lines", () => {
  const got = parsePage(JSONLD_PAGE, "https://jobs.example/p/1");
  const first = applyFetchedJob(emptyCvData(), { ...got, url: "https://jobs.example/p/1" }, {}, new Date("2026-01-02T03:04:05Z"));
  assert.equal(first.refreshed, false);
  assert.equal(first.job.id, "globex-sp-z-o-o-senior-python-developer");
  assert.deepEqual([first.job.source, first.job.lang, first.job.requirements], ["url", "en", ["Python", "FastAPI", "PostgreSQL"]]);
  assert.equal(first.job.savedAt, "2026-01-02T03:04:05.000Z");
  // the assistant saves sharper requirement lines, then the URL is fetched again
  const edited = { ...first.data, jobs: first.data.jobs.map((j) => ({ ...j, requirements: ["Docker"], niceToHave: ["Go"] })) };
  const again = applyFetchedJob(edited, { ...got, url: "https://jobs.example/p/1", text: `${got.text} updated` }, { company: "Globex Poland" }, new Date("2027-01-01T00:00:00Z"));
  assert.equal(again.refreshed, true);
  assert.equal(again.data.jobs.length, 1);
  assert.deepEqual([again.job.id, again.job.requirements, again.job.niceToHave, again.job.company], [first.job.id, ["Docker"], ["Go"], "Globex Poland"]);
  assert.ok(again.job.text.endsWith("updated"));
  assert.equal(again.job.savedAt, first.job.savedAt);
  // pasted text: hints name the job, no URL to dedupe on
  const pasted = applyFetchedJob(emptyCvData(), { url: "", title: "", company: "", location: "", lang: "en", text: "x".repeat(50), requirements: [], source: "paste" }, { title: "Python Developer", company: "Globex" });
  assert.deepEqual([pasted.job.id, pasted.job.source], ["globex-python-developer", "paste"]);
});

// --- regressions found on a real profile + a realistic Polish posting (2026-10-09) -----------------------------------
const termsMod = await import("../src/lib/cv/jobs/terms.ts");
const matchMod = await import("../src/lib/cv/jobs/match.ts");
const postingMod = await import("../src/lib/cv/jobs/posting.ts");
const schemaMod = await import("../src/lib/cv/schema.ts");

test("llama.cpp is not C++ (cpp is a file extension there)", () => {
  const terms = matchMod.jobTerms({ id: "x", lang: "en", text: "Experience with llama.cpp or Ollama", requirements: ["Experience with llama.cpp or Ollama"], niceToHave: [] });
  assert.ok(!terms.some((t) => t.label === "C++"), terms.map((t) => t.label).join(","));
  const cpp = matchMod.jobTerms({ id: "x", lang: "en", text: "C++ developer", requirements: ["C++ developer"], niceToHave: [] });
  assert.ok(cpp.some((t) => t.label === "C++"));
});

test("stem unifies Polish word families: prowadzeniu / Prowadziłem", () => {
  assert.equal(termsMod.stem("prowadzeniu"), termsMod.stem("prowadzilem"));
  assert.equal(termsMod.stem("mentoringu").length <= 6, true);
});

test("spoken languages are searchable evidence, with a path readPath resolves", () => {
  const profile = schemaMod.profileSchema.parse({
    languages: [{ id: "en", name: { pl: "Angielski", en: "English" }, level: { pl: "biegły (C2)", en: "fluent (C2)" } }],
    summary: { pl: "Programista", en: "Developer" },
  });
  const job = { id: "j", lang: "pl", text: "Angielski min. B2", requirements: ["Angielski min. B2"], niceToHave: [] };
  const report = matchMod.match(profile, job, "pl");
  const hit = report.requirementHits[0];
  assert.ok(hit.evidence, "English requirement must find the languages entry");
  assert.match(hit.evidence.path, /^\/languages\/id=en\//);
  assert.equal(report.requirementCoveragePct, 100);
});

test("education is weaker evidence than experience", () => {
  const profile = schemaMod.profileSchema.parse({
    education: [{ id: "e", institution: "S", detail: { pl: "Kurs Python", en: "Python course" } }],
    experience: [{ id: "x", org: "A", bullets: [{ id: "b", text: { pl: "Pisałem w Pythonie systemy backendowe", en: "Wrote Python backend systems" } }] }],
  });
  const job = { id: "j", lang: "pl", text: "Python", requirements: ["Doświadczenie w Pythonie"], niceToHave: [] };
  assert.match(matchMod.match(profile, job, "pl").requirementHits[0].evidence.path, /^\/experience\//);
});

test("pasted posting: headline becomes title/company/location hints", () => {
  const h = postingMod.guessHeadline("Inżynier AI / Python Developer (LLM, RAG) — Acme Data Sp. z o.o., Katowice (hybrydowo)\n\nSzukamy...");
  assert.deepEqual(h, { title: "Inżynier AI / Python Developer (LLM, RAG)", company: "Acme Data Sp. z o.o.", location: "Katowice (hybrydowo)" });
  assert.deepEqual(postingMod.guessHeadline("Senior Python Developer @ Globex"), { title: "Senior Python Developer", company: "Globex", location: "" });
  assert.deepEqual(postingMod.guessHeadline("x".repeat(200)), { title: "", company: "", location: "" });
  assert.equal(postingMod.guessHeadline("").title, "");
});
