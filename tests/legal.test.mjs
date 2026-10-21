// Legal pages (src/lib/legal/legal.ts): instance overrides win over the shipped defaults, placeholders are filled from
// legal.json or reported, the version follows every rendered text, and the Markdown renderer never passes HTML through.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "knife-legal-test-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const dir = join(scratch, "legal");
mkdirSync(dir);
const env = { KNIFE_LEGAL_DIR: dir, KNIFE_PUBLIC_URL: "https://knife.example.org/" };
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
