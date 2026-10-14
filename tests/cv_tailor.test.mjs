// node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/cv_tailor.test.mjs
// Tailoring for an offer: priorities (pinned items, own sections, section order), justjoin.it offers, posting sections,
// per-version rewording with the fact guard, the ATS check and projects from GitHub. Synthetic data only.
import assert from "node:assert/strict";
import { test } from "node:test";

const { profileSchema, variantSchema, jobSchema, cvDataSchema, applicationSchema, emptyCvData } = await import("../src/lib/cv/schema.ts");
const { resolveVariant, danglingIds, effectiveSectionOrder } = await import("../src/lib/cv/variant.ts");
const { buildCvView } = await import("../src/lib/cv/render/view.ts");
const { cvViewToText } = await import("../src/lib/cv/render/text.ts");
const { postingSections, headingKind } = await import("../src/lib/cv/jobs/sections.ts");
const { justjoinSlug, justjoinApiUrl, parseJustjoinOffer, salaryText } = await import("../src/lib/cv/jobs/justjoin.ts");
const { nofluffSlug, nofluffApiUrl, parseNofluffOffer, nofluffSalary, nofluffWorkplace } = await import("../src/lib/cv/jobs/nofluffjobs.ts");
const { readableText, parseHtml } = await import("../src/lib/cv/jobs/html.ts");
const { pastedPosting, FetchError } = await import("../src/lib/cv/jobs/posting.ts");
const { fetchPosting } = await import("../src/lib/cv/jobs/fetch.ts");
const { applyFetchedJob } = await import("../src/lib/cv/jobs/save.ts");
const { jobForMatching, match } = await import("../src/lib/cv/jobs/match.ts");
const { suggestVariant } = await import("../src/lib/cv/jobs/tailor.ts");
const { atsCheck, experienceMonths, yearsAsked } = await import("../src/lib/cv/jobs/ats.ts");
const { rewriteWarnings, profileCorpus } = await import("../src/lib/cv/text/guard.ts");
const { setRewrites } = await import("../src/lib/cv/rewrites.ts");
const { upsertVariant } = await import("../src/lib/cv/collections.ts");
const { parseRepoRef, techFromFacts, projectDraft, mainLanguages } = await import("../src/lib/cv/showcase/draft.ts");
const { emptyFacts } = await import("../src/lib/cv/showcase/types.ts");
const { pruneDangling, selectionOf, applySelection } = await import("../src/tools/cv/variant-edit.ts");
const { priorityWarnings } = await import("../src/lib/cv/priorities.ts");

// ---- fixtures --------------------------------------------------------------------------------

const bi = (pl, en) => ({ pl, en });

function profile(overrides = {}) {
  return profileSchema.parse({
    contact: { name: "Jan Testowy", email: "jan@example.com", phone: "+48 600 000 000", headline: bi("Programista TypeScript", "TypeScript developer"), links: [] },
    summary: bi("Buduję aplikacje webowe w TypeScript i Node.js.", "I build web apps in TypeScript and Node.js."),
    experience: [
      {
        id: "acme", org: "Acme", role: bi("Programista", "Developer"), start: "2023-01", end: null,
        bullets: [
          { id: "b1", text: bi("Utrzymywałem API w Node.js dla 12 klientów.", "Maintained a Node.js API for 12 clients.") },
          { id: "b2", text: bi("Pisałem testy w Jest.", "Wrote tests in Jest.") },
          { id: "b3", text: bi("Organizowałem spotkania zespołu.", "Organised team meetings.") },
        ],
      },
    ],
    projects: [
      { id: "trainer", name: "Model Trainer", url: "https://github.com/jan/trainer", summary: bi("Trenowanie modeli LLM z PyTorch.", "LLM fine-tuning with PyTorch."), tech: ["Python", "PyTorch", "Docker"], bullets: [{ id: "p1", text: bi("Kolejka zadań w Redis.", "Job queue on Redis.") }] },
      { id: "site", name: "Portfolio site", url: "", summary: bi("Strona w Next.js.", "A Next.js site."), tech: ["Next.js"] },
    ],
    skills: [
      { id: "lang", name: bi("Języki", "Languages"), items: ["TypeScript", "Python", "SQL"] },
      { id: "ops", name: bi("DevOps", "DevOps"), items: ["Docker", "Linux"] },
    ],
    languages: [{ id: "en", name: bi("Angielski", "English"), level: bi("C1", "C1") }],
    consent: bi("Wyrażam zgodę na przetwarzanie danych osobowych.", ""),
    ...overrides,
  });
}

const JOB = jobSchema.parse({
  id: "beta-backend",
  title: "Backend Developer",
  company: "Beta",
  lang: "pl",
  text: "Szukamy osoby do zespołu backend. Pracujemy w Node.js i Nest.js.",
  requirements: ["min. 4 lat doświadczenia komercyjnego", "bardzo dobra znajomość TypeScript", "doświadczenie z Nest.js", "Kubernetes"],
  niceToHave: ["Redis"],
  languages: ["en B2"],
});

// ---- schema ----------------------------------------------------------------------------------

test("schema: data from before this change still loads, new fields default, CV versions and applications default to Polish", () => {
  const old = cvDataSchema.parse({ version: 1, profile: { experience: [{ id: "x", org: "X", bullets: [{ id: "b", text: bi("a", "b") }] }] }, variants: [{ id: "v", name: "V" }], jobs: [{ id: "j" }] });
  assert.equal(old.profile.experience[0].pinned, false);
  assert.equal(old.profile.experience[0].bullets[0].pinned, false);
  assert.deepEqual(old.profile.customSections, []);
  assert.equal(old.profile.sectionOrder, null);
  assert.equal(old.profile.guidance, "");
  assert.equal(old.variants[0].lang, "pl");
  assert.deepEqual(old.variants[0].rewrites, []);
  assert.equal(old.jobs[0].notes, "");
  assert.deepEqual(old.jobs[0].skills, []);
  assert.equal(applicationSchema.parse({ id: "a", company: "C", role: "R" }).lang, "pl");
  assert.equal(emptyCvData().profile.sectionOrder, null);
});

test("schema: section order keys are validated", () => {
  assert.ok(profileSchema.safeParse({ sectionOrder: ["projects", "experience", "custom:oss"] }).success);
  assert.ok(!profileSchema.safeParse({ sectionOrder: ["hobbies"] }).success);
});

// ---- variant resolution ----------------------------------------------------------------------

test("resolveVariant: a rewrite replaces the text in this version only; an empty side keeps the master text", () => {
  const master = profile();
  const v = variantSchema.parse({ id: "v", name: "V", rewrites: [{ path: "/experience/id=acme/bullets/id=b1/text", text: bi("Rozwijałem API w Node.js (TypeScript) dla 12 klientów.", "") }] });
  const out = resolveVariant(master, v);
  assert.equal(out.experience[0].bullets[0].text.pl, "Rozwijałem API w Node.js (TypeScript) dla 12 klientów.");
  assert.equal(out.experience[0].bullets[0].text.en, "Maintained a Node.js API for 12 clients.");
  assert.equal(master.experience[0].bullets[0].text.pl, "Utrzymywałem API w Node.js dla 12 klientów.", "master untouched");
});

test("resolveVariant: rewrites apply before bullets are filtered, custom sections and order are honoured", () => {
  const master = profile({ customSections: [{ id: "oss", title: bi("Open source", "Open source"), items: [{ id: "i1", title: bi("PR do X", "PR to X") }] }, { id: "certs", title: bi("Certyfikaty", "Certificates"), items: [] }] });
  const v = variantSchema.parse({
    id: "v", name: "V",
    experience: [{ id: "acme", bulletIds: ["b2"] }],
    rewrites: [{ path: "/experience/id=acme/bullets/id=b2/text", text: bi("Testy jednostkowe w Jest.", "") }],
    customSectionIds: ["oss"],
    sectionOrder: ["projects", "experience"],
  });
  const out = resolveVariant(master, v);
  assert.deepEqual(out.experience[0].bullets.map((b) => b.text.pl), ["Testy jednostkowe w Jest."]);
  assert.deepEqual(out.customSections.map((c) => c.id), ["oss"]);
  assert.deepEqual(effectiveSectionOrder(out).slice(0, 3), ["projects", "experience", "summary"]);
});

test("danglingIds: rewrite paths outside the allowed texts or pointing at missing items are reported", () => {
  const master = profile();
  const v = variantSchema.parse({ id: "v", name: "V", customSectionIds: ["nope"], sectionOrder: ["custom:nope"], rewrites: [{ path: "/contact/name", text: bi("X", "X") }, { path: "/experience/id=acme/bullets/id=zz/text", text: bi("x", "") }] });
  const bad = danglingIds(master, v);
  assert.ok(bad.includes("section:nope"));
  assert.ok(bad.includes("order:custom:nope"));
  assert.ok(bad.some((b) => b.startsWith("rewrite:/contact/name")));
  assert.ok(bad.includes("rewrite:/experience/id=acme/bullets/id=zz/text"));
  // the editor's "Remove broken references" clears all of it
  const pruned = pruneDangling(master, v);
  assert.deepEqual(danglingIds(master, pruned), []);
});

test("variant editor: own sections round-trip through the selection (all = null)", () => {
  const master = profile({ customSections: [{ id: "oss", title: bi("OSS", "OSS") }, { id: "certs", title: bi("C", "C") }] });
  const v = variantSchema.parse({ id: "v", name: "V" });
  const sel = selectionOf(master, v);
  assert.deepEqual(sel.customSectionIds, ["oss", "certs"]);
  assert.equal(applySelection(master, v, sel).customSectionIds, null);
  assert.deepEqual(applySelection(master, v, { ...sel, customSectionIds: ["certs"] }).customSectionIds, ["certs"]);
});

// ---- rendering ---------------------------------------------------------------------------------

test("view: sections print in the chosen order, own sections included, empty ones skipped", () => {
  const p = profile({
    sectionOrder: ["projects", "custom:oss", "experience"],
    customSections: [
      { id: "oss", title: bi("Open source", "Open source"), items: [{ id: "i1", title: bi("Poprawka w bibliotece X", "Fix in library X"), url: "https://github.com/x/x/pull/1", date: "2025", text: bi("Naprawiony wyciek pamięci.", "Fixed a memory leak.") }] },
      { id: "empty", title: bi("Puste", "Empty"), items: [] },
    ],
  });
  const view = buildCvView(p, "en");
  assert.deepEqual(view.order, ["projects", "custom:oss", "experience", "summary", "skills", "languages"]);
  assert.equal(view.custom.length, 1);
  assert.equal(view.custom[0].items[0].urlText, "github.com/x/x/pull/1");
  const text = cvViewToText(view);
  assert.ok(text.indexOf("SELECTED PROJECTS") < text.indexOf("OPEN SOURCE"));
  assert.ok(text.indexOf("OPEN SOURCE") < text.indexOf("EXPERIENCE"));
  assert.match(text, /Fix in library X {2}\(2025\) · github\.com\/x\/x\/pull\/1\nFixed a memory leak\./);
});

test("view: the standard order is unchanged when nothing is chosen", () => {
  const view = buildCvView(profile(), "pl");
  assert.deepEqual(view.order, ["summary", "experience", "projects", "skills", "languages"]);
});

// ---- posting sections + justjoin.it -----------------------------------------------------------

test("headingKind: Polish and English section headings, questions count, sentences do not", () => {
  assert.equal(headingKind("Wymagania:"), "required");
  assert.equal(headingKind("Czego oczekujemy?"), "required");
  assert.equal(headingKind("⭐ Mile widziane"), "nice");
  assert.equal(headingKind("Nice to have"), "nice");
  assert.equal(headingKind("Co oferujemy?"), "other");
  assert.equal(headingKind("What we offer"), "other");
  assert.equal(headingKind("Szukamy osoby, która chce być ważną częścią zespołu."), null);
  assert.equal(headingKind("- Wymagania"), null);
  assert.equal(headingKind("🎯 What you’ll need to succeed in this role:"), "required");
  assert.equal(headingKind("✚ Nice to have skills:"), "nice");
  assert.equal(headingKind("🚀 In this position, you will:"), "other");
  assert.equal(headingKind("🎁 Discover our perks and benefits:"), "other");
  assert.equal(headingKind("🔍 WYMAGANE KOMPETENCJE:"), "required");
  assert.equal(headingKind("You're a perfect match for the role, if:"), "required");
  assert.equal(headingKind("* Strong Python"), null);
  assert.equal(headingKind("Sprawdzisz się w tej roli, jeżeli:"), "required");
  assert.equal(headingKind("Obowiazki na stanowisku"), "other", "typed without Polish letters");
  assert.equal(headingKind("Co przekona kandydata do oferty?"), "other", "an unknown question heading ends the section");
  assert.equal(headingKind("● Upper-intermediate English level;"), null);
});

test("postingSections: lines under Requirements / Nice to have, the rest ignored", () => {
  const text = ["O nas", "- firma produktowa", "Wymagania:", "- min. 3 lata z TypeScript,", "- znajomość SQL", "Mile widziane:", "- Docker", "Oferujemy:", "- prywatna opieka medyczna"].join("\n");
  assert.deepEqual(postingSections(text), { requirements: ["min. 3 lata z TypeScript", "znajomość SQL"], niceToHave: ["Docker"] });
  const en = ["Requirements", "- 3+ years of Python", "Nice to have", "- Kafka", "Benefits", "- gym card"].join("\n");
  assert.deepEqual(postingSections(en), { requirements: ["3+ years of Python"], niceToHave: ["Kafka"] });
  const starred = ["Key Requirements:", "* Strong Python and SQL.", "1. Airflow", "Nice to Have:", "• Terraform", "Other Details:", "* hybrid"].join("\n");
  assert.deepEqual(postingSections(starred), { requirements: ["Strong Python and SQL", "Airflow"], niceToHave: ["Terraform"] });
  const dots = ["Must haves", "● Upper-intermediate English level;", "●3+ years of Python", "NICE-TO-HAVE:", "✔ Kafka", "Co przekona kandydata do oferty?", "- karta sportowa"].join("\n");
  assert.deepEqual(postingSections(dots), { requirements: ["Upper-intermediate English level", "3+ years of Python"], niceToHave: ["Kafka"] });
});

test("readableText: <li><p>text</p></li> stays one bullet line", () => {
  const text = readableText(parseHtml("<ul><li><p>one</p></li><li><p>two</p></li></ul>"));
  assert.deepEqual(text.split("\n").filter(Boolean), ["- one", "- two"]);
});

test("pastedPosting: requirement and nice-to-have lines come from the headings", () => {
  const p = pastedPosting(["Backend Developer — Beta, Kraków", "Wymagania", "- Node.js", "Mile widziane", "- Redis"].join("\n"));
  assert.deepEqual(p.requirements, ["Node.js"]);
  assert.deepEqual(p.extra.niceToHave, ["Redis"]);
});

const JJ_OFFER = {
  slug: "beta-backend-developer-krakow-javascript",
  title: "Backend Developer",
  companyName: "Beta Sp. z o.o.",
  companyUrl: "https://beta.example",
  city: "Kraków",
  locations: [{ city: "Kraków" }, { city: "Warszawa" }],
  workplaceType: "hybrid",
  experienceLevel: "mid",
  languages: [{ code: "en", level: "B2" }],
  applyUrl: "https://ats.example/apply/1",
  employmentTypes: [
    { type: "b2b", label: "b2b", from: 15000, to: 20000, currency: "pln", unit: "month", gross: false, currencySource: "original" },
    { type: "b2b", from: 3500, to: 4600, currency: "eur", unit: "month", gross: false, currencySource: "conversion" },
  ],
  requiredSkills: [{ name: "TypeScript", level: 4 }, { name: "Nest.js", level: 3 }],
  niceToHaveSkills: [{ name: "Redis", level: 1 }],
  body: "<p><strong>O roli</strong></p><p>Rozwijamy platformę płatności dla sklepów internetowych i szukamy osoby do zespołu backendowego, która przejmie odpowiedzialność za kolejne usługi.</p><p><strong>Wymagania</strong></p><ul><li><p>min. 3 lata komercyjnego doświadczenia w TypeScript</p></li><li><p>doświadczenie z Nest.js</p></li></ul><p><strong>Mile widziane</strong></p><ul><li><p>Redis</p></li></ul><p><strong>Oferujemy</strong></p><ul><li><p>budżet szkoleniowy</p></li></ul>",
};

test("justjoin.it: offer links map to the candidate API; other URLs do not", () => {
  assert.equal(justjoinSlug(new URL("https://justjoin.it/job-offer/beta-backend-developer-krakow-javascript")), "beta-backend-developer-krakow-javascript");
  assert.equal(justjoinSlug(new URL("https://justjoin.it/pl/job-offer/beta-backend-developer-krakow-javascript?x=1")), "beta-backend-developer-krakow-javascript");
  assert.equal(justjoinSlug(new URL("https://justjoin.it/job-offers/all-locations?keyword=ts")), null);
  assert.equal(justjoinSlug(new URL("https://example.com/job-offer/abc-def")), null);
  assert.equal(justjoinApiUrl("abc-def").href, "https://justjoin.it/api/candidate-api/offers/abc-def");
});

test("justjoin.it: the offer JSON becomes a posting with skills, levels, salary, languages and links", () => {
  const p = parseJustjoinOffer(JSON.stringify(JJ_OFFER), "https://justjoin.it/job-offer/x");
  assert.equal(p.source, "justjoin");
  assert.equal(p.company, "Beta Sp. z o.o.");
  assert.equal(p.location, "Kraków; Warszawa");
  assert.equal(p.lang, "pl");
  assert.deepEqual(p.requirements, ["min. 3 lata komercyjnego doświadczenia w TypeScript", "doświadczenie z Nest.js"]);
  assert.deepEqual(p.extra.niceToHave, ["Redis"]);
  assert.deepEqual(p.extra.skills, [{ name: "TypeScript", level: 4, required: true }, { name: "Nest.js", level: 3, required: true }, { name: "Redis", level: 1, required: false }]);
  assert.equal(p.extra.salary, "15000-20000 PLN/month b2b (net)");
  assert.deepEqual(p.extra.languages, ["en B2"]);
  assert.equal(p.extra.seniority, "mid");
  assert.equal(p.extra.workplace, "hybrid");
  assert.equal(p.extra.companyUrl, "https://beta.example");
  assert.equal(p.extra.applyUrl, "https://ats.example/apply/1");
  assert.match(p.text, /^- min\. 3 lata/m);
});

test("justjoin.it: salary label falls back to type; an empty / missing offer is a readable error", () => {
  assert.equal(salaryText([{ type: "permanent", currency: "PLN", unit: "month", from: null, to: null }]), "permanent: salary not disclosed");
  assert.equal(salaryText([{ type: "any", currency: "PLN", unit: "Month", from: null, to: null }]), "any contract: salary not disclosed");
  assert.equal(salaryText([{ type: "b2b", currency: "PLN", unit: "Day", from: 900, to: 1000, gross: false }]), "900-1000 PLN/day b2b (net)");
  // justjoin.it: for hour/year offers from/to are monthly equivalents, fromPerUnit/toPerUnit the posted rate
  assert.equal(salaryText([{ type: "b2b", currency: "PLN", unit: "Hour", from: 20160, to: 30240, fromPerUnit: 120, toPerUnit: 180, gross: false, currencySource: "original" }]), "20160-30240 PLN/month (120-180 PLN/hour) b2b (net)");
  assert.equal(salaryText([{ type: "permanent", currency: "PLN", unit: "Year", from: 15667, to: 23500, fromPerUnit: 188000, toPerUnit: 282000, gross: true, currencySource: "original" }]), "15667-23500 PLN/month (188000-282000 PLN/year) permanent (gross)");
  assert.equal(salaryText([{ type: "b2b", currency: "PLN", unit: "Month", from: 20000, to: 30000, fromPerUnit: 20000, toPerUnit: 30000, gross: false }]), "20000-30000 PLN/month b2b (net)");
  assert.throws(() => parseJustjoinOffer("{}", "u"), FetchError);
  assert.throws(() => parseJustjoinOffer("not json", "u"), FetchError);
});

/** A transport that answers by URL (the SSRF guard still runs: the resolver returns a public address). */
function fakeDeps(routes) {
  const seen = [];
  return {
    seen,
    deps: {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async ({ url }) => {
        seen.push(url.href);
        const hit = routes[url.href];
        const body = hit ? hit.body : "nope";
        return {
          status: hit ? 200 : 404,
          headers: { "content-type": hit?.type ?? "text/plain" },
          body: (async function* () { yield new TextEncoder().encode(body); })(),
          close() {},
        };
      },
    },
  };
}

test("fetchPosting: a justjoin.it link is read through the offer API", async () => {
  const { deps, seen } = fakeDeps({ "https://justjoin.it/api/candidate-api/offers/beta-backend-developer-krakow-javascript": { body: JSON.stringify(JJ_OFFER), type: "application/json" } });
  const p = await fetchPosting("https://justjoin.it/job-offer/beta-backend-developer-krakow-javascript", deps);
  assert.equal(p.source, "justjoin");
  assert.equal(p.url, "https://justjoin.it/job-offer/beta-backend-developer-krakow-javascript");
  assert.deepEqual(seen, ["https://justjoin.it/api/candidate-api/offers/beta-backend-developer-krakow-javascript"]);
});

test("fetchPosting: when the justjoin.it API fails the page itself is tried", async () => {
  const page = `<html><body><main><h1>Backend Developer</h1><p>${"Rozwijamy platformę płatności dla sklepów. ".repeat(15)}</p></main></body></html>`;
  const { deps, seen } = fakeDeps({ "https://justjoin.it/job-offer/beta-backend": { body: page, type: "text/html" } });
  const p = await fetchPosting("https://justjoin.it/job-offer/beta-backend", deps);
  assert.equal(p.source, "html");
  assert.equal(seen.length, 2);
});

const NF_OFFER = {
  title: "Python Developer",
  company: { name: "Gamma Labs", url: "https://gamma.example" },
  location: { places: [{ city: "Kraków" }, { city: "Kraków" }], remote: 2, hybridDesc: "" },
  basics: { seniority: ["Mid", "Senior"] },
  essentials: { originalSalary: { currency: "PLN", types: { b2b: { period: "Hour", range: [140, 160] }, permanent: { period: "Month", range: [18000, 22000] } } } },
  details: { description: "<p>Budujemy platformę analityczną dla banków.</p>" },
  specs: { dailyTasks: ["Rozwój API w FastAPI", "Code review"] },
  requirements: {
    musts: [{ value: "Python" }, { value: "FastAPI" }],
    nices: [{ value: "Kafka" }],
    languages: [{ type: "MUST", code: "en", level: "B2" }],
    description: "<ul><li><span>3+ lata z Pythonem.</span></li><li><span>Znajomość SQL.</span></li></ul><p><strong>Mile widziane:</strong></p><ul><li><span>Kafka</span></li></ul>",
  },
};

test("nofluffjobs.com: offer links map to the posting API; the posting JSON becomes a posting with board fields", () => {
  assert.equal(nofluffSlug(new URL("https://nofluffjobs.com/pl/job/python-developer-gamma-labs-krakow")), "python-developer-gamma-labs-krakow");
  assert.equal(nofluffSlug(new URL("https://nofluffjobs.com/job/python-developer-gamma-labs-krakow")), "python-developer-gamma-labs-krakow");
  assert.equal(nofluffSlug(new URL("https://nofluffjobs.com/pl/python")), null);
  assert.equal(nofluffApiUrl("abc-def").href, "https://nofluffjobs.com/api/posting/abc-def");
  const p = parseNofluffOffer(JSON.stringify(NF_OFFER), "https://nofluffjobs.com/pl/job/x");
  assert.equal(p.source, "nofluffjobs");
  assert.equal(p.company, "Gamma Labs");
  assert.equal(p.location, "Kraków");
  assert.deepEqual(p.requirements, ["3+ lata z Pythonem", "Znajomość SQL"]);
  assert.deepEqual(p.extra.niceToHave, ["Kafka"]);
  assert.deepEqual(p.extra.skills.map((s) => [s.name, s.required]), [["Python", true], ["FastAPI", true], ["Kafka", false]]);
  assert.equal(p.extra.salary, "140-160 PLN/hour b2b; 18000-22000 PLN/month permanent");
  assert.equal(p.extra.seniority, "mid/senior");
  assert.equal(p.extra.workplace, "hybrid (2 days remote a week)");
  assert.deepEqual(p.extra.languages, ["en B2"]);
  assert.equal(p.extra.companyUrl, "https://gamma.example");
  assert.match(p.text, /Zakres obowiązków:\n- Rozwój API w FastAPI/);
  assert.equal(p.lang, "pl");
});

test("nofluffjobs.com: plain-paragraph requirements, remote days, salary without a range, missing offer", () => {
  const plain = { ...NF_OFFER, requirements: { ...NF_OFFER.requirements, description: "<p>Python</p><p>Docker</p>" } };
  assert.deepEqual(parseNofluffOffer(JSON.stringify(plain), "u").requirements, ["Python", "Docker"]);
  assert.equal(nofluffWorkplace({ remote: 5 }), "remote");
  assert.equal(nofluffWorkplace({ remote: 0 }), "office");
  assert.equal(nofluffWorkplace({ remote: 4, hybridDesc: "Hybrid 1 day Office / 4 days Remote" }), "Hybrid 1 day Office / 4 days Remote");
  assert.equal(nofluffSalary({ originalSalary: { currency: "PLN", types: { b2b: { period: "Month" } } } }), "");
  assert.throws(() => parseNofluffOffer("{}", "u"), FetchError);
});

test("fetchPosting: a nofluffjobs.com link is read through the posting API", async () => {
  const { deps, seen } = fakeDeps({ "https://nofluffjobs.com/api/posting/python-developer-gamma": { body: JSON.stringify(NF_OFFER), type: "application/json" } });
  const p = await fetchPosting("https://nofluffjobs.com/pl/job/python-developer-gamma", deps);
  assert.equal(p.source, "nofluffjobs");
  assert.deepEqual(seen, ["https://nofluffjobs.com/api/posting/python-developer-gamma"]);
});

test("applyFetchedJob: board fields, company site and notes are stored; a refresh keeps the user's requirement lines", () => {
  const data = emptyCvData();
  const got = parseJustjoinOffer(JSON.stringify(JJ_OFFER), "https://justjoin.it/job-offer/x");
  const first = applyFetchedJob(data, got, { notes: "Rekruterka: liczy się Nest.js", companyText: "Beta robi płatności." });
  const job = first.job;
  assert.equal(job.source, "justjoin");
  assert.equal(job.skills.length, 3);
  assert.equal(job.companyUrl, "https://beta.example");
  assert.equal(job.notes, "Rekruterka: liczy się Nest.js");
  assert.equal(job.companyText, "Beta robi płatności.");
  assert.deepEqual(job.niceToHave, ["Redis"]);
  const edited = { ...first.data, jobs: first.data.jobs.map((j) => ({ ...j, requirements: ["my own line"] })) };
  const again = applyFetchedJob(edited, got, {});
  assert.equal(again.refreshed, true);
  assert.deepEqual(again.job.requirements, ["my own line"]);
  assert.equal(again.job.notes, "Rekruterka: liczy się Nest.js", "notes survive a refresh without new notes");
  const withSite = applyFetchedJob(edited, got, { companyUrl: "https://mine.example" });
  assert.equal(withSite.job.companyUrl, "https://mine.example", "the user's website wins");
});

// ---- matching + tailoring ----------------------------------------------------------------------

test("jobForMatching: board skills join the requirement lines once; the user's notes join the prose", () => {
  const job = jobSchema.parse({ id: "j", requirements: ["TypeScript i Node.js"], skills: [{ name: "TypeScript", level: 4 }, { name: "Redis", level: 1, required: false }, { name: "Kafka" }], notes: "Ważny jest Docker." });
  const m = jobForMatching(job);
  assert.deepEqual(m.requirements, ["TypeScript i Node.js", "Kafka"]);
  assert.deepEqual(m.niceToHave, ["Redis"]);
  assert.match(m.text, /Docker/);
  const report = match(profile(), m, "pl");
  assert.ok(report.matched.some((t) => t.term === "Docker"), "a term only in the notes is matched");
});

test("suggestVariant: pinned items are kept and lead; a pinned project puts projects before experience", () => {
  const p = profile();
  p.projects[1].pinned = true; // the site, which matches nothing
  p.experience[0].bullets[2].pinned = true; // the meetings bullet, which matches nothing
  const s = suggestVariant(p, JOB, "pl");
  assert.equal(s.variant.projectIds[0], "site");
  assert.equal(s.variant.experience[0].bulletIds[0], "b3");
  assert.ok(s.pinned.includes("/projects/id=site"));
  assert.deepEqual(s.variant.sectionOrder.slice(0, 3), ["summary", "projects", "experience"]);
  assert.ok(s.notes.some((n) => n.includes("pinned a project")));
});

test("suggestVariant: an explicit profile order is never overridden; a pinned role keeps every bullet", () => {
  const p = profile({ sectionOrder: ["experience", "projects"] });
  p.projects[0].pinned = true;
  p.experience[0].pinned = true;
  const s = suggestVariant(p, JOB, "pl", 1);
  assert.equal(s.variant.sectionOrder, null);
  assert.deepEqual(s.variant.experience[0].bulletIds, ["b1", "b2", "b3"]);
});

// ---- fact guard for rewrites ---------------------------------------------------------------------

test("rewriteWarnings: dropped facts and invented ones are flagged; facts from elsewhere in the profile are fine", () => {
  const master = profile();
  const corpus = profileCorpus(master);
  const original = master.experience[0].bullets[0].text;
  assert.deepEqual(rewriteWarnings("/x", original, bi("Rozwijałem API w Node.js i TypeScript dla 12 klientów.", ""), corpus), []);
  const lost = rewriteWarnings("/x", original, bi("Rozwijałem API w Node.js.", ""), corpus);
  assert.equal(lost.length, 1);
  assert.match(lost[0], /drops number 12/);
  const invented = rewriteWarnings("/x", original, bi("Rozwijałem API w Node.js dla 12 klientów i 40000 użytkowników w Kubernetes.", ""), corpus);
  assert.ok(invented.some((w) => /adds .*40000/.test(w)), invented.join(" | "));
});

test("rewriteWarnings: a rewrite may not introduce claim-strengthening words the profile text does not make", () => {
  const corpus = profileCorpus(profile());
  const before = bi("Wdrażam pipeline’y AI do automatyzacji pracy.", "I deploy AI pipelines that automate work.");
  const w = rewriteWarnings("/x", before, bi("Wdrażam produkcyjne pipeline’y AI do automatyzacji pracy.", "I lead the team that deploys AI pipelines in production."), corpus);
  assert.ok(w.some((x) => x.includes("/x/pl") && x.includes("production")), w.join(" | "));
  assert.ok(w.some((x) => x.includes("/x/en") && x.includes("leadership") && x.includes("production")), w.join(" | "));
  // dropping a true claim is flagged too
  const promoted = bi("Awansowałem od developera do team leadera.", "");
  const weaker = rewriteWarnings("/x", promoted, bi("Rozwijałem się od developera do team leadera.", ""), corpus);
  assert.ok(weaker.some((x) => x.includes("drops a claim") && x.includes("promotion")), weaker.join(" | "));
  // a claim the original already makes is fine
  const prod = bi("Utrzymuję produkcyjne API.", "");
  assert.deepEqual(rewriteWarnings("/x", prod, bi("Rozwijam i utrzymuję produkcyjne API.", ""), corpus), []);
});

test("priorityWarnings: roles must keep the profile's order", () => {
  const master = profile({ experience: [{ id: "new", org: "New", start: "2024-01" }, { id: "old", org: "Old", start: "2018-01", end: "2023-12" }] });
  const w = priorityWarnings(master, variantSchema.parse({ id: "v", name: "V", experience: [{ id: "old" }, { id: "new" }] }));
  assert.ok(w.some((x) => x.startsWith("Roles are reordered")));
  assert.deepEqual(priorityWarnings(master, variantSchema.parse({ id: "v", name: "V", experience: [{ id: "new" }] })), []);
});

test("setRewrites: saves, merges a language, removes, and refuses paths that are not rewordable", () => {
  let data = { ...emptyCvData(), profile: profile() };
  data = upsertVariant(data, { id: "v", name: "V" }).data;
  const path = "/experience/id=acme/bullets/id=b2/text";
  const first = setRewrites(data, "v", [{ path, text: { pl: "Testy jednostkowe i integracyjne w Jest." } }]);
  assert.equal(first.variant.rewrites.length, 1);
  assert.deepEqual(first.warnings, []);
  const second = setRewrites(first.data, "v", [{ path, text: { en: "Unit and integration tests in Jest." } }]);
  assert.deepEqual(second.variant.rewrites[0].text, { pl: "Testy jednostkowe i integracyjne w Jest.", en: "Unit and integration tests in Jest." });
  assert.equal(setRewrites(second.data, "v", [], [path]).variant.rewrites.length, 0);
  const noop = setRewrites(data, "v", [{ path, text: { pl: "Pisałem testy w Jest. " } }]);
  assert.equal(noop.variant.rewrites.length, 0, "the profile's own wording is not stored as a rewrite");
  assert.throws(() => setRewrites(data, "v", [{ path: "/contact/name", text: { pl: "X" } }]), /cannot reword/);
  assert.throws(() => setRewrites(data, "nope", []), /no variant/);
});

// ---- ATS check ---------------------------------------------------------------------------------

test("atsCheck: keywords present / dropped / missing in what the version prints", () => {
  const master = profile();
  const version = resolveVariant(master, variantSchema.parse({ id: "v", name: "V", projectIds: ["site"] })); // leaves out the Redis project
  const r = atsCheck(master, version, JOB, "pl", new Date("2026-10-01"));
  const status = Object.fromEntries(r.keywords.map((k) => [k.term, k.status]));
  assert.equal(status.TypeScript, "present");
  assert.equal(status.Redis, "dropped");
  assert.equal(status.Kubernetes, "missing");
  assert.equal(status.NestJS, "missing");
  assert.ok(r.actions.some((a) => a.includes("Redis")), r.actions.join(" | "));
  assert.ok(r.actions.some((a) => /Real gaps.*Kubernetes/.test(a)));
  assert.ok(r.score > 0 && r.score <= 100);
});

test("atsCheck: offer spelling differences, years asked vs dated roles, RODO clause and languages", () => {
  const master = profile();
  master.skills[0].items.push("NestJS");
  const r = atsCheck(master, master, JOB, "pl", new Date("2026-10-01"));
  const nest = r.keywords.find((k) => k.term === "NestJS");
  assert.equal(nest.status, "present");
  assert.equal(nest.postingSpelling, "Nest.js");
  assert.equal(nest.spellingDiffers, true);
  const years = r.checks.find((c) => c.id === "years");
  assert.equal(years.level, "info");
  assert.match(years.message, /asks for 4\+ years; your dated roles cover about 3\.8/);
  assert.equal(r.checks.find((c) => c.id === "consent"), undefined, "the Polish clause is set");
  assert.equal(r.checks.find((c) => c.id === "language-en").level, "ok");
  const en = atsCheck(master, master, JOB, "en", new Date("2026-10-01"));
  assert.equal(en.checks.find((c) => c.id === "consent"), undefined, "the clause is only required in Polish");
  const noConsent = profile({ consent: bi("", "") });
  assert.equal(atsCheck(noConsent, noConsent, JOB, "pl").checks.find((c) => c.id === "consent").level, "warn");
});

test("atsCheck: only technologies and board skills are keywords; fixable vs gaps; done when nothing is fixable", () => {
  const master = profile();
  const job = { ...JOB, requirements: ["Strong programming skills: writing clean code", "TypeScript"], skills: [{ name: "Data Science", level: 3, required: true }, { name: "Jest testing", level: 2, required: false }] };
  const r = atsCheck(master, master, job, "pl", new Date("2026-10-01"));
  const terms = r.keywords.map((k) => k.term);
  for (const noise of ["programming", "writing", "clean", "strong", "skills"]) assert.ok(!terms.includes(noise), `${noise} is not a keyword`);
  assert.equal(r.keywords.find((k) => k.term === "Data Science").status, "missing");
  assert.ok(r.gaps.includes("Data Science"));
  assert.ok(!r.fixable.some((f) => f.includes("Data Science")), "a gap is never something to fix");
  // a version that leaves out the project with Redis: fixable; the master itself: nothing to fix
  const v = resolveVariant(master, variantSchema.parse({ id: "v", name: "V", projectIds: ["site"] }));
  assert.ok(atsCheck(master, v, job, "pl").fixable.some((f) => f.includes("Redis")));
  assert.deepEqual(atsCheck(master, master, { ...job, niceToHave: [] }, "pl").fixable, []);
});

test("priorityWarnings: pinned items left out, pinned projects not first, projects after experience", () => {
  const master = profile();
  master.projects[1].pinned = true; // site
  master.experience[0].bullets[2].pinned = true;
  const bad = variantSchema.parse({ id: "v", name: "V", experience: [{ id: "acme", bulletIds: ["b1"] }], projectIds: ["trainer"] });
  const w = priorityWarnings(master, bad);
  assert.ok(w.some((x) => x.includes("bullet /experience/id=acme/bullets/id=b3")));
  assert.ok(w.some((x) => x.includes("Pinned project “Portfolio site”")));
  assert.ok(w.some((x) => x.includes("projects print before experience")));
  const notFirst = variantSchema.parse({ id: "v", name: "V", projectIds: ["trainer", "site"], sectionOrder: ["summary", "projects", "experience"] });
  assert.deepEqual(priorityWarnings(master, notFirst).filter((x) => !x.includes("bullet")), ["Pinned projects must lead the project list: put them first in projectIds."]);
  const good = variantSchema.parse({ id: "v", name: "V", projectIds: ["site", "trainer"], sectionOrder: ["summary", "projects", "experience"] });
  assert.deepEqual(priorityWarnings(master, good), []);
  // the user's own fixed order wins over the "projects first" rule
  assert.deepEqual(priorityWarnings({ ...master, sectionOrder: ["experience", "projects"] }, variantSchema.parse({ id: "v", name: "V", projectIds: ["site", "trainer"] })), []);
  // and the ATS check reports them as fixable
  const r = atsCheck(master, resolveVariant(master, bad), JOB, "pl", new Date(), bad);
  assert.ok(r.fixable.some((f) => f.includes("Pinned project")));
});

test("experienceMonths and yearsAsked", () => {
  const p = profile({ experience: [{ id: "a", org: "A", start: "2020-01", end: "2020-12" }, { id: "b", org: "B", start: "2020-07", end: "2021-06" }, { id: "c", org: "C", start: "" }] });
  assert.equal(experienceMonths(p), 18, "overlap counted once, undated ignored");
  assert.equal(yearsAsked(["min. 4 lat doświadczenia (w tym min. 2 lata jako mid)"]), 4);
  assert.equal(yearsAsked(["3+ years of Python"]), 3);
  assert.equal(yearsAsked(["3-5 years"]), 3);
  assert.equal(yearsAsked(["Docker"]), null);
});

// ---- projects from GitHub ------------------------------------------------------------------------

test("parseRepoRef: links, owner/name and bare names; junk refused", () => {
  assert.equal(parseRepoRef("https://github.com/jan/trainer"), "jan/trainer");
  assert.equal(parseRepoRef("https://github.com/jan/trainer.git"), "jan/trainer");
  assert.equal(parseRepoRef("github.com/jan/trainer/tree/main/src?x=1#readme"), "jan/trainer");
  assert.equal(parseRepoRef("jan/trainer"), "jan/trainer");
  assert.equal(parseRepoRef("trainer"), "trainer");
  assert.equal(parseRepoRef("https://gitlab.com/jan/trainer"), null);
  assert.equal(parseRepoRef("jan/../etc"), null);
});

test("projectDraft: name, link, main languages, known technologies, description in EN only", () => {
  const facts = {
    ...emptyFacts("github", "trainer"),
    url: "https://github.com/jan/trainer",
    description: "Fine-tune local LLMs from a web UI",
    languages: { Python: 70_000, TypeScript: 25_000, Shell: 2_000 },
    topics: ["llm", "fastapi", "pytorch"],
    manifests: [{ file: "package.json", name: "ui", dependencies: ["react", "react-dom", "next"] }],
  };
  assert.deepEqual(mainLanguages(facts.languages), ["Python", "TypeScript"]);
  const tech = techFromFacts(facts);
  for (const t of ["Python", "TypeScript", "FastAPI", "React", "Next.js"]) assert.ok(tech.includes(t), `${t} in ${tech.join(", ")}`);
  assert.ok(!tech.includes("Shell"), "under 5% of the code");
  assert.equal(projectDraft({ ...facts, name: "jan/other-repo" }, "jan/other-repo", profile()).name, "other-repo", "owner/name facts give the repo name");
  const draft = projectDraft(facts, "jan/trainer", profile(), true);
  assert.equal(draft.id, "trainer-2", "the id never collides with an existing project");
  assert.deepEqual(draft.summary, { pl: "", en: "Fine-tune local LLMs from a web UI" });
  assert.equal(draft.source, "github:jan/trainer");
  assert.equal(draft.pinned, true);
});
