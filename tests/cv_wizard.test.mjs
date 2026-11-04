// The CV wizard's answers -> profile (src/lib/cv/wizard.ts): valid against the real schema, typed dates in people's own
// formats, empty rows dropped, nothing invented; and what may be guessed from a pasted CV.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/cv_wizard.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

const { answersToProfile, emptyAnswers, guessFromCvText, monthProblem, normalizeMonth, suggestSummary, CONSENT_CLAUSE } = await import("../src/lib/cv/wizard.ts");
const { profileSchema } = await import("../src/lib/cv/schema.ts");

test("dates: the ways people write them", () => {
  for (const [typed, stored] of [["03.2022", "2022-03"], ["3/2022", "2022-03"], ["2022-3", "2022-03"], ["2022-03", "2022-03"], ["2022", "2022"], [" 12-2020 ", "2020-12"]]) assert.equal(normalizeMonth(typed), stored, typed);
  for (const typed of ["13.2022", "marzec", "0/2020", "22"]) {
    assert.equal(normalizeMonth(typed), "", typed);
    assert.equal(monthProblem(typed), true, typed);
  }
  assert.equal(monthProblem(""), false);
});

test("a full answer sheet is a valid profile, in the language written", () => {
  const a = { ...emptyAnswers("pl"), name: " Anna Nowak ", email: "anna@example.com", phone: "+48 600 100 200", city: "Gdańsk", link: "linkedin.com/in/anna", headline: "Księgowa",
    jobs: [{ org: "Acme", role: "Księgowa", start: "03.2020", end: "2022", current: false, duties: "- Prowadzenie ksiąg\n• Rozliczenia VAT\n\n" }, { org: "Beta", role: "Asystentka", start: "2022-04", end: "x", current: true, duties: "" }, { org: "", role: "", start: "", end: "", current: false, duties: "" }],
    schools: [{ institution: "UG", detail: "Finanse", start: "2015", end: "2018" }, { institution: " ", detail: "", start: "", end: "" }],
    skills: "Excel, SAP; Excel\nKsięgowość", languages: [{ name: "Angielski", level: "B2" }, { name: "", level: "" }], summary: "O mnie." };
  const profile = profileSchema.parse(answersToProfile(a));
  assert.equal(profile.contact.name, "Anna Nowak");
  assert.deepEqual(profile.contact.headline, { pl: "Księgowa", en: "" });
  assert.equal(profile.contact.links[0].url, "https://linkedin.com/in/anna");
  assert.equal(profile.experience.length, 2);
  assert.equal(profile.experience[0].start, "2020-03");
  assert.equal(profile.experience[0].end, "2022");
  assert.equal(profile.experience[1].end, null, "still working there");
  assert.deepEqual(profile.experience[0].bullets.map((b) => b.text.pl), ["Prowadzenie ksiąg", "Rozliczenia VAT"]);
  assert.deepEqual(profile.skills[0].items, ["Excel", "SAP", "Księgowość"]);
  assert.equal(profile.education.length, 1);
  assert.equal(profile.languages.length, 1);
  assert.equal(profile.consent.pl, CONSENT_CLAUSE.pl);
});

test("the minimum (a name) is valid too; no consent when it was switched off", () => {
  const a = { ...emptyAnswers("en"), name: "Sam Lee" };
  assert.equal(a.consent, false);
  const profile = profileSchema.parse(answersToProfile(a));
  assert.deepEqual(profile.experience, []);
  assert.equal(profile.consent.en, "");
});

test("the suggested summary only uses what was answered", () => {
  assert.equal(suggestSummary({ ...emptyAnswers("en") }), "");
  const text = suggestSummary({ ...emptyAnswers("en"), headline: "Accountant", skills: "Excel, SAP", jobs: [{ org: "Acme", role: "Clerk", start: "", end: "", current: true, duties: "" }] });
  assert.equal(text, "Accountant. Most recently Clerk at Acme. My strengths: Excel, SAP.");
});

test("reading a pasted CV: only what is safe", () => {
  const text = "Curriculum Vitae\nAnna Maria Nowak\nul. Długa 5, Gdańsk\ntel. +48 600 100 200\nanna.nowak@example.com\nhttps://www.linkedin.com/in/anna-nowak\nDoświadczenie\n2020-2022 Acme";
  assert.deepEqual(guessFromCvText(text), { email: "anna.nowak@example.com", phone: "+48 600 100 200", link: "https://www.linkedin.com/in/anna-nowak", name: "Anna Maria Nowak" });
  assert.deepEqual(guessFromCvText("nothing useful here 2020-2022"), {});
});
