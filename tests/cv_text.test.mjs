import assert from "node:assert/strict";
import { test } from "node:test";

// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/cv_text.test.mjs
// Ported from the Python prototype's test_text_lint / test_text_translation / test_text_tools. Synthetic data only.
const { profileSchema } = await import("../src/lib/cv/schema.ts");
const { applyOps } = await import("../src/lib/cv/ops.ts");
const { lintText, lintList } = await import("../src/lib/cv/text/lint.ts");
const { checkPair, droppedFacts } = await import("../src/lib/cv/text/translation.ts");
const glossary = await import("../src/lib/cv/text/glossary.ts");
const { biFields, ScopeError } = await import("../src/lib/cv/text/walk.ts");
const { auditProfile, auditTranslation, lintAdHoc } = await import("../src/lib/cv/text/audit.ts");
const { factWarnings } = await import("../src/lib/cv/text/guard.ts");
const { tokenize, isTech } = await import("../src/lib/cv/text/tokens.ts");

const rules = (text, lang, kind = "bullet") => lintText(text, lang, kind).map((f) => f.rule);
const has = (rule, text, lang, kind = "bullet") => rules(text, lang, kind).includes(rule);
const nbsp = " ";

const CLEAN_EN = "Cut deploy time from 40 to 12 minutes by moving the pipeline to GitHub Actions";
const CLEAN_PL = "Skróciłem czas wdrożenia z 40 do 12 minut, przenosząc pipeline do GitHub Actions";

// --- regex flavour: the Unicode-aware \w / \b of the Python prototype must hold on Polish text -----------------

test("tokenizer keeps Polish words, dotted names and C-like names whole", () => {
  assert.deepEqual(tokenize("Wdrożyłem Node.js, C++ i CI/CD").map((t) => t.text), ["Wdrożyłem", "Node.js", "C++", "i", "CI/CD"]);
  assert.ok(isTech("Node.js") && isTech("CI/CD") && isTech("gRPC") && isTech("API"));
  assert.ok(!isTech("Wdrożyłem") && !isTech("2020"));
});

// --- lint -------------------------------------------------------------------------------------------------------

test("clean text has no findings; empty text has none", () => {
  assert.deepEqual(lintText(CLEAN_EN, "en", "bullet"), []);
  assert.deepEqual(rules(CLEAN_PL, "pl"), ["nbsp-orphan"]); // the only nit: plain space after "z"
  assert.deepEqual(rules(CLEAN_PL.replace("z 40", `z${nbsp}40`), "pl"), []);
  assert.deepEqual(lintText("   ", "en", "bullet"), []);
});

for (const [text, lang] of [
  ["Responsible for the billing API", "en"],
  ["I was responsible for onboarding", "en"],
  ["Worked on the search backend", "en"],
  ["Helped with release planning", "en"],
  ["- Helped to migrate services", "en"],
  ["Odpowiedzialny za moduł rozliczeń", "pl"],
  ["Odpowiedzialna za utrzymanie API", "pl"],
  ["Zajmowałem się wdrożeniami w AWS", "pl"],
  ["Brałem udział w migracji do Kubernetes", "pl"],
  ["Brałam udział w projekcie Alfa", "pl"],
]) {
  test(`weak-opener flags: ${text}`, () => {
    const found = lintText(text, lang, "bullet").filter((f) => f.rule === "weak-opener");
    assert.equal(found.length, 1);
    assert.ok(found[0].span[0] <= 2);
  });
}

test("weak-opener checks each sentence but not mid-sentence", () => {
  assert.ok(has("weak-opener", "Led a team. Responsible for hiring.", "en", "summary"));
  assert.ok(!has("weak-opener", "Built tools; the team was responsible for QA", "en"));
  assert.ok(!has("weak-opener", "Zbudowałem narzędzie, za które byłem odpowiedzialny", "pl"));
});

for (const [text, lang, word] of [
  ["Dynamic engineer with a passion for data", "en", "Dynamic"],
  ["Passionate about clean code", "en", "Passionate"],
  ["A results-driven team player", "en", "results-driven"],
  ["Detail oriented and self-motivated", "en", "Detail oriented"],
  ["Dynamiczny programista z pasją", "pl", "Dynamiczny"],
  ["Zaangażowany i kreatywny członek zespołu", "pl", "Zaangażowany"],
  ["Osoba komunikatywna i odporna na stres", "pl", "komunikatywna"],
]) {
  test(`buzzword flags: ${text}`, () => {
    const hits = lintText(text, lang, "summary").filter((f) => f.rule === "buzzword");
    assert.ok(hits.map((f) => f.message).join(" ").includes(word));
  });
}

for (const [text, lang] of [
  ["Used dynamic programming to cut route search time", "en"],
  ["Wrote dynamic SQL generators for reporting", "en"],
  ["Zaimplementowałem programowanie dynamiczne w module tras", "pl"],
  ["Zaangażowany w projekt migracji do chmury", "pl"],
]) {
  test(`buzzword ignores technical sense: ${text}`, () => assert.ok(!has("buzzword", text, lang)));
}

test("first-person is flagged in English bullets only, each distinct word once", () => {
  assert.ok(has("first-person", "I built an API for my team", "en", "bullet"));
  assert.ok(has("first-person", "Built the thing that I designed", "en", "bullet"));
  assert.ok(!has("first-person", "I am a backend engineer.", "en", "summary"));
  assert.ok(!has("first-person", "Zbudowałem API dla mojego zespołu", "pl", "bullet"));
  assert.ok(!has("first-person", "Built Phase 1 and i18n support", "en", "bullet"));
  const [f] = lintText("I built my own tool, my way", "en", "bullet").filter((x) => x.rule === "first-person");
  assert.ok(f.message.includes("'I'") && f.message.includes("'my'") && f.message.split("'my'").length === 2);
});

const words = (n) => Array(n).fill("word").join(" ");

test("long-bullet thresholds", () => {
  assert.ok(!has("long-bullet", words(20), "en"));
  assert.equal(lintText(words(21), "en", "bullet").find((f) => f.rule === "long-bullet").severity, "info");
  const warn = lintText(words(29), "en", "bullet").find((f) => f.rule === "long-bullet");
  assert.ok(warn.severity === "warn" && warn.message.includes("29 words"));
  assert.ok(!has("long-bullet", words(60), "en", "summary"));
  assert.ok(has("long-bullet", words(30), "pl"));
});

test("no-signal flags vague bullets and accepts numbers, names and tech", () => {
  for (const [text, lang] of [["Improved processes and helped the team deliver better", "en"], ["Usprawniłem procesy i pomagałem zespołowi", "pl"]]) {
    const f = lintText(text, lang, "bullet").find((x) => x.rule === "no-signal");
    assert.ok(f.severity === "info" && f.hint.includes("made-up"));
  }
  for (const [text, lang] of [
    ["Reduced costs by 20 percent through better planning", "en"],
    ["Migrated the monolith to Kubernetes without downtime", "en"],
    ["Automated releases with docker and bash", "en"],
    ["Zmniejszyłem koszty o 20 procent dzięki planowaniu", "pl"],
    ["Zbudowałem integrację z Allegro dla sklepu", "pl"],
    ["Wdrożyłem CI/CD dla zespołu", "pl"],
  ]) assert.ok(!has("no-signal", text, lang), text);
  assert.ok(has("no-signal", "Improved onboarding for newcomers", "en"));
  assert.ok(!has("no-signal", "Mentored juniors", "en"));
  assert.ok(!has("no-signal", "Improved onboarding for newcomers", "en", "summary"));
});

test("typography: double space, space before punctuation, mixed quotes", () => {
  const f = lintText("Built  the API   fast", "en", "paragraph").find((x) => x.rule === "double-space");
  assert.deepEqual(f.span, [5, 7]);
  assert.ok(f.message.includes("(2x)"));
  assert.ok(!has("double-space", "Built the API fast", "en"));
  for (const t of ["Built the API , fast", "Built the API ; fast", "Why ?"]) assert.ok(has("space-before-punct", t, "en", "paragraph"), t);
  assert.ok(!has("space-before-punct", "Wrote services in .NET and .env files", "en"));
  assert.ok(!has("space-before-punct", "Built the API, then shipped it.", "en"));
  assert.ok(has("quote-mix", 'Led the "Alpha" project and the “Beta” launch', "en"));
  assert.ok(has("quote-mix", 'Projekt „Alfa” i projekt "Beta"', "pl"));
  assert.ok(has("quote-mix", "Don't use the “old” API", "en"));
  assert.ok(!has("quote-mix", 'Led the "Alpha" and "Beta" projects', "en"));
  assert.ok(!has("quote-mix", "Projekt „Alfa” i „Beta”", "pl"));
});

test("missing-diacritics only on long stripped Polish", () => {
  const f = lintText("Zbudowalem system rozliczen dla klientow z branzy logistycznej", "pl", "paragraph").find((x) => x.rule === "missing-diacritics");
  assert.equal(f.severity, "warn");
  assert.ok(!has("missing-diacritics", "Zbudowalem system", "pl"));
  assert.ok(!has("missing-diacritics", "Zbudowałem system rozliczeń dla klientów z logistyki", "pl"));
  const longEn = "Built a billing system for logistics customers across the whole region";
  assert.ok(!has("missing-diacritics", longEn, "en"));
  assert.ok(!has("missing-diacritics", longEn, "pl")); // English-in-PL, not stripped PL
  assert.ok(!has("missing-diacritics", "Kod na https://github.com/example/very-long-repository-name-x", "pl"));
  // A title or product line has no Polish function words: not evidence of stripped diacritics (real profile false positive).
  assert.ok(!has("missing-diacritics", "AI Systems Engineer · Full-Stack Developer · Infrastructure", "pl"));
});

test("nbsp-orphan flags a plain space after a single-letter word", () => {
  const f = lintText("Pracowałem w firmie Acme i Beta", "pl", "paragraph").find((x) => x.rule === "nbsp-orphan");
  assert.ok(f.severity === "info" && f.message.includes("2x"));
  assert.deepEqual(f.span, [11, 13]);
  assert.ok(!has("nbsp-orphan", `Pracowałem w${nbsp}firmie Acme i${nbsp}Beta`, "pl"));
  assert.ok(!has("nbsp-orphan", "Worked in a team of 5", "en"));
});

test("lang-mix: English inside Polish and Polish inside English, with tech/names whitelisted", () => {
  const f = lintText("Zbudowałem API with the new pipeline dla zespołu", "pl", "bullet").find((x) => x.rule === "lang-mix");
  assert.ok(f.message.includes("English") && f.message.includes("'with'") && f.message.includes("'the'"));
  assert.ok(has("lang-mix", "Built the API dla zespołu oraz klientów", "en"));
  assert.ok(has("lang-mix", "Built a tool for zespół leaders", "en")); // one diacritic word suffices
  assert.ok(!has("lang-mix", "Wdrożyłem Docker, Kubernetes i Terraform dla zespołu", "pl"));
  assert.ok(!has("lang-mix", "Worked with Łukasz Nowak on the Kraków office", "en"));
  assert.ok(!has("lang-mix", "Zbudowałem API for zespołu", "pl")); // one stray function word is not enough
});

test("lang-mix span points into the original text even after a URL", () => {
  const text = "Zobacz https://example.com/a oraz with the new API dla zespołu";
  const f = lintText(text, "pl", "paragraph").find((x) => x.rule === "lang-mix");
  assert.equal(text.slice(...f.span), "with");
});

const flat = (perItem) => perItem.flatMap((fs, i) => fs.map((f) => [i, f.rule]));

test("list rules: trailing-period minority, tie, single item", () => {
  assert.ok(flat(lintList(["Built the Acme API.", "Cut costs by 20%", "Shipped v2 to 5 clients"], "en")).some(([i, r]) => i === 0 && r === "trailing-period"));
  assert.ok(!flat(lintList(["Built the Acme API.", "Cut costs by 20%.", "Shipped v2 to 5 clients."], "en")).some(([, r]) => r === "trailing-period"));
  assert.deepEqual(flat(lintList(["Built the Acme API.", "Cut costs by 20%"], "en")).filter(([, r]) => r === "trailing-period").map(([i]) => i), [1]);
  assert.deepEqual(flat(lintList(["Built the Acme API."], "en")), []);
});

test("list rules: duplicate-opener needs three consecutive, case-insensitive, Polish", () => {
  const dup = (items, lang = "en") => flat(lintList(items, lang)).filter(([, r]) => r === "duplicate-opener").map(([i]) => i);
  assert.deepEqual(dup(["Developed API 1", "Developed API 2", "Developed API 3", "Cut costs by 5%"]), [1, 2]);
  assert.deepEqual(dup(["Developed API 1", "Developed API 2", "Cut costs by 5%", "Developed API 3"]), []);
  assert.deepEqual(dup(["Wdrożyłem CI w 3 zespołach", "wdrożyłem Docker w 2 projektach", "Wdrożyłem Helm w Acme"], "pl"), [1, 2]);
  const perItem = lintList(["Responsible for the Acme API", "Cut costs by 20%"], "en");
  assert.deepEqual(perItem[0].map((f) => f.rule), ["weak-opener"]);
  assert.deepEqual(perItem[1], []);
});

// --- translation ------------------------------------------------------------------------------------------------

const byRule = (pl, en) => {
  const out = {};
  for (const f of checkPair(pl, en)) (out[f.rule] ??= []).push(f.severity);
  return out;
};
const trRules = (pl, en) => new Set(Object.keys(byRule(pl, en)));

test("a faithful pair has no findings", () => {
  assert.deepEqual(checkPair("Skróciłem czas wdrożenia z 40 do 12 minut w GitHub Actions", "Cut deployment time from 40 to 12 minutes in GitHub Actions"), []);
});

test("one empty side is the only finding; both empty is fine", () => {
  const [f] = checkPair("Zbudowałem API", "");
  assert.ok(f.rule === "tr-missing" && f.message.includes("EN side is empty"));
  assert.ok(checkPair("", "Built an API")[0].message.includes("PL side is empty"));
  assert.deepEqual(checkPair("", "  "), []);
});

test("identical prose is an untranslated copy; identical names and tech are fine", () => {
  const text = "Built the billing system for logistics customers";
  assert.ok(trRules(text, text).has("tr-untranslated"));
  assert.ok(trRules(text, text.toUpperCase()).has("tr-untranslated"));
  for (const t of ["Python, Docker, Kubernetes", "Jan Kowalski", "https://acme.dev"]) assert.ok(!trRules(t, t).has("tr-untranslated"), t);
});

test("number missing from the other side is an error", () => {
  assert.deepEqual(byRule("Skróciłem czas o 40% do 12 minut", "Cut time by 30% to 12 minutes")["tr-number"], ["error", "error"]);
});

test("number matching ignores formatting", () => {
  const ok = (pl, en) => assert.ok(!trRules(pl, en).has("tr-number"), `${pl} | ${en}`);
  ok("Obsłużyłem 10 000 zapytań, wzrost o 3,5%", "Handled 10,000 requests, up 3.5%");
  ok("Przychód 1.250.000 zł", "Revenue 1,250,000 PLN");
  ok(`Obsłużyłem 10${nbsp}000 zapytań`, "Handled 10000 requests");
  ok("Python 3.12 i 2020-2022", "Python 3.12 and 2020-2022");
});

test("a spelled-out small number is only a warning; repeated numbers count", () => {
  assert.deepEqual(byRule("Prowadziłem 2 zespoły w Acme", "Led two teams at Acme")["tr-number"], ["warn"]);
  assert.deepEqual(byRule("Prowadziłem 25 zespołów w Acme", "Led twenty-five teams at Acme")["tr-number"], ["error"]);
  assert.ok(trRules("Zmniejszyłem koszty o 20% i czas o 20%", "Cut costs by 20% and time").has("tr-number"));
});

test("URL, email and version strings must match on both sides", () => {
  assert.ok(trRules("Kod: https://github.com/jan/app", "Code on GitHub").has("tr-url"));
  assert.ok(trRules("Kod na GitHub", "Code: github.com/jan/app").has("tr-url"));
  assert.ok(!trRules("Kod: https://www.github.com/jan/app/.", "Code: github.com/jan/app").has("tr-url"));
  assert.ok(trRules("Kontakt: jan@example.com", "Contact me").has("tr-email"));
  assert.ok(!trRules("Kontakt: Jan@Example.com", "Contact: jan@example.com").has("tr-email"));
  assert.ok(!trRules("Kontakt: jan@example.com", "Contact: jan@example.com").has("tr-url"));
  assert.ok(trRules("Migracja na v2.1.0", "Migration to v2.2.0").has("tr-version"));
  assert.ok(trRules("Wersja 1.4.2", "Release").has("tr-version"));
  assert.ok(!trRules("Migracja na v2.1.0", "Migration to v2.1.0").has("tr-version"));
  assert.ok(!trRules("Kwota 1.000.000 zł", "Amount 1,000,000 PLN").has("tr-version"));
});

test("names: missing tech term warns, inflection matches, proper noun is info, titles and sentence starts are not names", () => {
  assert.deepEqual(byRule("Wdrożyłem Docker i Kubernetes", "Deployed Docker and Helm")["tr-name"], ["warn", "warn"]);
  assert.ok(!trRules("Pracowałem w Dockerze i Pythonie", "Worked with Docker and Python").has("tr-name"));
  assert.ok(!trRules("Praca dla Acme'a w Krakowie", "Work for Acme in Kraków").has("tr-name"));
  assert.deepEqual(byRule("Pracowałem dla firmy Acme", "Worked for a logistics company")["tr-name"], ["info"]);
  assert.ok(!trRules("Zbudowałem narzędzie", "Built a tool").has("tr-name"));
  assert.ok(!trRules("Starszy Programista Backend", "Senior Software Developer").has("tr-name"));
  assert.ok(!trRules("Praca od stycznia 2021", "Work since January 2021").has("tr-name"));
});

test("extreme length ratio", () => {
  const pl = "Zaprojektowałem i wdrożyłem system rozliczeń dla klientów z sektora logistycznego";
  assert.ok(trRules(pl, "Built billing").has("tr-length"));
  assert.ok(!trRules(pl, "Designed and shipped a billing system for logistics clients").has("tr-length"));
  assert.ok(!trRules("Lider zespołu", "Team lead").has("tr-length"));
});

test("glossary drift is info; listed renderings are accepted; longest term wins; PL->EN only", () => {
  assert.deepEqual(byRule("Odpowiadałem za wdrożenia i utrzymanie", "Handled releases and upkeep of systems")["tr-glossary"], ["info", "info"]);
  assert.ok(!trRules("Przeprowadziłem wdrożenie systemu", "Rolled out the system").has("tr-glossary"));
  assert.ok(!trRules("Wieloletnie doświadczenie", "Years of experience").has("tr-glossary"));
  assert.ok(!trRules("Lider zespołu 5 osób", "Team leader of 5 people").has("tr-glossary"));
  assert.ok(!trRules("Analiza wymagań klienta", "Customer requirements gathering").has("tr-glossary"));
  assert.ok(!trRules("Praca w firmie", "Team lead experience").has("tr-glossary"));
});

test("droppedFacts reports numbers, urls, emails, versions and names that vanish", () => {
  assert.deepEqual(droppedFacts("Skróciłem build z 40 do 12 minut", "Skróciłem build do 12 minut", "pl"), ["number 40"]);
  assert.deepEqual(droppedFacts("Kod: https://github.com/jan/app", "Kod w repozytorium", "pl"), ["url github.com/jan/app"]);
  assert.deepEqual(droppedFacts("Napisz: jan@example.com", "Napisz do mnie", "pl"), ["email jan@example.com"]);
  assert.deepEqual(droppedFacts("Migracja na v2.1.0", "Migracja na nową wersję", "pl"), ["version v2.1.0"]);
  assert.deepEqual(droppedFacts("Wdrożyłem Docker i Kubernetes", "Wdrożyłem Docker", "pl"), ["name kubernetes"]);
  assert.deepEqual(droppedFacts("Built an API for 5 clients", "Built an API for five clients", "en"), ["number 5"]);
  assert.deepEqual(droppedFacts("Handled 10,000 requests", "Handled 10 000 requests", "en"), []); // formatting is not a fact
  assert.deepEqual(droppedFacts("Handled 10,000 requests", "Handled many requests", "en"), ["number 10000"]);
  assert.deepEqual(droppedFacts("Wdrożyłem CI w 3 projektach", "Wdrożyłem CI w 3 projektach", "pl"), []);
});

// --- glossary module --------------------------------------------------------------------------------------------

test("glossary size, uniqueness and prompt", () => {
  assert.ok(glossary.GLOSSARY.length >= 60);
  const pls = glossary.GLOSSARY.map((e) => e.pl);
  assert.equal(new Set(pls).size, pls.length);
  const prompt = glossary.glossaryPrompt();
  assert.ok(prompt.includes("lider zespołu <-> team lead"));
  assert.ok(prompt.includes("doświadczenie <-> experience"));
  assert.equal(prompt.split("\n- ").length - 1, glossary.GLOSSARY.length);
});

test("glossary search ignores case and diacritics; empty returns all; unknown none", () => {
  for (const [query, expected] of [["doswiadczenie", "doświadczenie"], ["TEAM LEAD", "lider zespołu"], ["lider", "lider zespołu"], ["zespol", "zespół"]]) {
    assert.ok(glossary.searchGlossary(query).map((e) => e.pl).includes(expected), query);
  }
  assert.equal(glossary.searchGlossary(null).length, glossary.GLOSSARY.length);
  assert.deepEqual(glossary.searchGlossary("zzzz"), []);
});

test("every inflection of a Polish term is recognised", () => {
  for (const [pl, term] of [["Wdrożenia", "wdrożenie"], ["doświadczeń", "doświadczenie"], ["utrzymaniu systemów", "utrzymanie"], ["liderem zespołu", "lider zespołu"], ["bazie danych", "baza danych"], ["klientów", "klient"]]) {
    assert.ok(glossary.GLOSSARY.find((e) => e.pl === term).plRe.test(pl), pl);
  }
});

// --- golden profile: exact finding paths -------------------------------------------------------------------------

const B = (id, exp = "exp-1") => `/experience/id=${exp}/bullets/id=${id}/text`;

/** Synthetic bilingual profile with deliberate, known defects. Never real data. */
const golden = () => profileSchema.parse({
  contact: { name: "Jan Test", headline: { pl: "Dynamiczny programista backend", en: "Backend developer" }, email: "jan@example.com" },
  summary: { pl: "Programista z 8-letnim doświadczeniem w Pythonie i AWS.", en: "Backend developer with 8 years of experience in Python and AWS." },
  experience: [
    {
      id: "exp-1", org: "Acme", role: { pl: "Programista", en: "Developer" }, start: "2020-01",
      bullets: [
        { id: "b1", text: { pl: "Odpowiedzialny za wdrożenia w AWS.", en: "Responsible for deployments on AWS." } },
        { id: "b2", text: { pl: "Skróciłem czas buildu z 40 do 12 minut", en: "Cut build time from 40 to 15 minutes" } },
        { id: "b3", text: { pl: "Zbudowałem API dla zespołu płatności", en: "I built an API for the payments team" } },
        { id: "b4", text: { pl: "Wdrożyłem CI w 3 projektach", en: "" } },
      ],
    },
    {
      id: "exp-2", org: "Beta", role: { pl: "Młodszy programista", en: "Junior developer" }, start: "2018-03", end: "2019-12",
      bullets: [{ id: "c1", text: { pl: "Utrzymanie aplikacji Django dla 5 klientów", en: "Maintenance of Django apps for 5 clients" } }],
    },
  ],
  projects: [{ id: "p1", name: "cv-helper", summary: { pl: "Asystent CV  z agentem i ,  repo: github.com/jan/cv-helper", en: "CV assistant built with an agent" } }],
  skills: [{ id: "s1", name: { pl: "Języki", en: "Languages" }, items: ["Python"] }],
  education: [{ id: "edu-1", institution: "Politechnika Test", detail: { pl: "Informatyka", en: "" } }],
});

const rulesAt = (res) => Object.fromEntries(Object.entries(res.findings).map(([p, fs]) => [p, fs.map((f) => f.rule)]));

test("audit EN golden: exact paths, counts and field count", () => {
  const res = auditProfile(golden(), "en");
  assert.deepEqual(rulesAt(res), {
    [`${B("b1")}/en`]: ["weak-opener", "trailing-period"],
    [`${B("b3")}/en`]: ["first-person"],
  });
  assert.deepEqual(res.counts, { error: 0, warn: 3, info: 0 });
  assert.deepEqual(res.byRule, { "first-person": 1, "trailing-period": 1, "weak-opener": 1 });
  assert.equal(res.fieldsChecked, 10); // b4 has no EN text yet, so it is skipped
});

test("audit PL golden: exact paths in profile order, counts and field count", () => {
  const res = auditProfile(golden(), "pl");
  assert.deepEqual(rulesAt(res), {
    "/contact/headline/pl": ["buzzword"],
    [`${B("b1")}/pl`]: ["weak-opener", "trailing-period"],
    "/projects/id=p1/summary/pl": ["double-space", "space-before-punct", "missing-diacritics"],
  });
  assert.deepEqual(res.counts, { error: 0, warn: 6, info: 0 });
  assert.equal(res.fieldsChecked, 12);
  assert.equal(Object.keys(res.findings)[0], "/contact/headline/pl"); // profile order, not alphabetical
});

test("typography-only findings (nbsp-orphan) are opt-in for profile audits", () => {
  const withTypo = auditProfile(golden(), "pl", "/", { includeTypography: true });
  assert.deepEqual(withTypo.findings["/summary/pl"].map((f) => f.rule), ["nbsp-orphan"]);
  assert.deepEqual(withTypo.counts, { error: 0, warn: 6, info: 5 });
  assert.equal(withTypo.fieldsChecked, 12);
  assert.ok(!Object.values(auditProfile(golden(), "pl").findings).flat().some((f) => f.rule === "nbsp-orphan"));
  // ad-hoc pasted text still reports it
  assert.ok(has("nbsp-orphan", "Pracowałem w firmie Acme i Beta", "pl"));
});

test("findings carry span, severity and hint; list-level findings have no span", () => {
  const res = auditProfile(golden(), "pl", "/experience/id=exp-1");
  const [weak, tie] = res.findings[`${B("b1")}/pl`];
  assert.deepEqual(weak.span, [0, 17]);
  assert.ok(weak.severity === "warn" && weak.hint);
  assert.ok(tie.rule === "trailing-period" && !("span" in tie));
});

test("audit scope narrows, accepts a trailing /pl, and validates with what exists", () => {
  const only = auditProfile(golden(), "pl", "/experience/id=exp-1/bullets");
  assert.deepEqual(Object.keys(only.findings), [`${B("b1")}/pl`]);
  assert.deepEqual(Object.keys(auditProfile(golden(), "pl", "/summary/pl", { includeTypography: true }).findings), ["/summary/pl"]);
  assert.throws(() => auditProfile(golden(), "en", "/experience/id=nope"), (e) => e instanceof ScopeError && /no item with id=nope/.test(e.message) && /exp-1/.test(e.message));
  assert.throws(() => auditProfile(golden(), "en", "x"), /scope must start/);
  assert.throws(() => auditProfile(golden(), "en", "/bogus"), /cannot resolve 'bogus'/);
  const empty = auditProfile(golden(), "en", "/experience/id=exp-1/bullets/id=b4");
  assert.equal(empty.fieldsChecked, 0);
  assert.deepEqual(empty.findings, {});
});

test("every path the audits report is a valid edit target for applyOps", () => {
  const profile = golden();
  for (const lang of ["pl", "en"]) {
    const paths = Object.keys(auditProfile(profile, lang).findings);
    assert.ok(paths.length > 0);
    const res = applyOps(profile, paths.map((path) => ({ op: "set", path, value: "x" })));
    assert.equal(res.changes.length, paths.length);
    assert.ok(res.changes.every((c) => typeof c.before === "string" && c.before !== ""));
  }
  const tr = auditTranslation(profile);
  const sides = [
    ...Object.keys(tr.findings).flatMap((p) => [`${p}/pl`, `${p}/en`]),
    ...tr.missingEn.map((p) => `${p}/en`),
    ...tr.missingPl.map((p) => `${p}/pl`),
  ];
  assert.ok(sides.length > 0);
  applyOps(profile, sides.map((path) => ({ op: "set", path, value: "x" })));
});

test("a clean profile reports nothing", () => {
  const clean = profileSchema.parse({ experience: [{ id: "e", org: "Acme", bullets: [{ id: "b", text: { pl: "Skróciłem build do 12 minut", en: "Cut build to 12 minutes" } }] }] });
  const res = auditProfile(clean, "en");
  assert.deepEqual(res.findings, {});
  assert.deepEqual(res.counts, { error: 0, warn: 0, info: 0 });
});

test("translation audit golden: findings, pairs and the translation backlog", () => {
  const res = auditTranslation(golden());
  assert.deepEqual(rulesAt(res), { [B("b2")]: ["tr-number", "tr-number"], "/projects/id=p1/summary": ["tr-url"] });
  assert.deepEqual(res.counts, { error: 3, warn: 0, info: 0 });
  assert.equal(res.pairsChecked, 10);
  assert.deepEqual(res.missingEn, [B("b4"), "/education/id=edu-1/detail"]);
  assert.deepEqual(res.missingPl, []);
  const scoped = auditTranslation(golden(), "/experience/id=exp-1");
  assert.deepEqual(Object.keys(scoped.findings), [B("b2")]);
  assert.deepEqual(scoped.missingEn, [B("b4")]); // education is out of scope
  assert.throws(() => auditTranslation(golden(), "/experience/id=zzz"), /no item with id=zzz/);
});

// --- ad-hoc lint (knife_cv_lint_text payload) ----------------------------------------------------------------

test("lintAdHoc: single text, defaults, list lines, summary stays one text", () => {
  const one = lintAdHoc("Responsible for  the API", "en", "bullet");
  assert.deepEqual(one.findings.map((f) => f.rule), ["weak-opener", "double-space"]);
  assert.deepEqual(one.counts, { error: 0, warn: 2, info: 0 });
  assert.equal(one.items, 1);

  const list = lintAdHoc("- Developed API 1.\n- Developed API 2.\n* Developed API 3.\n• Cut costs by 5%", "en");
  assert.equal(list.items, 4);
  const found = new Set(list.findings.map((f) => `${f.item}:${f.rule}`));
  for (const k of ["2:duplicate-opener", "3:duplicate-opener", "4:trailing-period"]) assert.ok(found.has(k), k);

  const summary = lintAdHoc("I build APIs.\nI like Python.", "en", "summary");
  assert.equal(summary.items, 1);
  assert.deepEqual(summary.findings, []);
});

// --- walk -------------------------------------------------------------------------------------------------------

test("biFields: kinds, bullet groups, and bad scope", () => {
  const byPath = Object.fromEntries(biFields(golden()).map((f) => [f.path, f]));
  assert.equal(byPath["/summary"].kind, "summary");
  assert.equal(byPath["/projects/id=p1/summary"].kind, "summary");
  assert.equal(byPath["/contact/headline"].kind, "paragraph");
  assert.equal(byPath[B("b1")].kind, "bullet");
  assert.equal(byPath[B("b1")].group, "/experience/id=exp-1/bullets");
  assert.equal(byPath[B("c1", "exp-2")].group, "/experience/id=exp-2/bullets");
  assert.throws(() => biFields(golden(), "/experience/id=exp-9"), /have: exp-1, exp-2/);
});

test("biFields finds every Bi that missingTranslations / applyOps address", () => {
  const paths = biFields(golden()).map((f) => f.path);
  assert.deepEqual(paths.slice(0, 3), ["/contact/headline", "/contact/location", "/summary"]);
  assert.ok(paths.includes("/education/id=edu-1/detail") && paths.includes("/consent") && paths.includes("/extras"));
});

// --- fact guard (shared by knife_cv_patch and POST /api/cv/patch) ------------------------------------------------

test("factWarnings: set on /pl or /en that drops a fact warns; harmless rewrites and other ops do not", () => {
  const profile = golden();
  const path = `${B("b2")}/pl`;
  const dropped = applyOps(profile, [{ op: "set", path, value: "Skróciłem czas buildu" }]);
  const warnings = factWarnings(dropped.changes);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].startsWith(`${path}: the new text drops number 40, number 12.`));
  assert.ok(warnings[0].includes("Restore them unless the user asked"));

  const kept = applyOps(profile, [{ op: "set", path, value: "Przyspieszyłem build: z 40 do 12 minut" }]);
  assert.deepEqual(factWarnings(kept.changes), []);

  const emptyBefore = applyOps(profile, [{ op: "set", path: `${B("b4")}/en`, value: "Set up CI in projects" }]);
  assert.deepEqual(factWarnings(emptyBefore.changes), []); // nothing to lose from an empty side

  const added = applyOps(profile, [{ op: "add", path: "/experience/id=exp-1/bullets/-", value: { id: "b9", text: { pl: "x", en: "y" } } }, { op: "remove", path: `${B("b2").replace("/text", "")}` }]);
  assert.deepEqual(factWarnings(added.changes), []);
});

test("factWarnings: urls, emails and names are guarded; a whole {pl,en} set is checked per side", () => {
  const profile = golden();
  const url = applyOps(profile, [{ op: "set", path: "/projects/id=p1/summary/pl", value: "Asystent CV z agentem" }]);
  assert.ok(factWarnings(url.changes)[0].includes("url github.com/jan/cv-helper"));
  const name = applyOps(profile, [{ op: "set", path: `${B("c1", "exp-2")}/en`, value: "Maintenance of apps for 5 clients" }]);
  assert.ok(factWarnings(name.changes)[0].includes("name django"));
  const whole = applyOps(profile, [{ op: "set", path: B("b2"), value: { pl: "Skróciłem czas buildu", en: "Cut build time from 40 to 15 minutes" } }]);
  const w = factWarnings(whole.changes);
  assert.equal(w.length, 1);
  assert.ok(w[0].startsWith(`${B("b2")}/pl:`));
});
