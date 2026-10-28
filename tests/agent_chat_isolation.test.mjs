import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-agent-chat-isolation-"));
process.env.KNIFE_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  addEventListener() {},
  removeEventListener() {},
};

const { providerConversationId, noteUntrusted, readConversation } = await import("../src/lib/agent-client/conversation-store.ts");
const queue = await import("../src/lib/agent-client/message-queue.ts");
const { runtime } = await import("../src/lib/agent-client/runtime-store.ts");
const {
  answerApproval,
  answerWait,
  getInteraction,
  getTrustMode,
  requestApproval,
  requestWait,
  setTrustMode,
} = await import("../src/lib/agent-client/interaction.ts");
const locks = await import("../src/lib/agent-client/run-lock.ts");

test("server conversation and sticky taint are isolated by chat while the legacy default id remains stable", () => {
  const legacy = providerConversationId("https://provider.example/v1", "model");
  assert.equal(legacy, providerConversationId("https://provider.example/v1", "model", "default"));
  const one = providerConversationId("https://provider.example/v1", "model", "chat_one");
  const two = providerConversationId("https://provider.example/v1", "model", "chat_two");
  assert.notEqual(one, two);
  assert.equal(noteUntrusted("acct", one, true), true);
  assert.equal(readConversation("acct", two).untrusted, false);
  assert.equal(noteUntrusted("acct", two, false), false);
});

test("queued messages and trust preferences are per chat", () => {
  queue.attachQueue("acct", "chat_one");
  queue.enqueue("only one", "chat_one");
  assert.deepEqual(runtime.get().queue.map((item) => item.text), ["only one"]);

  queue.attachQueue("acct", "chat_two");
  assert.deepEqual(runtime.get().queue, []);
  queue.enqueue("only two", "chat_two");
  assert.deepEqual(runtime.get().queue.map((item) => item.text), ["only two"]);

  setTrustMode("strict", "chat_one");
  assert.equal(getTrustMode("chat_one"), "strict");
  assert.equal(getTrustMode("chat_two"), "destructive");
  queue.clearQueue("chat_one");
  queue.clearQueue("chat_two");
  queue.attachQueue(null, "chat_two");
});

test("a lock for one chat does not make another chat appear busy", async () => {
  const lease = await locks.tryAcquireRun("acct", "chat_one");
  assert.ok(lease);
  const key = "sk.agent.lease.v1.acct-chat_one";
  storage.set(key, JSON.stringify({ tab: "another-tab", at: Date.now() }));
  assert.equal(await locks.runHeldElsewhere("acct", "chat_one"), true);
  assert.equal(await locks.runHeldElsewhere("acct", "chat_two"), false);
  lease.release();
  storage.delete(key);
});

test("approval and wait cards and answers are isolated by chat", async () => {
  runtime.begin();
  runtime.advance("thinking");
  runtime.advance("tool");
  const approval = requestApproval({ title: "Allow action?", detail: "Chat one only" }, undefined, "chat_one");
  assert.equal(getInteraction("chat_one").approval?.detail, "Chat one only");
  assert.equal(getInteraction("chat_two").approval, null);
  answerApproval("allow", "chat_two");
  answerApproval("deny", "chat_one");
  assert.equal(await approval, "deny");
  runtime.advance("thinking");
  runtime.advance("tool");

  const waiting = requestWait({ message: "Waiting in chat one", targetId: null }, undefined, "chat_one");
  assert.equal(getInteraction("chat_one").wait?.message, "Waiting in chat one");
  assert.equal(getInteraction("chat_two").wait, null);
  answerWait("continue", undefined, "chat_two");
  answerWait("continue", undefined, "chat_one");
  assert.equal((await waiting).resumedBy, "continue");
  runtime.end();
});
