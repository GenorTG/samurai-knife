// Release notes for people (src/lib/release-notes.ts) and the "What's new" window's state (account `seen`,
// src/lib/accounts/seen.ts): the package.json release has notes, every legal edition from 6 on has a plain summary,
// new accounts start at "seen everything", and the window's selection rules.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/release_notes.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-release-notes-"));
process.env.KNIFE_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { RELEASE_NOTES, LEGAL_EDITION_NOTES, compareRelease, unseen } = await import("../src/lib/release-notes.ts");
const { currentLegalEdition, currentRelease } = await import("../src/lib/accounts/seen.ts");
const store = await import("../src/lib/accounts/store.ts");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const versions = JSON.parse(readFileSync("legal/versions.json", "utf8"));

test("the package.json release has notes for people, newest first, each with something to say", () => {
  assert.equal(RELEASE_NOTES[0].version, pkg.version, "add an entry for the release in src/lib/release-notes.ts");
  for (let i = 1; i < RELEASE_NOTES.length; i += 1) assert.equal(compareRelease(RELEASE_NOTES[i - 1].version, RELEASE_NOTES[i].version), 1);
  for (const note of RELEASE_NOTES) {
    assert.ok(note.features.length + note.fixes.length > 0, note.version);
    for (const item of [...note.features, ...note.fixes]) assert.doesNotMatch(item, /knife_\w+/, "tool names belong in whats-new.ts (for agents)");
  }
});

test("every legal edition from 6 on has a plain summary; the server's edition is the newest one", () => {
  const newest = Math.max(...versions.editions.map((e) => e.edition));
  assert.equal(currentLegalEdition(), newest);
  for (let e = 6; e <= newest; e += 1) assert.ok(LEGAL_EDITION_NOTES[e], `summary for edition ${e}`);
  assert.equal(currentRelease(), pkg.version);
});

test("a new account has seen everything; markSeen records the current release and edition", () => {
  const account = store.newAccountRecord({ id: "fresh", displayName: "Fresh" });
  assert.equal(account.seen.version, pkg.version);
  assert.equal(account.seen.legalEdition, currentLegalEdition());
  assert.equal(unseen(account.seen, { version: pkg.version, legalEdition: currentLegalEdition() }), null, "first login: no window");
  // An account file from before 0.13.0 has no `seen`.
  store.mutateStore((s) => {
    const old = store.newAccountRecord({ id: "old", displayName: "Old" });
    delete old.seen;
    s.accounts.push(old);
  });
  assert.equal(store.getAccount("old").seen, null);
  store.markSeen("old");
  assert.equal(store.getAccount("old").seen.version, pkg.version);
});

test("selection: newer notes only; unknown = the current minor's notes and the current edition's summary", () => {
  const cur = { version: "0.13.0", legalEdition: 7 };
  const never = unseen(null, cur);
  assert.deepEqual(never.notes.map((n) => n.version), ["0.13.0"]);
  assert.deepEqual(never.legal.map((l) => l.edition), [7]);
  assert.equal(unseen({ version: "0.13.0", legalEdition: 7 }, cur), null);
  const legalOnly = unseen({ version: "0.13.0", legalEdition: 6 }, cur);
  assert.deepEqual(legalOnly.notes, []);
  assert.deepEqual(legalOnly.legal.map((l) => l.edition), [7]);
  assert.deepEqual(unseen({ version: "0.12.0", legalEdition: 5 }, cur).legal.map((l) => l.edition), [7, 6]);
  assert.equal(compareRelease("0.13.0.27", "0.13.0"), 0, "the build part never shows the window again");
  assert.equal(compareRelease("0.13.1", "0.13.0"), 1);
});
