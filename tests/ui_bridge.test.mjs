// node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/ui_bridge.test.mjs
// The bridge between MCP agents outside the app and the user's open tabs: presence, targeting, path rules.
import assert from "node:assert/strict";
import { test } from "node:test";

const { reportPresence, openTabs, takePending, takePoll, requestShow, requestCall, answerCall, resetUiBridge, uiBridgeSize, PRESENCE_TTL_MS, POLL_TTL_MS, MAX_TABS, MAX_CALLS, MAX_CALL_ARGS_BYTES, MAX_CALL_RESULT_CHARS, validClientId } = await import("../src/lib/ui-bridge/store.ts");
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

test("bounded: polls with random client ids (no presence) are answered but never stored (audit L5 / abuse #11)", () => {
  resetUiBridge();
  for (let i = 0; i < 50_000; i += 1) assert.deepEqual(takePending("a", `random-${String(i).padStart(8, "0")}`, 1_000), []);
  assert.deepEqual(uiBridgeSize(), { accounts: 0, presence: 0, polls: 0, pending: 0, calls: 0 });
  assert.deepEqual(takePoll("a", "tab-one-0001", 1_000), { known: false, events: [] }, "unknown: the tab reports, then polls again");
  reportPresence("a", tab("tab-one-0001", "/tools/json"), 1_000);
  assert.deepEqual(takePoll("a", "tab-one-0001", 1_000), { known: true, events: [] });
  assert.equal(openTabs("a", 1_000)[0].connected, true, "a tab that reported is listening once it polls");
});

test("bounded: the MAX_TABS cap and the TTLs take polls and pending requests with the presence they belong to", () => {
  resetUiBridge();
  const now = 10_000;
  for (let i = 0; i < MAX_TABS + 20; i += 1) {
    const id = `tab-${String(i).padStart(8, "0")}`;
    reportPresence("a", tab(id, "/tools/json"), now + i);
    takePending("a", id, now + i);
    requestShow("a", "/tools/diff", "", "MCP agent", id, now + i);
  }
  const size = uiBridgeSize();
  assert.ok(size.presence <= MAX_TABS && size.polls <= MAX_TABS && size.pending <= MAX_TABS, JSON.stringify(size));
  assert.deepEqual(takePending("a", "tab-00000000", now + 100), [], "an evicted tab's pending request went with it");
  const later = now + PRESENCE_TTL_MS + POLL_TTL_MS + 1_000;
  assert.deepEqual(openTabs("a", later), []);
  assert.deepEqual(uiBridgeSize(), { accounts: 0, presence: 0, polls: 0, pending: 0, calls: 0 }, "everything expires, the empty account too");
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

/* ------------------------------------------------------------------------------------- knife_ui_call */

const DOC = ["doc_live_read", "doc_live_write"];
const visibleDocTab = (account, id, now, extra = {}) => {
  reportPresence(account, tab(id, "/tools/office?doc=d1", { tools: DOC, live: "Live editing CONNECTED", ...extra }), now);
  takePoll(account, id, now);
};

test("presence keeps only live tool names", () => {
  resetUiBridge();
  reportPresence("a", tab("tab-one-0001", "/tools/office", { tools: ["doc_live_read", "click", "craft_execute", "doc_live_read", "../x"], live: "x".repeat(500) }), 1_000);
  const [t] = openTabs("a", 1_000);
  assert.deepEqual(t.tools, ["doc_live_read", "craft_execute"]);
  assert.equal(t.live.length, 300);
});

test("requestCall: only a visible, listening tab that offers the tool; list_tools always", () => {
  resetUiBridge();
  const now = 50_000;
  assert.deepEqual(requestCall("a", { tool: "doc_live_read", args: {}, from: "MCP agent" }, now), { refused: "no_tab" });
  reportPresence("a", tab("tab-one-0001", "/tools/office", { tools: DOC }), now);
  assert.equal(requestCall("a", { tool: "doc_live_read", args: {}, from: "MCP agent" }, now).refused, "no_tab", "reported but not polling");
  reportPresence("a", tab("tab-one-0001", "/tools/office", { tools: DOC, visible: false }), now);
  takePoll("a", "tab-one-0001", now);
  assert.equal(requestCall("a", { tool: "doc_live_read", args: {}, from: "MCP agent" }, now).refused, "no_tab", "a hidden tab never runs a call");
  visibleDocTab("a", "tab-one-0001", now);
  const refused = requestCall("a", { tool: "craft_execute", args: {}, from: "MCP agent" }, now);
  assert.equal(refused.refused, "not_offered");
  assert.deepEqual(refused.tab.tools, DOC);
  assert.equal(requestCall("b", { tool: "doc_live_read", args: {}, from: "MCP agent" }, now).refused, "no_tab", "another account sees no tab");
  const listed = requestCall("a", { tool: "list_tools", args: {}, from: "MCP agent", timeoutMs: 1_000 }, now);
  assert.ok(listed.callId);
  resetUiBridge();
});

test("a call travels in the poll and only the account + tab it went to can answer it", async () => {
  resetUiBridge();
  const now = Date.now();
  visibleDocTab("a", "tab-one-0001", now);
  visibleDocTab("b", "tab-bbb-0001", now);
  const sent = requestCall("a", { tool: "doc_live_read", args: { what: "text" }, from: "MCP agent", timeoutMs: 5_000 }, now);
  assert.equal(sent.tab.clientId, "tab-one-0001");
  requestShow("a", "/tools/office", "", "MCP agent", undefined, now);
  const { events } = takePoll("a", "tab-one-0001", now + 100);
  const call = events.find((e) => e.kind === "call");
  assert.ok(call && events.some((e) => e.kind === "show"), "a show request does not drop a waiting call");
  assert.deepEqual([call.tool, call.args, call.target], ["doc_live_read", { what: "text" }, "tab-one-0001"]);
  assert.ok(call.ttlMs > 4_000 && call.ttlMs <= 4_900, String(call.ttlMs));
  const answer = { status: "done", ok: true, content: "y".repeat(MAX_CALL_RESULT_CHARS + 500) };
  assert.equal(answerCall("b", "tab-bbb-0001", call.callId, answer), false, "another account cannot answer it");
  assert.equal(answerCall("a", "tab-two-0002", call.callId, answer), false, "another tab of the account cannot either");
  assert.equal(answerCall("a", "tab-one-0001", "00000000-0000-4000-8000-000000000000", answer), false, "unknown id");
  assert.equal(answerCall("a", "tab-one-0001", call.callId, answer), true);
  assert.equal(answerCall("a", "tab-one-0001", call.callId, answer), false, "answered once");
  const outcome = await sent.outcome;
  assert.equal(outcome.status, "done");
  assert.equal(outcome.content.length, MAX_CALL_RESULT_CHARS, "an oversized answer is cut");
  assert.equal(uiBridgeSize().calls, 0);
  resetUiBridge();
});

test("timeout: says whether the tab picked the call up; a late answer is ignored", async () => {
  resetUiBridge();
  const now = Date.now();
  visibleDocTab("a", "tab-one-0001", now);
  const unseen = requestCall("a", { tool: "doc_live_read", args: {}, from: "MCP agent", timeoutMs: 30 }, now);
  assert.deepEqual(await unseen.outcome, { status: "timeout", pickedUp: false });
  assert.deepEqual(takePoll("a", "tab-one-0001", Date.now()).events, [], "an expired call leaves the tab's queue");
  const seen = requestCall("a", { tool: "doc_live_read", args: {}, from: "MCP agent", timeoutMs: 30 }, Date.now());
  const [call] = takePoll("a", "tab-one-0001", Date.now()).events;
  assert.deepEqual(await seen.outcome, { status: "timeout", pickedUp: true });
  assert.equal(answerCall("a", "tab-one-0001", call.callId, { status: "done", ok: true, content: "late" }), false);
  resetUiBridge();
});

test("bounded: MAX_CALLS in flight per account, argument size cap; a tab that goes away ends its calls", async () => {
  resetUiBridge();
  const now = Date.now();
  visibleDocTab("a", "tab-one-0001", now);
  const sent = [];
  for (let i = 0; i < MAX_CALLS; i += 1) sent.push(requestCall("a", { tool: "doc_live_read", args: {}, from: "MCP agent", timeoutMs: 60_000 }, now));
  assert.ok(sent.every((s) => s.callId));
  assert.deepEqual(requestCall("a", { tool: "doc_live_read", args: {}, from: "MCP agent" }, now), { refused: "too_many" });
  visibleDocTab("c", "tab-ccc-0001", now);
  assert.ok(requestCall("c", { tool: "doc_live_read", args: {}, from: "MCP agent", timeoutMs: 10 }, now).callId, "the cap is per account");
  const big = requestCall("c", { tool: "doc_live_write", args: { text: "x".repeat(MAX_CALL_ARGS_BYTES) }, from: "MCP agent" }, now);
  assert.equal(big.refused, "args_too_big");
  // the tab stops reporting and polling: pruned after its TTL, its calls end as "gone"
  openTabs("a", now + PRESENCE_TTL_MS + POLL_TTL_MS + 1_000);
  for (const s of sent) assert.deepEqual(await s.outcome, { status: "gone" });
  assert.equal(uiBridgeSize().calls <= 1, true, JSON.stringify(uiBridgeSize()));
  resetUiBridge();
  assert.deepEqual(uiBridgeSize(), { accounts: 0, presence: 0, polls: 0, pending: 0, calls: 0 });
});
