// Legal pages (src/lib/legal/legal.ts): instance overrides win over the shipped defaults, placeholders are filled from
// legal.json or reported, the version follows every rendered text, and the Markdown renderer never passes HTML through.
// Versions: every edition of the defaults is in legal/versions.json (the repo is held to it here: a text change without
// a new edition, or a new cookie / storage area the privacy notice does not cover, fails), the instance keeps every
// version it showed, and the effective date never predates the day a version was first shown.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "knife-legal-test-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const dir = join(scratch, "legal");
mkdirSync(dir);
const env = { KNIFE_LEGAL_DIR: dir, KNIFE_DATA_DIR: join(scratch, "data"), KNIFE_PUBLIC_URL: "https://knife.example.org/" };
const legal = await import("../src/lib/legal/legal.ts");

test("shipped defaults exist for every doc and language and use only documented placeholders", () => {
  const documented = new Set(Object.keys(JSON.parse(readFileSync(join(process.cwd(), "legal", "legal.example.json"), "utf8"))));
  for (const name of ["siteName", "siteUrl", "minimumAge"]) documented.add(name);
  for (const doc of legal.LEGAL_DOCS) {
    for (const lang of legal.LEGAL_LANGS) {
      const text = readFileSync(join(process.cwd(), "legal", `${doc}.${lang}.md`), "utf8");
      assert.ok(text.length > 2000, `${doc}.${lang}.md looks empty`);
      for (const [, name] of text.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g)) {
        assert.ok(documented.has(name), `${doc}.${lang}.md uses {{${name}}}, which legal.example.json does not document`);
      }
    }
  }
});

test("without legal.json the defaults render with visible gaps; legal.json fills them", () => {
  const before = legal.legalPage("terms", "pl", env);
  assert.equal(before.source, "default");
  assert.ok(before.missing.includes("operatorName"));
  assert.match(before.markdown, /\[operatorName\?\]/);
  assert.ok(legal.legalGaps(env).length > 0);
  const example = JSON.parse(readExample());
  writeFileSync(join(dir, "legal.json"), JSON.stringify(example));
  const after = legal.legalPage("terms", "pl", env);
  assert.deepEqual(legal.legalGaps(env), []);
  assert.ok(after.markdown.includes(example.operatorName));
  assert.notEqual(after.version, before.version, "new details = new version");
  assert.ok(after.markdown.includes("https://knife.example.org"), "siteUrl comes from KNIFE_PUBLIC_URL");
});

test("an instance file replaces the default page; legal.json \"version\" names the version", () => {
  writeFileSync(join(dir, "privacy.en.md"), "# Privacy\n\nContact {{contactEmail}}.\n");
  const page = legal.legalPage("privacy", "en", env);
  assert.equal(page.source, "instance");
  assert.match(page.html, /Contact .+@/);
  const hashed = legal.legalVersion(env);
  writeFileSync(join(dir, "privacy.en.md"), "# Privacy\n\nChanged.\n");
  assert.notEqual(legal.legalVersion(env), hashed, "any text change is a new version");
  writeFileSync(join(dir, "legal.json"), JSON.stringify({ ...JSON.parse(readExample()), version: "2026-10-21" }));
  assert.equal(legal.legalVersion(env), "2026-10-21");
  rmSync(join(dir, "privacy.en.md"));
});

test("malformed legal.json never crashes: defaults stay, gaps are reported", () => {
  writeFileSync(join(dir, "legal.json"), "{ not json");
  assert.ok(legal.legalGaps(env).includes("operatorName"));
});

test("the renderer shows raw HTML as text and keeps only safe links", () => {
  const html = legal.renderLegalMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1)) [y](https://ok.example) [z](/privacy) [m](mailto:a@b.c) ![i](https://img)');
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /javascript:/i);
  assert.match(html, /<a href="https:\/\/ok\.example" rel="noopener noreferrer">y<\/a>/);
  assert.match(html, /<a href="\/privacy">z<\/a>/);
  assert.match(html, /<a href="mailto:a@b\.c"/);
  assert.doesNotMatch(html, /<img/i);
});

test("headings take an explicit {#id} anchor and show no marker", () => {
  const html = legal.renderLegalMarkdown("## 7. AI assistant {#ai}\n\n## Plain\n");
  assert.match(html, /<h2 id="ai">7\. AI assistant<\/h2>/);
  assert.match(html, /<h2>Plain<\/h2>/);
});

test("language: ?lang wins, else a Polish browser gets Polish, everyone else English", () => {
  assert.equal(legal.pickLang("en", "pl-PL,pl;q=0.9"), "en");
  assert.equal(legal.pickLang(undefined, "pl-PL,pl;q=0.9"), "pl");
  assert.equal(legal.pickLang(undefined, "de-DE,en;q=0.5"), "en");
  assert.equal(legal.pickLang("xx", null), "en");
});

function readExample() {
  return readFileSync(join(process.cwd(), "legal", "legal.example.json"), "utf8");
}

/* ------------------------------------------------------------------------------------------- versions */

const ROOT = process.cwd();
const versionsFile = () => JSON.parse(readFileSync(join(ROOT, "legal", "versions.json"), "utf8"));

test("legal/versions.json: the newest edition's digest is the shipped defaults' (a text change needs a new edition)", () => {
  const [latest] = legal.legalEditions();
  assert.ok(latest, "legal/versions.json lists no edition");
  const digest = legal.defaultTextsDigest();
  assert.equal(latest.digest, digest,
    `legal/*.md changed since edition ${latest.edition} was recorded. Edition ${latest.edition} not released yet: set its "digest" to "${digest}". ` +
    `Already released: copy its texts (from the release tag) to legal/editions/${latest.edition}/, add edition ${latest.edition + 1} on top of legal/versions.json ` +
    `with "digest": "${digest}", and describe the change in terms § 17 / privacy § 15 (docs/LEGAL.md "Changing the texts").`);
  const numbers = legal.legalEditions().map((e) => e.edition);
  assert.deepEqual(numbers, [...numbers].sort((a, b) => b - a), "editions newest first");
  assert.equal(new Set(numbers).size, numbers.length, "edition numbers are unique");
});

test("every earlier edition's texts are kept in legal/editions/<n>/ and match their digest", () => {
  for (const edition of legal.legalEditions().slice(1)) {
    for (const doc of legal.LEGAL_DOCS) for (const lang of legal.LEGAL_LANGS) {
      assert.ok(existsSync(join(ROOT, "legal", "editions", String(edition.edition), `${doc}.${lang}.md`)), `legal/editions/${edition.edition}/${doc}.${lang}.md is missing`);
    }
    assert.equal(legal.defaultTextsDigest(edition.edition), edition.digest, `legal/editions/${edition.edition}/ differs from its digest`);
  }
});

test("each default text's change history names the newest edition and its app version", () => {
  const [latest] = legal.legalEditions();
  for (const doc of legal.LEGAL_DOCS) for (const lang of legal.LEGAL_LANGS) {
    const text = readFileSync(join(ROOT, "legal", `${doc}.${lang}.md`), "utf8");
    const anchor = doc === "terms" ? "{#history}" : "{#versions}";
    const section = text.slice(text.indexOf(anchor));
    assert.ok(text.includes(anchor), `${doc}.${lang}.md has no ${anchor} section`);
    assert.match(section, new RegExp(`\\*\\*(Edition|Wydanie) ${latest.edition}\\*\\*[^\\n]*${latest.app.replace(/\./g, "\\.")}`), `${doc}.${lang}.md: describe edition ${latest.edition} (${latest.app}) in its change history`);
  }
});

/** Every `knife_*` cookie name the app or its proxies set (constants named *COOKIE or *COOKIE_NAME). */
function cookieNames() {
  const names = new Set();
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
        for (const [, name] of readFileSync(full, "utf8").matchAll(/[A-Z_]*COOKIE(?:_NAME)?\s*=\s*"(knife_[a-z_]+)"/g)) names.add(name);
      }
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "scripts"));
  return [...names].sort();
}

test("every cookie the app sets is covered by the privacy notice (both languages)", () => {
  const found = cookieNames();
  assert.ok(found.includes("knife_session") && found.includes("knife_craft"), `cookie scan looks broken: ${found}`);
  const covered = versionsFile().covers.cookies;
  for (const name of found) {
    assert.ok(covered.includes(name), `cookie ${name} is set by the app but not in legal/versions.json covers.cookies: add it to the privacy notice's cookie table first`);
  }
  for (const name of covered) {
    for (const lang of legal.LEGAL_LANGS) {
      assert.ok(readFileSync(join(ROOT, "legal", `privacy.${lang}.md`), "utf8").includes(`\`${name}\``), `privacy.${lang}.md does not list the cookie ${name}`);
    }
  }
});

test("every per-account storage area is covered by the privacy notice", () => {
  const quota = readFileSync(join(ROOT, "src", "lib", "storage", "quota.ts"), "utf8");
  const union = /export type StorageArea = ([^;]+);/.exec(quota)?.[1] ?? "";
  const areas = [...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(areas.length >= 5, "StorageArea scan looks broken");
  const covered = versionsFile().covers.storageAreas;
  for (const area of areas) {
    assert.ok(covered[area], `storage area "${area}" (src/lib/storage/quota.ts) is not in legal/versions.json covers.storageAreas: describe what it stores in privacy § 3 first`);
  }
});

test("the fingerprint ignores the effective date; the date is never before the day the version was first shown", () => {
  const base = JSON.parse(readExample());
  writeFileSync(join(dir, "legal.json"), JSON.stringify({ ...base, effectiveDate: "2026-01-01" }));
  const early = legal.legalVersion(env);
  writeFileSync(join(dir, "legal.json"), JSON.stringify({ ...base, effectiveDate: "2030-01-01" }));
  assert.equal(legal.legalVersion(env), early, "only the date changed: same version");
  assert.equal(legal.effectiveDateFor("2026-01-01", "2026-10-22T10:00:00.000Z"), "2026-10-22");
  assert.equal(legal.effectiveDateFor("2030-01-01", "2026-10-22T10:00:00.000Z"), "2030-01-01");
  assert.equal(legal.effectiveDateFor(null, "2026-10-22T10:00:00.000Z"), "2026-10-22");
  assert.equal(legal.effectiveDateFor("1 listopada 2026", "2026-10-22T10:00:00.000Z"), "1 listopada 2026", "free text is kept");
  writeFileSync(join(dir, "legal.json"), JSON.stringify({ ...base, effectiveDate: undefined }));
  assert.ok(!legal.legalGaps(env).includes("effectiveDate"), "a missing effectiveDate is no gap: the publication day stands in");
  assert.match(legal.legalPage("privacy", "en", env).markdown, /Effective from: \d{4}-\d{2}-\d{2}\./);
});

test("the instance keeps every version it showed; earlier versions stay readable; a Terms change has a notice period", () => {
  rmSync(legal.legalHistoryDir(env), { recursive: true, force: true });
  const base = JSON.parse(readExample());
  writeFileSync(join(dir, "legal.json"), JSON.stringify({ ...base, effectiveDate: "2026-01-01", changeNoticeDays: "30" }));
  const first = legal.recordLegalVersion(env, new Date("2026-10-01T08:00:00Z"));
  assert.ok(first, "recorded");
  assert.equal(first.edition, legal.legalEditions()[0].edition, "the shipped defaults name their edition");
  assert.equal(legal.recordLegalVersion(env, new Date("2026-10-05T08:00:00Z")).publishedAt, first.publishedAt, "first write wins");
  assert.equal(legal.legalPage("terms", "pl", env).effectiveDate, "2026-10-01", "effective from the day it was first shown");

  // The privacy notice changes (an instance file): a new version; the Terms did not change, so no notice period.
  writeFileSync(join(dir, "privacy.en.md"), "# Privacy\n\nEffective from: {{effectiveDate}}. Changed text.\n");
  const second = legal.recordLegalVersion(env, new Date("2026-10-10T08:00:00Z"));
  assert.notEqual(second.version, first.version);
  assert.equal(second.edition, null, "an operator's own page has no default edition");
  assert.equal(legal.termsTransition(env), null, "only the privacy notice changed");
  const old = legal.legalPage("privacy", "en", env, { version: first.version });
  assert.equal(old.source, "history");
  assert.equal(old.current, false);
  assert.match(old.markdown, /Effective from: 2026-10-01\./);
  assert.doesNotMatch(old.markdown, /Changed text/);

  // The Terms change: accounts created earlier are bound after changeNoticeDays.
  writeFileSync(join(dir, "terms.pl.md"), "# Regulamin\n\nObowiązuje od: {{effectiveDate}}. Nowe zasady.\n");
  const third = legal.recordLegalVersion(env, new Date("2026-10-20T08:00:00Z"));
  assert.deepEqual(legal.termsTransition(env), { previous: second.version, publishedAt: third.publishedAt, existingAccountsFrom: "2026-11-19" });

  const history = legal.legalHistory(env);
  assert.deepEqual(history.map((h) => h.version), [first.version, second.version, third.version]);
  assert.equal(history[0].until, second.publishedAt);
  assert.equal(history[2].until, null);
  assert.deepEqual(history.map((h) => h.current), [false, false, true]);
  assert.equal(legal.legalPage("terms", "pl", env, { version: "no-such-version" }).current, true, "an unknown version shows the current one");
  rmSync(join(dir, "privacy.en.md"));
  rmSync(join(dir, "terms.pl.md"));
});

test("earlier editions of the defaults are readable, filled with the current details", () => {
  const editions = legal.legalEditions();
  const oldest = editions.at(-1);
  if (editions.length < 2) return;
  const page = legal.legalPage("privacy", "pl", env, { edition: oldest.edition });
  assert.equal(page.source, "edition");
  assert.equal(page.current, false);
  assert.equal(page.effectiveDate, oldest.published.slice(0, 10));
  assert.ok(page.markdown.includes(JSON.parse(readExample()).operatorName));
  assert.equal(legal.editionOn("2026-10-21T20:00:00Z")?.edition, 1);
  assert.equal(legal.editionOn("2020-01-01"), null);
});
