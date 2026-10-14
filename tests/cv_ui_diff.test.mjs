// node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/cv_ui_diff.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

const { profileSchema } = await import("../src/lib/cv/schema.ts");
const { diffCv, diffCollections, describeChange, describeChanges, labelForPath, previewValue } = await import("../src/lib/cv/diff.ts");

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
  skills: [{ id: "sk-1", name: { pl: "Języki", en: "Languages" }, items: ["TypeScript", "Go"] }],
});

test("identical profiles produce no changes", () => {
  assert.deepEqual(diffCv(sample(), sample()), []);
  assert.deepEqual(diffCv(null, sample()), []);
});

test("a bullet edit is reported by id-path with before/after and a readable label", () => {
  const next = sample();
  next.experience[0].bullets[1].text.en = "Set up CI";
  const changes = diffCv(sample(), next);
  assert.equal(changes.length, 1);
  assert.deepEqual(
    [changes[0].kind, changes[0].path, changes[0].before, changes[0].after],
    ["changed", "/experience/id=exp-1/bullets/id=b2/text/en", "", "Set up CI"],
  );
  assert.equal(changes[0].label, "Experience › Acme › bullet b2 › text (EN)");
  assert.equal(describeChange(changes[0]), "Updated Experience › Acme › bullet b2 › text (EN): (empty) -> Set up CI");
});

test("added and removed list items are addressed by id, not index", () => {
  const next = sample();
  next.experience[0].bullets.shift();
  next.experience[0].bullets.push({ id: "b3", text: { pl: "x", en: "y" }, tags: [], verified: false });
  const changes = diffCv(sample(), next);
  const byKind = Object.fromEntries(changes.map((c) => [c.path, c.kind]));
  assert.equal(byKind["/experience/id=exp-1/bullets/id=b1"], "removed");
  assert.equal(byKind["/experience/id=exp-1/bullets/id=b3"], "added");
  assert.equal(changes.length, 2);
  assert.match(describeChange(changes.find((c) => c.kind === "removed")), /^Removed Experience › Acme › bullet b1$/);
});

test("reordering items is a change on the list path", () => {
  const next = sample();
  next.experience[0].bullets.reverse();
  const changes = diffCv(sample(), next);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, "/experience/id=exp-1/bullets");
  assert.equal(changes[0].after, "b2,b1");
});

test("string lists (skill items) diff as one leaf; scalar fields too", () => {
  const next = sample();
  next.skills[0].items.push("Rust");
  next.contact.name = "Jan Nowy";
  const changes = diffCv(sample(), next);
  assert.deepEqual(changes.map((c) => c.path).sort(), ["/contact/name", "/skills/id=sk-1/items"]);
  const items = changes.find((c) => c.path === "/skills/id=sk-1/items");
  assert.deepEqual(items.after, ["TypeScript", "Go", "Rust"]);
  assert.equal(items.label, "Skills › sk-1 › items");
});

test("whole-section changes: an empty list gaining items reports each item as added", () => {
  const next = sample();
  next.projects.push({ id: "p1", name: "Tool", url: "", summary: { pl: "", en: "" }, tech: [], bullets: [] });
  const changes = diffCv(sample(), next);
  assert.deepEqual(changes.map((c) => [c.kind, c.path]), [["added", "/projects/id=p1"]]);
  assert.equal(labelForPath(next, "/projects/id=p1/name"), "Projects › Tool › name");
});

test("toast helpers clip long text and count extra changes", () => {
  assert.equal(previewValue("a".repeat(100), 10), `${"a".repeat(9)}…`);
  assert.equal(previewValue(["x", "y"]), "x, y");
  const next = sample();
  next.contact.name = "Jan Nowy";
  next.summary.en = "Hello";
  const changes = diffCv(sample(), next);
  assert.match(describeChanges(changes), /\(\+1 more\)$/);
  assert.equal(describeChanges([]), "");
});

test("collections: added job, application status change and removal are reported by id", () => {
  const base = () => ({
    version: 1, revision: 1, profile: sample(), variants: [],
    jobs: [{ id: "acme-dev", company: "Acme", title: "Dev", url: "", text: "" }],
    applications: [{ id: "a1", company: "Acme", role: "Dev", status: "wishlist", history: [] }],
  });
  const next = base();
  next.jobs.push({ id: "beta-ops", company: "Beta", title: "Ops", url: "", text: "" });
  next.applications[0].status = "applied";
  const changes = diffCollections(base(), next);
  assert.deepEqual(changes.map((c) => [c.kind, c.path]), [["added", "/jobs/id=beta-ops"], ["changed", "/applications/id=a1/status"]]);
  assert.equal(describeChange(changes[0]), "Added Job offer Beta - Ops");
  assert.equal(describeChange(changes[1]), "Updated Application Acme - Dev › status: wishlist -> applied");
  const gone = base();
  gone.jobs = [];
  assert.deepEqual(diffCollections(base(), gone).map((c) => c.kind), ["removed"]);
});

// ---- version editor helpers (src/tools/cv/variant-edit.ts)
const edit = await import("../src/tools/cv/variant-edit.ts");
const { variantSchema } = await import("../src/lib/cv/schema.ts");
const { resolveVariant, danglingIds } = await import("../src/lib/cv/variant.ts");

const master = () => {
  const p = sample();
  p.projects.push({ id: "p1", name: "Tool", url: "", summary: { pl: "", en: "" }, tech: [], bullets: [] });
  p.projects.push({ id: "p2", name: "Lib", url: "", summary: { pl: "", en: "" }, tech: [], bullets: [] });
  return p;
};
const blankVariant = () => variantSchema.parse({ id: "v1", name: "V" });

test("version editor: a null overlay materialises to everything and collapses back to null", () => {
  const sel = edit.selectionOf(master(), blankVariant());
  assert.deepEqual(sel.experience, [{ id: "exp-1", bulletIds: ["b1", "b2"] }]);
  assert.deepEqual(sel.projectIds, ["p1", "p2"]);
  const back = edit.applySelection(master(), blankVariant(), sel);
  assert.equal(back.experience, null);
  assert.equal(back.projectIds, null);
  assert.equal(back.skillGroupIds, null);
});

test("version editor: toggling and reordering writes an explicit overlay that resolveVariant honours", () => {
  const m = master();
  let sel = edit.selectionOf(m, blankVariant());
  sel = edit.updateBullets(m, sel, "exp-1", { toggle: "b1" });
  sel = { ...sel, projectIds: edit.moveId(sel.projectIds, "p2", -1) };
  const v = edit.applySelection(m, blankVariant(), sel);
  assert.deepEqual(v.experience, [{ id: "exp-1", bulletIds: ["b2"] }]);
  assert.deepEqual(v.projectIds, ["p2", "p1"]);
  const resolved = resolveVariant(m, v);
  assert.deepEqual(resolved.experience[0].bullets.map((b) => b.id), ["b2"]);
  assert.deepEqual(resolved.projects.map((p) => p.id), ["p2", "p1"]);
  // re-including a bullet slots it back at its master position
  const again = edit.updateBullets(m, sel, "exp-1", { toggle: "b1" });
  assert.deepEqual(again.experience[0].bulletIds, ["b1", "b2"]);
});

test("version editor: role toggle keeps master order; pruneDangling removes stale ids", () => {
  const m = master();
  let sel = edit.selectionOf(m, blankVariant());
  sel = edit.toggleRole(m, sel, "exp-1");
  assert.deepEqual(sel.experience, []);
  sel = edit.toggleRole(m, sel, "exp-1");
  assert.deepEqual(sel.experience, [{ id: "exp-1", bulletIds: ["b1", "b2"] }]);
  const stale = variantSchema.parse({ id: "v2", name: "S", experience: [{ id: "exp-1", bulletIds: ["b1", "gone"] }, { id: "old", bulletIds: null }], projectIds: ["p1", "nope"] });
  assert.equal(danglingIds(m, stale).length, 3);
  const clean = edit.pruneDangling(m, stale);
  assert.deepEqual(danglingIds(m, clean), []);
  assert.deepEqual(clean.experience, [{ id: "exp-1", bulletIds: ["b1"] }]);
});
