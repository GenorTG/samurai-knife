import assert from "node:assert/strict";
import { test } from "node:test";

const { profileSchema, cvDataSchema } = await import("../src/lib/cv/schema.ts");
const { buildCvView, dateRange, safeHref } = await import("../src/lib/cv/render/view.ts");
const { typeset, NBSP, EN_DASH } = await import("../src/lib/cv/render/typography.ts");
const { cvViewToText, estimatePages } = await import("../src/lib/cv/render/text.ts");
const { cvFileName, resolveForRender } = await import("../src/lib/cv/render/resolve.ts");

// Synthetic only: never real personal data.
const sample = () =>
  profileSchema.parse({
    contact: {
      name: "Jan Testowy",
      headline: { pl: "Programista backend", en: "Backend developer" },
      location: { pl: "Wrocław, Polska", en: "Wroclaw, Poland" },
      email: "jan@example.test",
      phone: "+48 600 100 200",
      links: [
        { label: "github.com/jantest", url: "https://github.com/jantest" },
        { label: "LinkedIn", url: "https://www.linkedin.com/in/jantest/" },
        { label: "Portfolio", url: "https://jan.example.test/about" },
        { label: "again", url: "https://github.com/jantest/" },
        { label: "bad", url: "javascript:alert(1)" },
      ],
    },
    summary: { pl: "Buduję usługi w Pythonie i TypeScripcie.", en: "I build services in Python and TypeScript." },
    experience: [
      {
        id: "acme", org: "Acme", role: { pl: "Starszy programista", en: "Senior developer" }, start: "2022-03", end: null, location: "Wrocław",
        bullets: [
          { id: "a1", text: { pl: "Skróciłem czas buildu o 40% - z 20 do 12 min.", en: "Cut build time by 40% - from 20 to 12 min." } },
          { id: "a2", text: { pl: "Wdrożyłem CI w 2 tygodnie.", en: "" } },
          { id: "a3", text: { pl: "   ", en: "   " } },
        ],
      },
      { id: "old", org: "Beta", role: { pl: "Programista", en: "Developer" }, start: "2019-01", end: "2022-02", bullets: [] },
      { id: "ghost", org: "", role: { pl: "", en: "" } },
    ],
    projects: [
      { id: "p1", name: "Knife", url: "https://knife.example.test", summary: { pl: "Narzędzie w przeglądarce", en: "A browser tool" }, tech: ["TypeScript", " ", "Next.js"] },
      { id: "p2", name: "", url: "" },
    ],
    skills: [
      { id: "s1", name: { pl: "Języki", en: "Languages" }, items: ["Python", "TypeScript", ""] },
      { id: "s2", name: { pl: "Puste", en: "Empty" }, items: [] },
    ],
    education: [{ id: "e1", institution: "Politechnika Testowa", detail: { pl: "Informatyka", en: "" }, start: "2014-10", end: "2019-06" }],
    languages: [{ id: "l1", name: { pl: "Polski", en: "Polish" }, level: { pl: "ojczysty", en: "native" } }, { id: "l2", name: { pl: "", en: "" }, level: { pl: "x", en: "x" } }],
    consent: { pl: "Wyrażam zgodę na przetwarzanie danych osobowych.", en: "" },
    extras: { pl: "", en: "I like small, reviewable changes." },
  });

test("section titles, date ranges and present marker are localized", () => {
  const pl = buildCvView(sample(), "pl");
  const en = buildCvView(sample(), "en");
  assert.equal(pl.titles.experience, "Doświadczenie");
  assert.equal(en.titles.experience, "Experience");
  assert.deepEqual(
    [pl.titles.summary, pl.titles.projects, pl.titles.skills, pl.titles.education, pl.titles.languages, pl.titles.extras],
    ["Profil", "Wybrane projekty", "Technologie", "Edukacja", "Języki", "Sposób pracy"],
  );
  assert.equal(pl.experience[0].dates, "03.2022 — obecnie");
  assert.equal(en.experience[0].dates, "03.2022 — present");
  assert.equal(en.experience[1].dates, "01.2019 — 02.2022");
  assert.equal(dateRange("", "2020-05", "en"), "05.2020");
  assert.equal(dateRange("", null, "en"), "");
});

test("empty and untranslated fields are skipped: no empty bullets, no 'None'", () => {
  const en = buildCvView(sample(), "en");
  assert.equal(en.experience.length, 2, "an experience with no role and no org is dropped");
  assert.deepEqual(en.experience[0].bullets, ["Cut build time by 40% – from 20 to 12 min."]);
  assert.equal(en.projects.length, 1);
  assert.equal(en.projects[0].tech, "TypeScript, Next.js");
  assert.deepEqual(en.skills, [{ name: "Languages", items: "Python, TypeScript" }]);
  assert.equal(en.education[0].detail, "", "no borrowing from the other language");
  assert.deepEqual(en.languages, ["Polish — native"]);
  const text = JSON.stringify(en) + cvViewToText(en);
  assert.ok(!/None|undefined|null/.test(text), text);
  assert.ok(!cvViewToText(en).split("\n").some((l) => l.trim() === "-"), "no empty bullet lines");
});

test("consent prints only when written in that language", () => {
  assert.match(buildCvView(sample(), "pl").consent, /Wyrażam zgodę/);
  assert.equal(buildCvView(sample(), "en").consent, "");
  assert.ok(!cvViewToText(buildCvView(sample(), "en")).includes("zgod"));
  assert.ok(cvViewToText(buildCvView(sample(), "pl")).endsWith("danych osobowych."));
});

test("contact links are shown once and unsafe schemes never become links", () => {
  const { contact } = buildCvView(sample(), "en");
  assert.deepEqual(contact.map((c) => c.text), [
    "Wroclaw, Poland",
    "jan@example.test",
    "+48 600 100 200",
    "github.com/jantest", // label == shown: not "github.com/jantest: github.com/jantest", duplicate URL dropped
    "linkedin.com/in/jantest", // label contained in the shown URL: said once
    "Portfolio: jan.example.test/about",
    "bad: javascript:alert(1)",
  ]);
  assert.equal(contact[1].href, "mailto:jan@example.test");
  assert.equal(contact[2].href, "tel:+48600100200");
  assert.equal(contact[3].href, "https://github.com/jantest");
  assert.equal(contact.at(-1).href, "", "javascript: is plain text");
  assert.equal(safeHref("jan.example.test/x"), "https://jan.example.test/x");
  assert.equal(safeHref("data:text/html,x"), "");
  assert.ok(contact.every((c) => !/^(.+): \1$/.test(c.text)));
});

test("warnings list sections with content in the other language only", () => {
  const en = buildCvView(sample(), "en");
  assert.equal(en.warnings.length, 2, en.warnings.join("\n"));
  assert.ok(en.warnings.some((w) => w.startsWith("Experience: 1 field written in Polish but empty in English")));
  assert.ok(en.warnings.some((w) => w.startsWith("Education:")));
  assert.ok(!en.warnings.some((w) => /consent/i.test(w)), "the consent clause is not a translation gap");
  const pl = buildCvView(sample(), "pl");
  assert.deepEqual(pl.warnings, ["How I work: 1 field written in English but empty in Polish (/extras)"]);
});

test("typography: nbsp after single-letter Polish words, en dashes, Polish quotes", () => {
  assert.equal(typeset("Pracuję w Krakowie i w Gdańsku", "pl"), `Pracuję w${NBSP}Krakowie i${NBSP}w${NBSP}Gdańsku`);
  assert.equal(typeset("a to jest o co chodzi", "pl"), `a${NBSP}to jest o${NBSP}co chodzi`);
  assert.equal(typeset("Pracuję w Krakowie", "en"), "Pracuję w Krakowie", "english text is not bound");
  assert.equal(typeset("w Krakowie", "pl", { nbsp: false }), "w Krakowie", "DOCX path keeps plain spaces");
  assert.equal(typeset("2019-2022 i 05.2020-07.2021", "pl", { nbsp: false }), `2019${EN_DASH}2022 i 05.2020${EN_DASH}07.2021`);
  assert.equal(typeset("zespół - szybki", "en"), `zespół ${EN_DASH} szybki`);
  assert.equal(typeset('system "Alfa" i \'beta\'', "pl", { nbsp: false }), "system „Alfa” i ‚beta’");
  assert.equal(typeset('the "Alpha" team\'s tool', "en"), "the “Alpha” team’s tool");
  assert.equal(typeset("wait...", "en"), "wait…");
  assert.equal(typeset("", "pl"), "");
});

test("the HTML view uses nbsp, the DOCX view never does", () => {
  const docx = JSON.stringify(buildCvView(sample(), "pl", { nbsp: false }));
  assert.ok(!docx.includes(NBSP) && !docx.includes("\\u00a0"));
  const withNbsp = buildCvView(profileSchema.parse({ summary: { pl: "Pracuję w zespole", en: "" } }), "pl");
  assert.equal(withNbsp.summary, `Pracuję w${NBSP}zespole`);
});

test("plain text mirrors the printed order and the page estimate is sane", () => {
  const view = buildCvView(sample(), "en");
  const text = cvViewToText(view);
  const order = ["Jan Testowy", "PROFILE", "EXPERIENCE", "SELECTED PROJECTS", "TECHNOLOGY", "EDUCATION", "LANGUAGES", "HOW I WORK"].map((h) => text.indexOf(h));
  assert.ok(order.every((i) => i >= 0), String(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(text, /Senior developer, Acme {2}\(03\.2022 — present\)/);
  assert.ok(estimatePages(view) > 0 && estimatePages(view) < 1.5, String(estimatePages(view)));
  assert.equal(buildCvView(profileSchema.parse({}), "en").isEmpty, true);
});

test("resolve: master, variant, unknown variant lists the known ids", () => {
  const data = cvDataSchema.parse({
    version: 1,
    profile: sample(),
    variants: [{ id: "acme-only", name: "Acme only", lang: "en", experience: [{ id: "acme", bulletIds: ["a1"] }] }],
  });
  assert.equal(resolveForRender(data, null).profile.experience.length, 3);
  const variant = resolveForRender(data, "acme-only");
  assert.ok(variant.ok && variant.profile.experience.length === 1);
  const missing = resolveForRender(data, "nope");
  assert.ok(!missing.ok && missing.status === 404 && missing.error.includes("acme-only"));
});

test("download file names are ASCII", () => {
  assert.equal(cvFileName("Łukasz Żółć-Nowak", "pl", "docx"), "Lukasz-Zolc-Nowak-CV-pl.docx");
  assert.equal(cvFileName("", "en", "docx"), "CV-en.docx");
});
