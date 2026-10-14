// node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/ui_bridge.test.mjs
// The bridge between MCP agents outside the app and the user's open tabs: presence, targeting, path rules.
import assert from "node:assert/strict";
import { test } from "node:test";

const { reportPresence, openTabs, takePending, requestShow, resetUiBridge, PRESENCE_TTL_MS, POLL_TTL_MS, validClientId } = await import("../src/lib/ui-bridge/store.ts");
const { showPath, ShowPathError } = await import("../src/lib/ui-bridge/path.ts");

const tab = (clientId, path, extra = {}) => ({ clientId, path, title: "T", visible: true, active: true, ...extra });

test("presence: tabs per account, most recently active first; stale tabs expire; account isolation", () => {
  resetUiBridge();
  reportPresence("a", tab("tab-one-0001", "/tools/cv-studio?tab=profile"), 1_000);
  reportPresence("a", tab("tab-two-0002", "/tools/json"), 2_000);
  reportPresence("a", tab("tab-one-0001", "/tools/cv-studio?tab=jobs", { active: false }), 3_000);
  const tabs = openTabs("a", 3_000);
  assert.deepEqual(tabs.map((t) => t.clientId), ["tab-two-0002", "tab-one-0001"], "a report without activity keeps the old activity time");
  assert.equal(tabs[1].path, "/tools/cv-studio?tab=jobs");
  assert.deepEqual(openTabs("b", 3_000), []);
  assert.deepEqual(openTabs("a", 3_000 + PRESENCE_TTL_MS + 1), [], "gone after the TTL");
});

test("requestShow: goes to the most recently active LISTENING tab, or the named one; only the latest request is kept", () => {
  resetUiBridge();
  const now = 100_000;
  reportPresence("a", tab("tab-one-0001", "/tools/json"), now - 500);
  reportPresence("a", tab("tab-two-0002", "/tools/diff"), now);
  assert.equal(requestShow("a", "/tools/cv-studio", "", "MCP agent", undefined, now), null, "nobody polls yet");
  takePending("a", "tab-one-0001", now);
  const sent = requestShow("a", "/tools/cv-studio?tab=jobs", "look", "MCP agent", undefined, now);
  assert.equal(sent.tab.clientId, "tab-one-0001", "the newer tab does not poll, so the listening one is the target");
  requestShow("a", "/tools/cv-studio?tab=variants", "later", "MCP agent", undefined, now);
  assert.deepEqual(takePending("a", "tab-one-0001", now).map((e) => [e.path, e.note, e.target]), [["/tools/cv-studio?tab=variants", "later", "tab-one-0001"]]);
  assert.deepEqual(takePending("a", "tab-one-0001", now), [], "picked up once");
  assert.equal(requestShow("a", "/tools/x", "", "MCP agent", "tab-two-0002", now), null, "a named tab that does not poll");
  assert.equal(requestShow("a", "/tools/x", "", "MCP agent", undefined, now + POLL_TTL_MS + 1), null, "a tab that stopped polling (hidden) is not listening");
});

test("client ids are validated", () => {
  assert.ok(validClientId("sIvjJ0f-WDgfygJS"));
  assert.ok(!validClientId("short"));
  assert.ok(!validClientId("../../etc/passwd"));
});

test("showPath: registry slugs, tabs, retired slugs and deep links only", () => {
  assert.equal(showPath("cv-studio", "variants", { variant: "v1" }), "/tools/cv-studio?tab=variants&variant=v1");
  assert.equal(showPath("cv-studio", undefined, { job: "a b" }), "/tools/cv-studio?job=a+b");
  assert.equal(showPath("office"), "/tools/office");
  assert.equal(showPath("sql-format"), "/tools/sql-lab?tab=format", "a retired slug lands on its tab");
  assert.throws(() => showPath("cv-studio", "nope"), ShowPathError);
  assert.throws(() => showPath("../../etc"), ShowPathError);
  assert.throws(() => showPath("https://evil.example"), ShowPathError);
  assert.throws(() => showPath("office", "x"), /no tabs/);
});
