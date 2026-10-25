// Sidebar layout (src/lib/nav.ts) and the merged suites' redirects (src/lib/registry.ts toolHref/aliasTab): every menu
// entry is a live tool or tab, every tool is listed exactly once (no duplicates), tabs are never entries except the Craft
// apps section, and the retired suites keep their old ?tab= links working.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/nav.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

const { NAV, NAV_FOOTER, navSectionOf } = await import("../src/lib/nav.ts");
const { TOOLS, SLUG_ALIASES, toolHref, aliasTab, findTool } = await import("../src/lib/registry.ts");

const items = [
  ...NAV.flatMap((section) => section.items.map((item) => ({ ...item, section: section.id }))),
  ...NAV_FOOTER.map((item) => ({ ...item, section: "footer" })),
];

test("every menu entry is a live tool, and a tab entry a live tab of it", () => {
  for (const item of items) {
    const tool = findTool(item.slug);
    assert.ok(tool, `${item.section}: unknown slug ${item.slug}`);
    if (item.tab) assert.ok(tool.tabs?.some((tab) => tab.id === item.tab), `${item.slug} has no tab ${item.tab}`);
  }
});

test("every tool is listed exactly once; only the Craft apps section lists tabs (each app once)", () => {
  const whole = items.filter((item) => !item.tab).map((item) => item.slug);
  assert.equal(new Set(whole).size, whole.length, `a tool is listed twice: ${whole.filter((slug, i) => whole.indexOf(slug) !== i)}`);
  const tabbed = items.filter((item) => item.tab);
  assert.ok(tabbed.every((item) => item.section === "craft" && item.slug === "artcraft"), "tabs are local navigation, not menu entries");
  assert.ok(!whole.includes("artcraft"), "the Craft suite is listed through its apps");
  const craft = findTool("artcraft");
  assert.deepEqual(tabbed.map((item) => item.tab).sort(), craft.tabs.map((tab) => tab.id).sort(), "each Craft app once");
  const reachable = new Set(items.map((item) => item.slug));
  for (const tool of TOOLS) assert.ok(reachable.has(tool.slug), `${tool.slug} is not in the menu`);
});

test("sections are non-empty, uniquely named, and breadcrumbs find a tool's section", () => {
  assert.equal(new Set(NAV.map((section) => section.id)).size, NAV.length);
  for (const section of NAV) assert.ok(section.items.length > 0, `${section.id} is empty`);
  assert.equal(navSectionOf("pdf")?.id, "documents");
  assert.equal(navSectionOf("artcraft")?.id, "craft");
  assert.equal(navSectionOf("sidecars"), undefined, "setup pages live in the footer");
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
  assert.equal(toolHref("lottie-inspector"), "/tools/image-compare");
  // Tools and tabs removed in the 2026-10-25 audit land on their closest neighbour.
  assert.equal(toolHref("heading-audit"), "/tools/web?tab=check");
  assert.equal(toolHref("http-headers", "headers"), "/tools/web?tab=check");
  assert.equal(toolHref("stacktrace", "ansi"), "/tools/text?tab=kit");
  assert.equal(toolHref("nosql-lab", "redis"), "/tools/sql-lab?tab=format");
  assert.equal(toolHref("file-compressor"), "/tools/pdf");
  assert.equal(toolHref("line-wrap"), "/tools/text?tab=kit");
  assert.equal(toolHref("iso-week"), "/tools/dates?tab=format");
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
