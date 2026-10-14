import assert from "node:assert/strict";
import { test } from "node:test";

const { profileSchema, variantSchema, emptyCvData, cvDataSchema } = await import("../src/lib/cv/schema.ts");
const { applyOps, CvOpError, missingTranslations, readPath } = await import("../src/lib/cv/ops.ts");
const { resolveVariant, danglingIds } = await import("../src/lib/cv/variant.ts");

// Synthetic only: never real personal data.
const sample = () => profileSchema.parse({
  contact: { name: "Jan Test", headline: { pl: "Programista", en: "Developer" } },
  summary: { pl: "Opis", en: "" },
  experience: [{
    id: "exp-1", org: "Acme", role: { pl: "Dev", en: "Developer" }, start: "2020-01",
    bullets: [
      { id: "b1", text: { pl: "Zbudowałem API", en: "Built an API" } },
      { id: "b2", text: { pl: "Wdrożyłem CI", en: "" } },
    ],
  }],
});

test("missingTranslations lists fields filled only in the other language", () => {
  assert.deepEqual(missingTranslations(sample(), "en"), ["/summary", "/experience/id=exp-1/bullets/id=b2/text"]);
  assert.deepEqual(missingTranslations(sample(), "pl"), []);
});

test("set by id records before/after and leaves the input untouched", () => {
  const p = sample();
  const res = applyOps(p, [{ op: "set", path: "/experience/id=exp-1/bullets/id=b2/text/en", value: "Set up CI" }]);
  assert.equal(res.profile.experience[0].bullets[1].text.en, "Set up CI");
  assert.deepEqual([res.changes[0].before, res.changes[0].after], ["", "Set up CI"]);
  assert.equal(p.experience[0].bullets[1].text.en, "");
});

test("add (append) and remove by id", () => {
  const res = applyOps(sample(), [
    { op: "add", path: "/experience/id=exp-1/bullets/-", value: { id: "b3", text: { pl: "x", en: "y" } } },
    { op: "remove", path: "/experience/id=exp-1/bullets/id=b1" },
  ]);
  assert.deepEqual(res.profile.experience[0].bullets.map((b) => b.id), ["b2", "b3"]);
  assert.equal(res.changes[1].before.id, "b1");
});

test("a bad op is atomic and the message names the op, the reason and what exists", () => {
  assert.throws(
    () => applyOps(sample(), [
      { op: "set", path: "/summary/en", value: "ok" },
      { op: "set", path: "/experience/id=nope/org", value: "x" },
    ]),
    (e) => e instanceof CvOpError && /op 1 .*no item with id 'nope' \(have: exp-1\)/.test(e.message),
  );
  assert.throws(() => applyOps(sample(), [{ op: "set", path: "/sumary/en", value: "x" }]), /no field 'sumary'/);
  assert.throws(() => applyOps(sample(), [{ op: "set", path: "/summary/en", value: 123 }]), /result invalid at summary\/en/);
  assert.throws(() => applyOps(sample(), [{ op: "remove", path: "/summary/en" }]), /remove targets a list item/);
  assert.throws(() => applyOps(sample(), [{ op: "set", path: "summary", value: "x" }]), /must start with '\/'/);
});

test("readPath resolves id paths and rejects unknown ones with a reason", () => {
  assert.equal(readPath(sample(), "/experience/id=exp-1/org"), "Acme");
  assert.throws(() => readPath(sample(), "/experience/id=zzz"), /no item with id 'zzz'/);
});

test("resolveVariant picks/reorders bullets, overrides summary, keeps master untouched; null keeps all", () => {
  const master = sample();
  const v = variantSchema.parse({
    id: "acme", name: "Acme", summary: { pl: "Inne", en: "Other" },
    experience: [{ id: "exp-1", bulletIds: ["b2"] }], projectIds: [],
  });
  const out = resolveVariant(master, v);
  assert.deepEqual(out.experience[0].bullets.map((b) => b.id), ["b2"]);
  assert.equal(out.summary.en, "Other");
  assert.deepEqual(master.experience[0].bullets.map((b) => b.id), ["b1", "b2"]);
  assert.deepEqual(resolveVariant(master, variantSchema.parse({ id: "x", name: "x" })), master);
});

test("danglingIds reports ids the master no longer has", () => {
  const v = variantSchema.parse({
    id: "x", name: "x",
    experience: [{ id: "exp-1", bulletIds: ["b1", "gone"] }, { id: "exp-9" }],
    projectIds: ["p-9"],
  });
  assert.deepEqual(danglingIds(sample(), v), ["bullet:exp-1/gone", "experience:exp-9", "project:p-9"]);
});

test("cv data defaults are valid and ids are validated", () => {
  const data = emptyCvData();
  assert.equal(data.version, 1);
  assert.equal(data.revision, 0);
  assert.deepEqual(cvDataSchema.parse(data), data);
  assert.throws(() => variantSchema.parse({ id: "../evil", name: "x" }), /id: lowercase/);
});

const col = await import("../src/lib/cv/collections.ts");
const withProfile = () => ({ ...emptyCvData(), profile: sample() });

test("slugify folds Polish letters; uniqueId suffixes collisions", () => {
  assert.equal(col.slugify("Łódź Tech – Python Dev"), "lodz-tech-python-dev");
  assert.equal(col.uniqueId("Acme Dev", new Set(["acme-dev", "acme-dev-2"])), "acme-dev-3");
  assert.ok(!col.slugify("Acme Data Sp. z o.o. Inżynier AI / Python Developer (LLM, RAG)").endsWith("-"), "truncation must not leave a trailing dash");
});

test("upsertJob derives an id, keeps savedAt on update, detaches applications on delete", () => {
  const now = new Date("2026-10-09T10:00:00Z");
  let { data, job } = col.upsertJob(withProfile(), { company: "Acme", title: "Python Dev", url: "https://x.test/1" }, now);
  assert.equal(job.id, "acme-python-dev");
  assert.equal(job.savedAt, "2026-10-09T10:00:00.000Z");
  ({ data, job } = col.upsertJob(data, { id: job.id, requirements: ["Python"] }, new Date("2027-01-01")));
  assert.equal(job.savedAt, "2026-10-09T10:00:00.000Z");
  assert.deepEqual(job.requirements, ["Python"]);
  assert.equal(data.jobs.length, 1);
  ({ data } = col.upsertApplication(data, { company: "Acme", role: "Python Dev", jobId: job.id }, "", "2026-10-09"));
  data = col.removeJob(data, job.id);
  assert.equal(data.applications[0].jobId, null);
  assert.throws(() => col.removeJob(data, "zzz"), /no job 'zzz' \(have: none\)/);
});

test("upsertVariant validates ids against the profile and lists the valid ones", () => {
  const data = withProfile();
  assert.throws(
    () => col.upsertVariant(data, { id: "v1", name: "V", experience: [{ id: "exp-1", bulletIds: ["gone"] }] }),
    /bullet:exp-1\/gone.*Valid: experience exp-1\[b1,b2\]/s,
  );
  const { variant } = col.upsertVariant(data, { id: "v1", name: "V", experience: [{ id: "exp-1", bulletIds: ["b2"] }] });
  assert.deepEqual(variant.experience[0].bulletIds, ["b2"]);
});

test("application status changes append dated history; due list is open-only and sorted", () => {
  let data = withProfile();
  let app;
  ({ data, application: app } = col.upsertApplication(data, { company: "A", role: "r", status: "applied", nextActionDue: "2026-10-07" }, "", "2026-10-01"));
  ({ data } = col.upsertApplication(data, { company: "B", role: "r", status: "rejected", nextActionDue: "2026-09-01" }, "", "2026-10-01"));
  ({ data } = col.upsertApplication(data, { company: "C", role: "r", status: "interview", nextActionDue: "2026-10-12" }, "", "2026-10-01"));
  ({ data, application: app } = col.upsertApplication(data, { id: app.id, status: "interview" }, "sent PL CV", "2026-10-03"));
  assert.deepEqual(app.history.map((h) => [h.on, h.status, h.note]), [["2026-10-01", "applied", "created"], ["2026-10-03", "interview", "sent PL CV"]]);
  assert.deepEqual(col.dueApplications(data.applications, "2026-10-09").map((a) => a.company), ["A"]);
  assert.deepEqual(col.dueApplications(data.applications, "2026-10-09", 7).map((a) => a.company), ["A", "C"]);
  assert.throws(() => col.upsertApplication(data, { company: "D", role: "r", jobId: "ghost" }), /no job 'ghost'/);
});

// --- applied-on tracking (Genor 2026-10-09: keep track of when each offer was applied to, and which are still open) ----
test("appliedOn is stamped when an application becomes 'applied', never overwritten, and can be backfilled", () => {
  let data = withProfile();
  let app;
  ({ data, application: app } = col.upsertApplication(data, { company: "A", role: "r", status: "wishlist" }, "", "2026-10-01"));
  assert.equal(app.appliedOn, null);
  ({ data, application: app } = col.upsertApplication(data, { id: app.id, status: "applied" }, "sent", "2026-10-03"));
  assert.equal(app.appliedOn, "2026-10-03");
  ({ data, application: app } = col.upsertApplication(data, { id: app.id, status: "interview" }, "", "2026-10-09"));
  assert.equal(app.appliedOn, "2026-10-03", "moving on must not move the applied date");
  // created directly as applied today
  let b;
  ({ data, application: b } = col.upsertApplication(data, { company: "B", role: "r", status: "applied" }, "", "2026-10-05"));
  assert.equal(b.appliedOn, "2026-10-05");
  // backfill an older date explicitly
  let c;
  ({ data, application: c } = col.upsertApplication(data, { company: "C", role: "r", status: "applied", appliedOn: "2026-09-20" }, "", "2026-10-05"));
  assert.equal(c.appliedOn, "2026-09-20");
  // created straight in a later stage: date unknown stays null (we do not guess)
  let d;
  ({ data, application: d } = col.upsertApplication(data, { company: "D", role: "r", status: "interview" }, "", "2026-10-05"));
  assert.equal(d.appliedOn, null);
  assert.throws(() => col.upsertApplication(data, { company: "E", role: "r", appliedOn: "20-09-2026" }), /appliedOn: YYYY-MM-DD/);
});

test("summarizeApplication: days since applied, open/inProgress, overdue, closedOn", () => {
  let data = withProfile();
  let a;
  ({ data, application: a } = col.upsertApplication(data, { company: "A", role: "r", status: "applied", nextActionDue: "2026-10-07" }, "", "2026-10-01"));
  const open = col.summarizeApplication(a, "2026-10-09");
  assert.deepEqual([open.appliedOn, open.daysSinceApplied, open.open, open.inProgress, open.overdue, open.closedOn], ["2026-10-01", 8, true, true, true, null]);
  ({ data, application: a } = col.upsertApplication(data, { id: a.id, status: "rejected" }, "no thanks", "2026-10-08"));
  const closed = col.summarizeApplication(a, "2026-10-09");
  assert.deepEqual([closed.open, closed.inProgress, closed.overdue, closed.closedOn, closed.lastUpdate], [false, false, false, "2026-10-08", "2026-10-08"]);
  let w;
  ({ application: w } = col.upsertApplication(data, { company: "W", role: "r", status: "wishlist" }, "", "2026-10-09"));
  const wish = col.summarizeApplication(w, "2026-10-09");
  assert.deepEqual([wish.open, wish.inProgress, wish.daysSinceApplied], [true, false, null]);
  assert.equal(col.daysBetween("2026-02-27", "2026-03-02"), 3);
});
