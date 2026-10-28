// Durable assistant conversations are isolated by account/provider, sealed at rest, and reset by Clear.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-agent-conversation-"));
process.env.KNIFE_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { providerConversationId, readConversation, resetConversation, writeConversation } = await import("../src/lib/agent-client/conversation-store.ts");
const { readAccountText } = await import("../src/lib/storage/sealed.ts");
const { writeAccountFile } = await import("../src/lib/storage/quota.ts");

test("conversation state is scoped per account and provider, sealed at rest, and Clear empties it", () => {
  const providerId = providerConversationId("http://gateway/v1", "model-a");
  const otherProviderId = providerConversationId("http://gateway/v1", "model-b");
  const otherChatId = providerConversationId("http://gateway/v1", "model-a", "chat_other");
  assert.notEqual(providerId, otherChatId, "each chat has a distinct durable store and taint scope");
  const initial = readConversation("genor", providerId);
  writeConversation("genor", providerId, {
    ...initial,
    messages: [{ role: "user", content: "continue this work" }],
    actions: ["/tools/text: Open text"],
  });

  assert.equal(readConversation("genor", providerId).messages.length, 1);
  assert.equal(readConversation("alice", providerId).messages.length, 0);
  assert.equal(readConversation("genor", otherProviderId).messages.length, 0);
  const path = join(dataDir, "conversations", "genor", providerId + ".json");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(path, "latin1"), /continue this work/, "sealed at rest");
  assert.match(readAccountText("genor", path), /continue this work/);

  resetConversation("genor", providerId);
  const reset = readConversation("genor", providerId);
  assert.deepEqual(reset.messages, []);
  assert.deepEqual(reset.actions, []);
});

test("a file written with the removed Responses continuation fields still loads, and the next write drops them", () => {
  const providerId = providerConversationId("http://gateway/v1", "openclaw/agent");
  readConversation("old", providerId); // creates the account's conversation folder
  const path = join(dataDir, "conversations", "old", providerId + ".json");
  writeAccountFile("old", path, JSON.stringify({
    version: 1,
    messages: [{ role: "user", content: "from before" }],
    actions: [],
    responseId: "resp_9",
    sessionId: "6f1c1a3e-2b9b-4c3e-9a51-0e0b8c7d9f10",
    pendingCallIds: ["call_1"],
    untrusted: true,
  }) + "\n");
  const loaded = readConversation("old", providerId);
  assert.equal(loaded.messages[0].content, "from before");
  assert.equal(loaded.untrusted, true);
  assert.equal("responseId" in loaded || "sessionId" in loaded || "pendingCallIds" in loaded, false, "stripped on read");
  writeConversation("old", providerId, loaded);
  assert.doesNotMatch(readAccountText("old", path), /responseId|sessionId|pendingCallIds/);
});

test("untrusted taint is server-owned and sticky: kept across turns and transcript saves, cleared only by Clear", async () => {
  const { noteUntrusted, saveConversationContent } = await import("../src/lib/agent-client/conversation-store.ts");
  const providerId = providerConversationId("https://api.example/v1", "taint-model");
  assert.equal(noteUntrusted("taint", providerId, false), false, "a fresh conversation is clean");
  assert.equal(noteUntrusted("taint", providerId, true), true);
  assert.equal(noteUntrusted("taint", providerId, false), true, "the next turn ('continue') still knows");
  saveConversationContent("taint", providerId, { version: 1, messages: [{ role: "user", content: "continue" }], actions: [] });
  assert.equal(readConversation("taint", providerId).untrusted, true, "a browser PUT never clears it");
  resetConversation("taint", providerId);
  assert.equal(noteUntrusted("taint", providerId, false), false, "Clear starts clean");
});
