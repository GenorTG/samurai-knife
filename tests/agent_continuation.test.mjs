// OpenClaw Responses continuation: the server-owned state machine, the shared provider rule, and the browser delta.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-agent-continuation-"));
process.env.KNIFE_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import("../src/lib/agent-client/conversation-store.ts");
const { openClawResponsesProblem, isOpenClawAgentModel } = await import("../src/lib/accounts/openclaw-target.ts");
const { continuationDelta } = await import("../src/lib/agent-client/loop.ts");

let n = 0;
const fresh = () => store.providerConversationId("http://gw/v1", `openclaw/agent${(n += 1)}`);

test("a seed always runs in a fresh gateway session", () => {
  const pid = fresh();
  const initial = store.readConversation("genor", pid).sessionId;
  const seed = store.beginResponsesRound("genor", pid, null, []);
  assert.equal(seed.ok, true);
  assert.notEqual(seed.sessionId, initial, "full history never goes into a session that may already hold it");
  store.commitResponsesRound("genor", pid, seed.sessionId, "resp_1", []);
  const reseed = store.beginResponsesRound("genor", pid, null, []);
  assert.notEqual(reseed.sessionId, seed.sessionId);
  assert.equal(store.readConversation("genor", pid).responseId, null, "a reseed forgets the old head");
});

test("a delta chains only from the stored head and keeps the session", () => {
  const pid = fresh();
  const seed = store.beginResponsesRound("genor", pid, null, []);
  store.commitResponsesRound("genor", pid, seed.sessionId, "resp_1", []);
  assert.deepEqual(store.beginResponsesRound("genor", pid, "resp_1", []), { ok: true, sessionId: seed.sessionId, previousResponseId: "resp_1" });
  assert.deepEqual(store.beginResponsesRound("genor", pid, "resp_stale", []), { ok: false }, "a head the server did not issue is lost");
  assert.equal(store.readConversation("genor", pid).responseId, null, "and the chain is broken for good");
  assert.deepEqual(store.beginResponsesRound("genor", pid, "resp_1", []), { ok: false });
});

test("a delta must answer every function call the head left pending", () => {
  const pid = fresh();
  const seed = store.beginResponsesRound("genor", pid, null, []);
  store.commitResponsesRound("genor", pid, seed.sessionId, "resp_1", ["call_a", "call_b"]);
  assert.deepEqual(store.beginResponsesRound("genor", pid, "resp_1", ["call_a", "call_b"]).ok, true);
  store.commitResponsesRound("genor", pid, seed.sessionId, "resp_2", ["call_c"]);
  assert.deepEqual(store.beginResponsesRound("genor", pid, "resp_2", []), { ok: false }, "a dropped result breaks the chain");
});

test("commits are dropped after the session rotated; breaks respect the session", () => {
  const pid = fresh();
  const old = store.beginResponsesRound("genor", pid, null, []);
  store.resetConversation("genor", pid); // Clear while the round ran
  store.commitResponsesRound("genor", pid, old.sessionId, "resp_late", []);
  assert.equal(store.readConversation("genor", pid).responseId, null, "a late commit cannot revive a cleared conversation");

  const seed = store.beginResponsesRound("genor", pid, null, []);
  store.commitResponsesRound("genor", pid, seed.sessionId, "resp_1", []);
  store.breakContinuation("genor", pid, old.sessionId);
  assert.equal(store.readConversation("genor", pid).responseId, "resp_1", "a failure from an old session does not touch the new chain");
  store.breakContinuation("genor", pid, seed.sessionId);
  assert.equal(store.readConversation("genor", pid).responseId, null);
  store.commitResponsesRound("genor", pid, seed.sessionId, "resp_2", []);
  store.breakContinuation("genor", pid); // Responses mode switched off
  assert.equal(store.readConversation("genor", pid).responseId, null);
});

test("saving the transcript never rolls back the continuation", () => {
  const pid = fresh();
  const seed = store.beginResponsesRound("genor", pid, null, []);
  store.commitResponsesRound("genor", pid, seed.sessionId, "resp_9", ["call_x"]);
  store.saveConversationContent("genor", pid, { version: 1, messages: [{ role: "user", content: "hi" }], actions: ["/tools/qr: Open QR"] });
  const after = store.readConversation("genor", pid);
  assert.equal(after.responseId, "resp_9");
  assert.deepEqual(after.pendingCallIds, ["call_x"]);
  assert.equal(after.sessionId, seed.sessionId);
  assert.equal(after.messages.length, 1);
});

test("files written before pendingCallIds existed still load", () => {
  const pid = fresh();
  const legacy = { version: 1, messages: [], actions: [], responseId: "resp_old", sessionId: "6f2c3a3e-8d0e-4a8b-9a51-0d7c2b9b4e11" };
  store.writeConversation("genor", pid, legacy);
  assert.deepEqual(store.readConversation("genor", pid).pendingCallIds, []);
});

test("the Responses provider rule mirrors the gateway's agent-model syntax", () => {
  for (const model of ["openclaw", "OpenClaw/default", "openclaw/knife-test", "openclaw:knife_test", "agent:main"]) {
    assert.equal(isOpenClawAgentModel(model), true, model);
  }
  for (const model of ["gpt-4o-mini", "openclaw/", "openclaw/Bad Agent", "openai/gpt-6-luna", "openclaw/-x"]) {
    assert.equal(isOpenClawAgentModel(model), false, model);
  }
  assert.equal(openClawResponsesProblem("http://127.0.0.1:18789/v1", "openclaw/knife-test"), null);
  assert.equal(openClawResponsesProblem("http://127.0.0.1:18789/v1/", "openclaw/knife-test"), null);
  assert.match(openClawResponsesProblem("http://127.0.0.1:18789", "openclaw/knife-test") ?? "", /\/v1/);
  assert.match(openClawResponsesProblem("http://127.0.0.1:18789/v1", "gpt-4o") ?? "", /agent target/);
});

test("the delta is everything after the last assistant message, repaired, without notices", () => {
  const call = (id) => ({ id, type: "function", function: { name: "open_tool", arguments: "{}" } });
  assert.deepEqual(continuationDelta([{ role: "user", content: "first" }]), [{ role: "user", content: "first" }]);
  const afterTools = continuationDelta([
    { role: "user", content: "go" },
    { role: "assistant", content: null, tool_calls: [call("c1"), call("c2")] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
    { role: "notice", level: "info", content: "Stopped." },
    { role: "user", content: "next" },
  ]);
  assert.deepEqual(afterTools.map((m) => m.role === "tool" ? `tool:${m.tool_call_id}` : m.role), ["tool:c1", "tool:c2", "user"],
    "a call left unanswered by Stop is answered as interrupted, so the gateway gets a result for every call");
  assert.deepEqual(continuationDelta([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]), []);
});
