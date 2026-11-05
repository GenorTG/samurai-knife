// Tool sets (src/lib/toolsets.ts): every link is a live tool and tab, the texts are translated, a set that names a paid
// product carries what it replaces, and each comparison points at a real tool.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/toolsets.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { TOOL_SETS, TOP_TASKS, HOSTED_NOTES, findToolSet } = await import("../src/lib/toolsets.ts");
const await_showcases = await import("../src/lib/showcase.ts");
const await_nav = await import("../src/lib/nav.ts");
const { findTool, CATEGORIES, TOOLS } = await import("../src/lib/registry.ts");
const pl = JSON.parse(readFileSync(new URL("../src/lib/i18n/pl.json", import.meta.url), "utf8"));

function assertLive(href, where) {
  const url = new URL(href, "http://x");
  const match = /^\/tools\/([a-z0-9-]+)$/.exec(url.pathname);
  assert.ok(match, `${where}: ${href} is not a tool link`);
  const tool = findTool(match[1]);
  assert.ok(tool, `${where}: no tool ${match[1]}`);
  const tab = url.searchParams.get("tab");
  if (tab) assert.ok(tool.tabs?.some((candidate) => candidate.id === tab), `${where}: ${match[1]} has no tab ${tab}`);
}

test("every link of every set is a live tool and tab", () => {
  for (const set of TOOL_SETS) {
    assertLive(set.start.href, `${set.id} start`);
    for (const row of set.replaces) assertLive(row.href, `${set.id} ${row.paid}`);
    for (const task of set.tasks) assertLive(task.href, `${set.id} ${task.label}`);
  }
  for (const task of TOP_TASKS) assertLive(task.href, task.label);
});

test("sets have unique ids and at least one task; lookup works", () => {
  assert.equal(new Set(TOOL_SETS.map((set) => set.id)).size, TOOL_SETS.length);
  for (const set of TOOL_SETS) assert.ok(set.tasks.length > 0, set.id);
  assert.equal(findToolSet("office")?.id, "office");
  assert.equal(findToolSet("nope"), undefined);
});

const NAMES = /Microsoft|Adobe|Photoshop|Lightroom|Illustrator|Premiere|After Effects|InDesign|Audition|Acrobat|Figma|AutoCAD|Zapier|Creative Cloud|Google|n8n|\b(Word|Excel|PowerPoint)\b/;

test("no paid product or company is named in anything public; what is wrong with them is said", () => {
  const { SHOWCASES } = await_showcases;
  const { NAV } = await_nav;
  const read = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const sources = {
    sets: JSON.stringify(TOOL_SETS) + JSON.stringify(TOP_TASKS),
    registry: JSON.stringify(TOOLS.map((tool) => [tool.name, tool.tagline])),
    showcases: JSON.stringify(SHOWCASES),
    nav: JSON.stringify(NAV),
    greeter: read("components/Greeter.tsx"),
    welcome: read("components/welcome/WelcomeWizard.tsx"),
  };
  for (const [where, text] of Object.entries(sources)) assert.ok(!NAMES.test(text), `${where} names: ${NAMES.exec(text)?.[0]}`);
  assert.match(findToolSet("office").pitch, /spy/);
  assert.match(findToolSet("creative").pitch, /spy/);
  assert.match(sources.greeter, /spy on what you do/);
  for (const id of ["office", "creative", "automate"]) assert.ok(findToolSet(id).limits, `${id} needs its limits`);
});

test("hosted software is honest: whose it is, no ties either way, and a link to its source", () => {
  assert.deepEqual(findToolSet("office").hosted, ["office"]);
  assert.deepEqual(findToolSet("creative").hosted, ["craft"]);
  for (const note of Object.values(HOSTED_NOTES)) {
    assert.match(note.text, /We only host/);
    assert.match(note.text, /not affiliated/);
    assert.match(note.text, /they do not endorse us and we do not endorse them/);
    assert.match(note.source, /^https:\/\/github\.com\//);
    assert.ok(pl[note.text], "no Polish for the note");
  }
});

test("the ArtCraft name is attribution only: never in a set, a name or the guest page's own copy (docs/LEGAL.md)", () => {
  const text = JSON.stringify(TOOL_SETS) + JSON.stringify(TOP_TASKS) + readFileSync(new URL("../src/components/Greeter.tsx", import.meta.url), "utf8");
  assert.ok(!/artcraft/i.test(text.replace(/\/tools\/artcraft/g, "")), "ArtCraft appears in a set or on the guest page");
});

test("every category in use has a label and every set text is in the Polish catalogue", () => {
  const labelled = new Set(CATEGORIES.map((category) => category.id));
  for (const tool of TOOLS) assert.ok(labelled.has(tool.category), tool.slug);
  for (const set of TOOL_SETS) {
    for (const text of [set.name, set.headline, set.pitch, set.start.label, ...set.tasks.flatMap((task) => [task.label, task.hint])]) assert.ok(pl[text], `no Polish for: ${text}`);
  }
});
