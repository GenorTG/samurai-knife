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
    get length() {
      return storage.size;
    },
    key: (i) => [...storage.keys()][i] ?? null,
  },
  addEventListener() {},
  removeEventListener() {},
};

const { providerConversationId, noteUntrusted, readConversation } = await import("../src/lib/agent-client/conversation-store.ts");
const queue = await import("../src/lib/agent-client/message-queue.ts");
const { runtime, runtimeFor, setForegroundChat, foregroundChat, runningChats } = await import("../src/lib/agent-client/runtime-store.ts");
const {
  answerApproval,
  answerForeground,
  answerWait,
  chatsNeedingUser,
  requestForeground,
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
  assert.deepEqual(runtimeFor("chat_one").get().queue.map((item) => item.text), ["only one"]);

  queue.attachQueue("acct", "chat_two");
  assert.deepEqual(runtimeFor("chat_two").get().queue, []);
  queue.enqueue("only two", "chat_two");
  assert.deepEqual(runtimeFor("chat_two").get().queue.map((item) => item.text), ["only two"]);
  assert.deepEqual(runtimeFor("chat_one").get().queue.map((item) => item.text), ["only one"], "a queue edit of one chat never touches another's");
  assert.equal(queue.nextQueued("chat_one").text, "only one");
  queue.pauseQueue("stopped", "chat_one");
  assert.equal(queue.nextQueued("chat_one"), null, "a paused queue does not drain by itself");

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
  const one = runtimeFor("chat_one");
  one.begin();
  one.advance("thinking");
  one.advance("tool");
  const approval = requestApproval({ title: "Allow action?", detail: "Chat one only" }, undefined, "chat_one");
  assert.equal(one.get().run, "awaiting_approval");
  assert.equal(runtimeFor("chat_two").get().run, "idle", "parking one chat leaves the other alone");
  assert.equal(getInteraction("chat_one").approval?.detail, "Chat one only");
  assert.equal(getInteraction("chat_two").approval, null);
  assert.deepEqual(chatsNeedingUser(["chat_one", "chat_two"]), ["chat_one"]);
  answerApproval("allow", "chat_two");
  answerApproval("deny", "chat_one");
  assert.equal(await approval, "deny");
  one.advance("thinking");
  one.advance("tool");

  const waiting = requestWait({ message: "Waiting in chat one", targetId: null }, undefined, "chat_one");
  assert.equal(getInteraction("chat_one").wait?.message, "Waiting in chat one");
  assert.equal(getInteraction("chat_two").wait, null);
  answerWait("continue", undefined, "chat_two");
  answerWait("continue", undefined, "chat_one");
  assert.equal((await waiting).resumedBy, "continue");
  assert.equal(getInteraction("chat_one").wait, null);
  one.end();
});

test("concurrent chats: one store per chat, the shell follows the foreground chat", () => {
  const a = runtimeFor("bg_a");
  const b = runtimeFor("bg_b");
  setForegroundChat("bg_a");
  a.begin();
  a.advance("thinking");
  a.setActivity("Thinking in A");
  b.begin();
  b.advance("thinking");
  b.advance("tool");
  b.setActivity("Tool in B");
  assert.deepEqual(runningChats().sort(), ["bg_a", "bg_b"]);
  assert.equal(foregroundChat(), "bg_a");
  assert.equal(runtime.get().activity, "Thinking in A", "the shell reads the foreground chat");
  setForegroundChat("bg_b");
  assert.equal(runtime.get().activity, "Tool in B");
  a.end();
  b.end();
  assert.deepEqual(runningChats(), []);
});

test("a background chat's page step waits for the user: open or skip, stop cancels", async () => {
  const c = runtimeFor("bg_page");
  c.begin();
  c.advance("thinking");
  c.advance("tool");
  const asked = requestForeground({ tool: "open_tool", label: "Open QR code" }, undefined, "bg_page");
  assert.equal(c.get().run, "awaiting_user");
  assert.equal(getInteraction("bg_page").page?.label, "Open QR code");
  assert.deepEqual(chatsNeedingUser(["bg_page", "bg_a"]), ["bg_page"]);
  answerForeground("open", "bg_page");
  assert.equal(await asked, "open");
  assert.equal(c.get().run, "tool");
  assert.equal(getInteraction("bg_page").page, null);
  const skipped = requestForeground({ tool: "click", label: "Click Download" }, undefined, "bg_page");
  answerForeground("skip", "bg_page");
  assert.equal(await skipped, "skip");
  const stop = new AbortController();
  const aborted = requestForeground({ tool: "click", label: "Click" }, stop.signal, "bg_page");
  stop.abort();
  assert.equal(await aborted, "aborted");
  c.end();
});

test("page tools: everything that reads or drives the page needs the foreground", async () => {
  const { needsPage } = await import("../src/lib/agent-client/loop.ts");
  for (const name of ["open_tool", "page_snapshot", "fill_field", "click", "upload_file", "read_text", "wait_for", "wait_for_user"]) assert.equal(needsPage(name), true, name);
  for (const name of ["list_tools", "wait", "knife_site_audit", "knife_goal_list"]) assert.equal(needsPage(name), false, name);
});

test("the running-chat cap counts this account's running chats across tabs (Web Locks and the lease fallback)", async () => {
  if (locks.lockBackend() === "web-locks") {
    const x = await locks.tryAcquireRun("capacct", "chat_x");
    const d = await locks.tryAcquireRun("capacct", "default");
    const other = await locks.tryAcquireRun("capacct2", "chat_z");
    assert.equal(await locks.runningChatCount("capacct"), 2, "another account's lock does not count");
    x.release();
    d.release();
    other.release();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(await locks.runningChatCount("capacct"), 0);
  }
  // The lease fallback (plain-HTTP origins have no navigator.locks).
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
  try {
    assert.equal(locks.lockBackend(), "lease");
    const lease = await locks.tryAcquireRun("capacct", "chat_x");
    storage.set("sk.agent.lease.v1.capacct", JSON.stringify({ tab: "other", at: Date.now() }));
    storage.set("sk.agent.lease.v1.capacct-chat_y", JSON.stringify({ tab: "other", at: Date.now() - 60_000 }));
    storage.set("sk.agent.lease.v1.capacct2-chat_z", JSON.stringify({ tab: "other", at: Date.now() }));
    assert.equal(await locks.runningChatCount("capacct"), 2, "a stale lease and another account's lease do not count");
    lease.release();
    assert.equal(await locks.runningChatCount("capacct"), 1);
  } finally {
    if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
  }
});
