// The assistant's "what is new" (src/lib/whats-new.ts, docs/MCP.md "What's new"): the newest entry is the release in
// package.json, every tool it names exists, knife_whats_new answers with the server's version, and the system prompt
// carries the version, the notes, every load_tools group and (only when the tab is older than the server) the reload hint.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/whats_new.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { WHATS_NEW } = await import("../src/lib/whats-new.ts");
const { KNIFE_TOOLS } = await import("../src/lib/mcp/tools.ts");
const { MCP_ONLY_TOOLS } = await import("../src/lib/mcp/server.ts");
const { buildSystemPrompt } = await import("../src/lib/agent-client/system-prompt.ts");
const { TOOL_GROUPS } = await import("../src/lib/agent-client/tool-groups.ts");

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the newest entry is the release in package.json, newest first", () => {
  assert.equal(WHATS_NEW[0].version, pkg.version, "add a WHATS_NEW entry for this release (src/lib/whats-new.ts)");
  const key = (v) => v.split(".").map((n) => n.padStart(4, "0")).join(".");
  for (let i = 1; i < WHATS_NEW.length; i += 1) assert.ok(key(WHATS_NEW[i - 1].version) > key(WHATS_NEW[i].version), `${WHATS_NEW[i - 1].version} before ${WHATS_NEW[i].version}`);
});

test("every tool a note names exists", () => {
  const names = new Set([...KNIFE_TOOLS, ...MCP_ONLY_TOOLS].map((t) => t.name));
  for (const entry of WHATS_NEW) {
    for (const item of entry.items) {
      for (const [name] of item.matchAll(/\bknife_[a-z_]+/g)) {
        if (name.endsWith("_")) continue; // a prefix such as knife_cv_*
        assert.ok(names.has(name), `${entry.version} names ${name}, which is not a tool`);
      }
    }
  }
});

test("knife_whats_new answers with the server's version and the notes", async () => {
  const tool = KNIFE_TOOLS.find((t) => t.name === "knife_whats_new");
  const out = await tool.execute({ count: 2 }, { accountId: "genor" });
  assert.equal(out.version, readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim());
  assert.equal(out.releases.length, 2);
  assert.equal(out.releases[0].version, pkg.version);
});

test("system prompt: version, notes, every loadable group; the reload hint only for an older tab", () => {
  const base = { pathname: "/", accountName: "genor" };
  const current = buildSystemPrompt({ ...base, version: "9.9.9.1", serverVersion: "9.9.9.1" });
  assert.match(current, /this tab runs Smart Knife v9\.9\.9\.1/);
  assert.ok(current.includes(`v${WHATS_NEW[0].version}`));
  assert.match(current, /knife_whats_new/);
  for (const g of TOOL_GROUPS.filter((x) => x.loadable !== false)) assert.ok(current.includes(`{group:"${g.id}"}`), `group ${g.id} missing`);
  assert.doesNotMatch(current, /reload the page/);
  const stale = buildSystemPrompt({ ...base, version: "9.9.9.1", serverVersion: "9.9.10.0" });
  assert.match(stale, /loaded with v9\.9\.9\.1, but the server now runs v9\.9\.10\.0/);
  assert.match(stale, /reload the page/);
  assert.doesNotMatch(buildSystemPrompt({ ...base, version: "9.9.9.1", serverVersion: null }), /reload the page/, "unknown server version is not a new one");
});
