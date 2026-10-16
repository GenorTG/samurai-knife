// CV store (src/lib/cv/store.ts): damaged files and undo snapshots.
// Quality review 2026-10-10: a hand-edited/truncated cv/<id>.json threw a bare SyntaxError (opaque 500 on every write), and two saves
// inside one millisecond shared a snapshot name, so the older state was overwritten and one undo step vanished.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/cv_store.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-cv-store-"));
process.env.KNIFE_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { CvStoreError, loadCv, mutateCv, saveCv, undoCv } = await import("../src/lib/cv/store.ts");
const { emptyCvData } = await import("../src/lib/cv/schema.ts");
const { readAccountText } = await import("../src/lib/storage/sealed.ts");

const withName = (data, name) => ({ ...data, profile: { ...data.profile, contact: { ...data.profile.contact, name } } });
const nameOf = (id) => loadCv(id).profile.contact.name;

test("a truncated or hand-edited file is a CvStoreError with a readable reason, not a SyntaxError", () => {
  const id = "damaged";
  saveCv(id, withName(emptyCvData(), "Ada"));
  writeFileSync(join(dataDir, "cv", `${id}.json`), '{"revision": 3, "profile": {');
  assert.throws(() => loadCv(id), (error) => error instanceof CvStoreError && /not valid JSON/.test(error.message) && !error.message.includes(dataDir));
  assert.throws(() => mutateCv(id, (data) => ({ data, result: null })), CvStoreError);
});

test("a file that parses but breaks the schema is still a CvStoreError naming the field", () => {
  const id = "schema";
  saveCv(id, emptyCvData());
  writeFileSync(join(dataDir, "cv", `${id}.json`), JSON.stringify({ revision: "x" }));
  assert.throws(() => loadCv(id), (error) => error instanceof CvStoreError && /invalid at/.test(error.message));
});

test("undo restores states in order even when several saves land in the same millisecond", () => {
  const id = "rapid";
  saveCv(id, withName(emptyCvData(), "v1"));
  const realNow = Date.now;
  const frozen = new Date("2026-10-10T12:00:00.000Z");
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [frozen.getTime()])); }
    static now() { return frozen.getTime(); }
  };
  try {
    for (const name of ["v2", "v3", "v4", "v5"]) saveCv(id, withName(loadCv(id), name));
  } finally {
    globalThis.Date = RealDate;
    Date.now = realNow;
  }
  const snaps = readdirSync(join(dataDir, "cv", `${id}.snapshots`));
  assert.equal(snaps.length, 4, `one snapshot per save, got ${snaps.join(", ")}`);
  assert.equal(new Set(snaps).size, 4);
  assert.deepEqual([...snaps].sort(), snaps.slice().sort());
  const seen = [];
  for (let i = 0; i < 4; i++) {
    assert.equal(undoCv(id), true);
    seen.push(nameOf(id));
  }
  assert.deepEqual(seen, ["v4", "v3", "v2", "v1"]);
  assert.equal(undoCv(id), false);
});

test("the revision keeps rising through saves and undo", () => {
  const id = "rev";
  const first = saveCv(id, emptyCvData());
  const second = saveCv(id, withName(first, "x"));
  assert.equal(second.revision, first.revision + 1);
  assert.equal(undoCv(id), true);
  assert.equal(loadCv(id).revision, second.revision + 1);
  assert.doesNotMatch(readFileSync(join(dataDir, "cv", `${id}.json`), "latin1"), /"revision"/, "sealed at rest");
  assert.match(readAccountText(id, join(dataDir, "cv", `${id}.json`)), /"revision"/);
});

test("an account id with path characters is refused", () => {
  assert.throws(() => loadCv("../evil"), CvStoreError);
  assert.throws(() => saveCv("a/b", emptyCvData()), CvStoreError);
});
