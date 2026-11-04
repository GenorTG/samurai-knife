// Tool showcases (docs/SHOWCASE.md): every top-level registry tool has one, with the documented shape; every image
// a showcase names exists in public/ at 1280x800 and within the size budget; the card links follow the stored choice.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/showcase.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const { TOOLS, SLUG_ALIASES } = await import("../src/lib/registry.ts");
const { SHOWCASES, showcaseFor, showcaseHref } = await import("../src/lib/showcase.ts");
const { decodeShowcasePrefs, entryHref } = await import("../src/lib/showcase-prefs.ts");

/** Width and height of a lossy/lossless/extended WebP. */
function webpSize(buf) {
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 12), "WEBP");
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8X") return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
  if (chunk === "VP8 ") return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  if (chunk === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  throw new Error(`unknown WebP chunk ${chunk}`);
}

test("every top-level registry tool has a showcase, and nothing else does", () => {
  const slugs = TOOLS.map((tool) => tool.slug).sort();
  assert.deepEqual(Object.keys(SHOWCASES).sort(), slugs);
  for (const slug of slugs) assert.ok(showcaseFor(slug), slug);
  assert.equal(showcaseFor("constructor"), null, "no prototype keys");
  assert.equal(showcaseFor("cron"), null, "retired slugs are redirected by the page, they have no entry of their own");
});

test("each showcase says what it is for, 3-6 things to do, who, where it runs, the data line and the assistant", () => {
  for (const [slug, s] of Object.entries(SHOWCASES)) {
    for (const key of ["purpose", "audience", "data", "assistant"]) assert.ok(typeof s[key] === "string" && s[key].length > 10, `${slug}.${key}`);
    assert.ok(s.points.length >= 3 && s.points.length <= 6, `${slug}: 3-6 points`);
    assert.ok(s.runs.length >= 1 && s.runs.every((r) => ["browser", "server", "sidecar"].includes(r)), `${slug}.runs`);
    const tool = TOOLS.find((t) => t.slug === slug);
    if (tool.kind === "sidecar") assert.ok(s.runs.includes("sidecar"), `${slug}: a sidecar tool says it runs in a service`);
    if (tool.kind === "server") assert.ok(s.runs.includes("server"), `${slug}: a server tool says it runs on the server`);
  }
  const craft = SHOWCASES.artcraft;
  const tabs = TOOLS.find((t) => t.slug === "artcraft").tabs.map((tab) => tab.label);
  assert.deepEqual(craft.apps.map((a) => a.name), tabs, "the Craft showcase lists the thirteen apps in tab order");
  assert.equal(craft.apps.length, 13);
});

test("every image a showcase names exists: a 1280x800 WebP of at most ~120 kB", () => {
  for (const [slug, s] of Object.entries(SHOWCASES)) {
    if (!s.image) continue;
    assert.equal(s.image.src, `/showcase/${slug}.webp`, slug);
    assert.ok(["screenshot", "illustration"].includes(s.image.kind), slug);
    const file = join(ROOT, "public", s.image.src);
    assert.ok(existsSync(file), `${file} is missing: run scripts/showcase_shots.py`);
    assert.ok(statSync(file).size <= 125_000, `${slug}: ${statSync(file).size} bytes`);
    assert.deepEqual(webpSize(readFileSync(file)), [1280, 800], slug);
  }
});

test("cards open the showcase unless the user chose the tool directly or skipped this one", () => {
  const none = decodeShowcasePrefs(null);
  assert.equal(entryHref(none, "json"), "/tools/json/about");
  assert.equal(entryHref(none, "cv-studio", "website"), "/tools/cv-studio/about?tab=website");
  assert.equal(entryHref(decodeShowcasePrefs('{"direct":true}'), "cv-studio", "website"), "/tools/cv-studio?tab=website");
  const skip = decodeShowcasePrefs(JSON.stringify({ skip: ["json", "cron", "../x", 7] }));
  assert.deepEqual(skip.skip, ["json", "dates"], "retired slugs map to their suite; junk is dropped");
  assert.equal(entryHref(skip, "json"), "/tools/json");
  assert.equal(entryHref(skip, "pdf"), "/tools/pdf/about");
  assert.equal(entryHref(decodeShowcasePrefs("not json"), "pdf"), "/tools/pdf/about");
  assert.equal(showcaseHref("pdf"), "/tools/pdf/about");
  assert.ok(SLUG_ALIASES.cron, "fixture alias exists");
});
