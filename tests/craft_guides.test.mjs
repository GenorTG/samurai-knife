// node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/craft_guides.test.mjs
// The Craft app guides (src/lib/craft/guides.ts) name only commands the pinned app has, for the version it is pinned to.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";

const { craftGuide, CRAFT_GUIDE_APPS } = await import("../src/lib/craft/guides.ts");
const { ARTCRAFT_APPS } = await import("../src/lib/services/definitions.ts");

const fixture = (app, version) => new URL(`./fixtures/craft-commands/${app}-${version}.json`, import.meta.url);

// `name.id` tokens: lowercase first segment, then dot-separated segments (camelCase allowed). File paths and numbers
// ("/exports/out.mp4", "0.5") do not match: they start with a slash or a digit.
const COMMAND = /(?<![\w/.#$"])([a-z][a-zA-Z]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)(?![\w/])/g;
// words that look like ids but are not commands (file names, extensions in prose)
const NOT_COMMANDS = new Set(["guide.text"]);

function commandsIn(text) {
  const found = new Set();
  for (const m of text.matchAll(COMMAND)) {
    const id = m[1];
    if (/\.(png|svg|pdf|jpg|webp|webm|gif|mp4|fcproj|ecproj|json)$/i.test(id) || NOT_COMMANDS.has(id)) continue;
    found.add(id);
  }
  return [...found];
}

test("every guided app is a pinned Craft app with an agent API, guide version = the pin", () => {
  assert.ok(CRAFT_GUIDE_APPS.length >= 3);
  for (const app of CRAFT_GUIDE_APPS) {
    const site = ARTCRAFT_APPS.find((s) => s.id === app);
    assert.ok(site, `${app} is a Craft app`);
    const guide = craftGuide(app);
    assert.equal(guide.verified, site.version, `${app}: the guide was checked against the pinned version (re-run the recipes and refresh the fixture when the pin moves)`);
    assert.ok(existsSync(fixture(app, guide.verified)), `fixture for ${app} ${guide.verified}`);
    assert.ok(guide.brief.length > 40 && guide.brief.length < 400, `${app}: brief fits a snapshot note`);
    assert.ok(guide.text.length < 12_000, `${app}: guide stays well under a tool result (${guide.text.length})`);
  }
});

test("every command a guide names exists in that app's catalogue", () => {
  for (const app of CRAFT_GUIDE_APPS) {
    const guide = craftGuide(app);
    const { ids } = JSON.parse(readFileSync(fixture(app, guide.verified), "utf8"));
    const known = new Set(ids);
    const used = commandsIn(guide.text).concat(commandsIn(guide.brief));
    assert.ok(used.length > 15, `${app}: the guide names commands (${used.length})`);
    const missing = [...new Set(used.filter((id) => !known.has(id)))];
    assert.deepEqual(missing, [], `${app}: commands the ${guide.verified} catalogue does not have`);
  }
});

test("the id matcher finds commands and skips paths and numbers", () => {
  assert.deepEqual(commandsIn('run file.exportMedia {path:"/exports/out.mp4"} at 0.5 s, then prop.setExpression and edit.undo.'), ["file.exportMedia", "prop.setExpression", "edit.undo"]);
});

test("unknown apps have no guide", () => {
  assert.equal(craftGuide("photocraft"), null);
});
