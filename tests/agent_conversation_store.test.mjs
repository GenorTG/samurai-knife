// Durable assistant conversations are isolated by account/provider and reset to a fresh gateway thread.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-agent-conversation-"));
process.env.KNIFE_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { openClawUser, providerConversationId, readConversation, resetConversation, writeConversation } = await import("../src/lib/agent-client/conversation-store.ts");

test("conversation state is scoped per account and provider and reset rotates the OpenClaw thread", () => {
  const providerId = providerConversationId("http://gateway/v1", "openclaw/agent");
  const otherProviderId = providerConversationId("http://gateway/v1", "openclaw/other-agent");
  const initial = readConversation("genor", providerId);
  assert.equal(readConversation("genor", providerId).sessionId, initial.sessionId, "an empty provider scope retains its first session ID");
  const openClawUserId = openClawUser("genor", providerId, initial.sessionId);
  assert.equal(openClawUserId, openClawUser("genor", providerId, initial.sessionId));
  assert.notEqual(openClawUserId, openClawUser("genor", otherProviderId, initial.sessionId));
  writeConversation("genor", providerId, {
    ...initial,
    messages: [{ role: "user", content: "continue this work" }],
    actions: ["/tools/text: Open text"],
    responseId: "resp_1",
  });

  assert.equal(readConversation("genor", providerId).messages.length, 1);
  assert.equal(readConversation("alice", providerId).messages.length, 0);
  assert.equal(readConversation("genor", otherProviderId).messages.length, 0);
  const path = join(dataDir, "conversations", "genor", providerId + ".json");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.match(readFileSync(path, "utf8"), /continue this work/);

  resetConversation("genor", providerId);
  const reset = readConversation("genor", providerId);
  assert.deepEqual(reset.messages, []);
  assert.deepEqual(reset.actions, []);
  assert.equal(reset.responseId, null);
  assert.notEqual(reset.sessionId, initial.sessionId);
  assert.notEqual(openClawUserId, openClawUser("genor", providerId, reset.sessionId));
});
