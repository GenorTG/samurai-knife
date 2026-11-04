// Tool sets (src/lib/toolsets.ts): every link is a live tool and tab, the texts are translated, a set that names a paid
// product carries what it replaces, and each comparison points at a real tool.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/toolsets.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { TOOL_SETS, TOP_TASKS, TRADEMARK_NOTE, findToolSet } = await import("../src/lib/toolsets.ts");
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

test("what the owner asked to say out loud is said: Microsoft for Euro-Office, Adobe for the Craft apps", () => {
  const office = findToolSet("office");
  assert.match(office.headline, /Microsoft 365/);
  assert.ok(office.replaces.some((row) => row.paid === "Microsoft Word" && row.ours === "Euro-Office"));
  const creative = findToolSet("creative");
  assert.match(creative.headline, /Adobe/);
  assert.ok(creative.replaces.some((row) => row.paid === "Adobe Photoshop" && row.ours === "PhotoCraft"));
});

test("a named comparison stays fair: every paid name is in the trademark line, and big claims state their limits", () => {
  const names = TOOL_SETS.flatMap((set) => set.replaces.map((row) => row.paid)).filter((paid) => /^[A-Z]/.test(paid) && paid !== "Paid CV websites");
  for (const name of names) for (const part of name.replace(/^(Microsoft|Adobe) /, "").replace(" Pro", "").split(", ")) assert.ok(TRADEMARK_NOTE.includes(part.replace(/^Adobe /, "")), `${part} is missing from the trademark line`);
  for (const id of ["office", "creative", "automate"]) assert.ok(findToolSet(id).limits, `${id} needs its limits`);
});

test("every category in use has a label and every set text is in the Polish catalogue", () => {
  const labelled = new Set(CATEGORIES.map((category) => category.id));
  for (const tool of TOOLS) assert.ok(labelled.has(tool.category), tool.slug);
  for (const set of TOOL_SETS) {
    for (const text of [set.name, set.headline, set.pitch, set.start.label, ...set.tasks.flatMap((task) => [task.label, task.hint])]) assert.ok(pl[text], `no Polish for: ${text}`);
  }
});
