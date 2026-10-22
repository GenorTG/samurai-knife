// Sidebar layout (src/lib/nav.ts) and the merged suites' redirects (src/lib/registry.ts toolHref/aliasTab): every menu
// entry is a live tool or tab, every tool is reachable, each Craft app is listed once (under "Advanced"), and the
// retired suites keep their old ?tab= links working.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/nav.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

const { NAV } = await import("../src/lib/nav.ts");
const { TOOLS, SLUG_ALIASES, toolHref, aliasTab, findTool } = await import("../src/lib/registry.ts");

const items = NAV.flatMap((section) => section.groups.flatMap((group) => group.items.map((item) => ({ ...item, section: section.id, group: group.title }))));

test("every menu entry is a live tool, and a tab entry a live tab of it", () => {
  for (const item of items) {
    const tool = findTool(item.slug);
    assert.ok(tool, `${item.section}: unknown slug ${item.slug}`);
    if (item.tab) assert.ok(tool.tabs?.some((tab) => tab.id === item.tab), `${item.slug} has no tab ${item.tab}`);
  }
  const keys = items.map((item) => `${item.slug}?${item.tab ?? ""}`);
  assert.equal(new Set(keys).size, keys.length, "no entry twice");
});

test("every tool is reachable from the menu (as a whole or through one of its tabs)", () => {
  const reachable = new Set(items.map((item) => item.slug));
  for (const tool of TOOLS) assert.ok(reachable.has(tool.slug), `${tool.slug} is not in the menu`);
});

test("each Craft app has its own line, under an Advanced group", () => {
  const craft = findTool("artcraft");
  const listed = items.filter((item) => item.slug === "artcraft");
  assert.deepEqual(listed.map((item) => item.tab).sort(), craft.tabs.map((tab) => tab.id).sort());
  assert.ok(listed.every((item) => item.group === "Advanced"), "Craft apps are advanced tools");
  const images = NAV.find((section) => section.id === "images");
  assert.deepEqual(images.groups.map((group) => group.title), ["Simple", "Advanced"]);
});

test("merged suites: the old slug keeps its tab (?tab= carried over), else the old suite's first tab", () => {
  assert.equal(toolHref("css-grid", "clamp"), "/tools/css?tab=clamp");
  assert.equal(toolHref("css-grid"), "/tools/css?tab=grid");
  assert.equal(toolHref("color"), "/tools/css?tab=colour");
  assert.equal(toolHref("box-shadow", "easing"), "/tools/css?tab=easing");
  assert.equal(toolHref("http-headers", "csp"), "/tools/web?tab=csp");
  assert.equal(toolHref("robots-txt", "sitemap"), "/tools/web?tab=sitemap");
  assert.equal(toolHref("meeting-timezones", "cron"), "/tools/dates?tab=cron");
  assert.equal(toolHref("csv-profile", "duplicates"), "/tools/csv?tab=duplicates");
  assert.equal(toolHref("yaml-json", "xml"), "/tools/json?tab=xml");
  assert.equal(toolHref("jwt", "password"), "/tools/ids?tab=password");
  assert.equal(toolHref("lottie-inspector"), "/tools/image-compare?tab=lottie");
  // An older alias that pointed at a now-merged suite is retargeted.
  assert.equal(toolHref("css-clamp"), "/tools/css?tab=clamp");
  assert.equal(toolHref("password"), "/tools/ids?tab=password");
  // A tab the target does not have falls back to the alias's own tab; live slugs pass a tab through.
  assert.equal(aliasTab("css-grid", "nope"), "grid");
  assert.equal(toolHref("css", "grid"), "/tools/css?tab=grid");
  for (const [slug, alias] of Object.entries(SLUG_ALIASES)) {
    const target = findTool(alias.slug);
    assert.ok(target, `${slug} -> ${alias.slug} is not live`);
    if (alias.tab) assert.ok(target.tabs?.some((tab) => tab.id === alias.tab), `${slug} -> ${alias.slug}?tab=${alias.tab} does not exist`);
  }
});
