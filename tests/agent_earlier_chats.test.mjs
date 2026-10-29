// Server-side recovery of provider-scoped chats (files written before 0.13.0.22 under providerConversationId): a chat whose
// own file is missing/empty adopts the newest matching file of the account's providers (transcript, journal, taint);
// the rest is listed under "Recover earlier chats" and can be opened as a new chat. Own account only.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-earlier-chats-"));
process.env.KNIFE_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import("../src/lib/agent-client/conversation-store.ts");
const { providerConversationId, chatConversationId, writeConversation, readConversation, openChatConversation, listEarlierChats, importEarlierChat, resetConversation, saveConversationContent, noteUntrusted, EarlierChatError } = store;

const A = { baseUrl: "http://gateway/v1", model: "model-a" };
const B = { baseUrl: "https://api.anthropic.com/v1", model: "claude-x" };
const transcript = (text) => [{ role: "user", content: text }, { role: "assistant", content: `answer to ${text}` }];
const fileOf = (account, id) => join(dataDir, "conversations", account, `${id}.json`);

function legacy(account, source, chatId, text, ageSeconds, untrusted = false) {
  const id = providerConversationId(source.baseUrl, source.model, chatId);
  writeConversation(account, id, { version: 1, messages: transcript(text), actions: [`/tools/x: ${text}`], untrusted });
  const at = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(fileOf(account, id), at, at);
  return id;
}

test("a chat adopts the newest provider-scoped copy of itself, journal and taint included, once", () => {
  const older = legacy("genor", A, "default", "old gateway chat", 600);
  const newer = legacy("genor", B, "default", "claude chat", 60, true);
  // The empty file a 0.13.0.22 GET created for the new scope does not block the recovery.
  writeConversation("genor", chatConversationId("default"), { version: 1, messages: [], actions: [] });
  const opened = openChatConversation("genor", "default", [A, B]);
  assert.equal(opened.messages[0].content, "claude chat", "newest non-empty copy wins");
  assert.deepEqual(opened.actions, ["/tools/x: claude chat"]);
  assert.equal(opened.untrusted, true, "taint follows the adopted transcript");
  assert.equal(opened.adoptedFrom, newer);
  const legacyFile = readConversation("genor", newer);
  assert.equal(legacyFile.adoptedInto, chatConversationId("default"), "kept and marked");
  assert.ok(statSync(fileOf("genor", newer)).mtimeMs < Date.now() - 30_000, "its age (eviction order) is unchanged");
  // Taint is still owned by the server after adoption: a later round cannot clear it.
  assert.equal(noteUntrusted("genor", chatConversationId("default"), false), true);
  // Listed: only the one nobody took (the older gateway chat), with model, host and preview.
  const earlier = listEarlierChats("genor", [A, B], ["default"]);
  assert.deepEqual(earlier.map((e) => e.file), [older]);
  assert.equal(earlier[0].model, "model-a");
  assert.equal(earlier[0].host, "gateway");
  assert.equal(earlier[0].chatId, "default");
  assert.equal(earlier[0].messages, 2);
  assert.equal(earlier[0].preview, "old gateway chat");
});

test("Clear never re-adopts; a chat with its own transcript is left alone", () => {
  legacy("genor", A, "c2", "second chat", 120);
  saveConversationContent("genor", chatConversationId("c2"), { version: 1, messages: transcript("new talk"), actions: [] }, "c2");
  assert.equal(openChatConversation("genor", "c2", [A]).messages[0].content, "new talk");
  assert.ok(listEarlierChats("genor", [A], ["default", "c2"]).some((e) => e.preview === "second chat"), "the older copy is offered instead");

  legacy("genor", A, "c3", "third chat", 120);
  resetConversation("genor", chatConversationId("c3"), "c3");
  assert.deepEqual(openChatConversation("genor", "c3", [A]).messages, [], "a cleared chat stays empty");
});

test("Open as a new chat imports an earlier transcript with its taint, once, into an empty chat only", () => {
  const id = legacy("bob", A, "old_chat", "tainted earlier chat", 300, true);
  const [entry] = listEarlierChats("bob", [A], []);
  assert.equal(entry.file, id);
  assert.equal(entry.chatId, null, "an unknown chat id is not guessed");
  assert.equal(entry.untrusted, true);
  saveConversationContent("bob", chatConversationId("busy"), { version: 1, messages: transcript("x"), actions: [] }, "busy");
  assert.throws(() => importEarlierChat("bob", id, "busy"), (e) => e instanceof EarlierChatError && e.code === "chat_not_empty");
  const imported = importEarlierChat("bob", id, "restored_1");
  assert.equal(imported.untrusted, true);
  assert.equal(openChatConversation("bob", "restored_1", [A]).messages[0].content, "tainted earlier chat");
  assert.deepEqual(listEarlierChats("bob", [A], ["restored_1"]), [], "gone from the list");
  assert.throws(() => importEarlierChat("bob", id, "restored_2"), (e) => e instanceof EarlierChatError && e.code === "not_found", "only once");
});

test("another account's files are invisible", () => {
  const id = legacy("carol", A, "carol_only", "carol chat", 30);
  assert.ok(!listEarlierChats("genor", [A], []).some((e) => e.file === id));
  assert.throws(() => importEarlierChat("genor", id, "steal"), (e) => e instanceof EarlierChatError);
  assert.deepEqual(readConversation("genor", chatConversationId("steal")).messages, []);
});
