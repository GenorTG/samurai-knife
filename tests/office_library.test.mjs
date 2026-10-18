// Per-account storage (src/lib/storage): accountScope path rules, the quota (cache deltas, refusals, admins unlimited,
// retention of CV snapshots and conversation files) and the office library on top of it (src/lib/office/store.ts +
// folders.ts): folders, move, duplicate, trash/restore of documents and folder subtrees, versions (kept on every save,
// capped, restore, prune), the editor callback making room under the quota, knife_doc_* tools, two-account isolation.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/office_library.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-office-library-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_AUTH_MODE = "public";
process.env.KNIFE_EMAIL_DNS = "off"; // no real DNS in unit tests
process.env.KNIFE_HOST = "100.64.0.7";
process.env.KNIFE_PORT = "3210";
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const accounts = await import("../src/lib/accounts/store.ts");
const scope = await import("../src/lib/storage/scope.ts");
const quota = await import("../src/lib/storage/quota.ts");
const store = await import("../src/lib/office/store.ts");
const folders = await import("../src/lib/office/folders.ts");
const { buildDocument } = await import("../src/lib/office/templates.ts");
const { extractText } = await import("../src/lib/office/text.ts");
const { DOC_KNIFE_TOOLS } = await import("../src/lib/mcp/tools-docs.ts");
const cv = await import("../src/lib/cv/store.ts");
const { emptyCvData } = await import("../src/lib/cv/schema.ts");
const conversations = await import("../src/lib/agent-client/conversation-store.ts");
const data = await import("../src/lib/accounts/data.ts");

const MB = 1024 * 1024;

function addAccount(id, role, storageQuotaBytes) {
  accounts.mutateStore((s) => {
    s.accounts = s.accounts.filter((a) => a.id !== id);
    s.accounts.push(accounts.newAccountRecord({ id, displayName: id, role, status: "active", email: `${id}@example.test`, emailVerifiedAt: new Date().toISOString(), storageQuotaBytes }));
  });
  quota.invalidateUsage(id);
}

addAccount("alice", "user", 2 * MB);
addAccount("bob", "user", 2 * MB);
addAccount("root", "admin", null);

const docx = (text) => buildDocument("docx", { paragraphs: [text] });
const tool = (name) => DOC_KNIFE_TOOLS.find((t) => t.name === name);

test("accountScope: validated ids, every path inside its base, symlinked dirs refused", () => {
  const a = scope.accountScope("alice");
  assert.equal(a.docs, join(dataDir, "docs", "alice"));
  assert.equal(a.cv.photo, join(dataDir, "cv", "alice.photo.jpg"));
  assert.equal(a.learnFile, join(dataDir, "learn", "alice.json"));
  for (const bad of ["../x", "Alice", "a.b", "", "a/b", "x".repeat(40)]) assert.throws(() => scope.accountScope(bad), /invalid account id/, bad);
  for (const part of ["..", ".", "a/b", "a\\b", "x\u0000", ""]) assert.throws(() => a.join("docs", part), /invalid path segment/, JSON.stringify(part));
  assert.throws(() => scope.safeJoin("/tmp/base"), /escapes/);
  assert.equal(scope.safeJoin("/tmp/base", "a", "b"), "/tmp/base/a/b");
  mkdirSync(join(dataDir, "elsewhere"), { recursive: true });
  mkdirSync(join(dataDir, "docs"), { recursive: true });
  symlinkSync(join(dataDir, "elsewhere"), join(dataDir, "docs", "mallory"));
  addAccount("mallory", "user", 2 * MB);
  assert.throws(() => store.listDocs("mallory"), /symlink/);
});

test("quota: usage cached with exact deltas, a user is refused before writing, admins are unlimited", () => {
  const before = quota.storageUsage("alice");
  assert.equal(before.quotaBytes, 2 * MB);
  const doc = store.createDoc("alice", { name: "A", format: "docx", bytes: docx("hello"), source: "blank" });
  const after = quota.storageUsage("alice");
  assert.ok(after.usedBytes > before.usedBytes && after.areas.docs > 0, JSON.stringify(after));
  quota.invalidateUsage("alice");
  assert.equal(quota.storageUsage("alice").usedBytes, after.usedBytes, "the cached count equals a fresh walk");
  const big = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(3 * MB)]);
  assert.throws(() => store.createDoc("alice", { name: "Big", format: "docx", bytes: big, source: "upload" }), (error) => {
    assert.ok(error instanceof quota.QuotaExceededError);
    assert.equal(error.status, 507);
    assert.match(error.message, /Not enough storage: this needs 3\.0 MB but only .* of your 2\.0 MB is free/);
    return true;
  });
  assert.equal(store.listDocs("alice").length, 1, "nothing was written");
  const adminDoc = store.createDoc("root", { name: "Big", format: "docx", bytes: big, source: "upload" });
  assert.equal(quota.storageUsage("root").quotaBytes, null);
  store.deleteDoc("root", adminDoc.id);
  store.deleteDoc("alice", doc.id);
  assert.equal(quota.storageUsage("alice").usedBytes, before.usedBytes, "deleting frees exactly what was written");
});

test("folders: create, unique sibling names, rename, move (no cycles), documents move and duplicate", () => {
  const work = folders.createFolder("alice", "Work", null);
  const offers = folders.createFolder("alice", "Offers", work.id);
  assert.throws(() => folders.createFolder("alice", "work", null), /already exists/);
  assert.throws(() => folders.moveFolder("alice", work.id, offers.id), /into itself/);
  assert.throws(() => folders.createFolder("alice", "X", "0123456789abcdef"), /unknown folder/);
  assert.equal(folders.renameFolder("alice", offers.id, "Job offers").name, "Job offers");
  const doc = store.createDoc("alice", { name: "Letter", format: "docx", bytes: docx("dear"), source: "blank", folderId: offers.id });
  assert.equal(folders.folderPath(folders.readFolders("alice"), doc.folderId), "Work / Job offers");
  const moved = store.moveDoc("alice", doc.id, null);
  assert.equal(moved.folderId, null);
  const copy = store.duplicateDoc("alice", doc.id, work.id);
  assert.equal(copy.name, "Letter (copy).docx");
  assert.equal(copy.folderId, work.id);
  assert.equal(extractText("docx", store.readDocBytes("alice", copy)), "dear");
  assert.throws(() => folders.assertFolder("bob", work.id), /unknown folder/, "bob cannot see alice's folder");
  store.deleteDoc("alice", doc.id);
  store.deleteDoc("alice", copy.id);
  folders.trashFolder("alice", work.id);
  folders.emptyTrash("alice");
  assert.deepEqual(folders.readFolders("alice"), []);
});

test("trash: documents and whole folder subtrees, restore, delete forever, empty, live docs refused while trashed", () => {
  const top = folders.createFolder("alice", "Top", null);
  const sub = folders.createFolder("alice", "Sub", top.id);
  const inSub = store.createDoc("alice", { name: "Deep", format: "xlsx", bytes: buildDocument("xlsx"), source: "blank", folderId: sub.id });
  const loose = store.createDoc("alice", { name: "Loose", format: "docx", bytes: docx("x"), source: "blank" });
  store.trashDoc("alice", loose.id);
  assert.throws(() => store.getLiveDoc("alice", loose.id), /in the trash/);
  assert.equal(folders.trashFolder("alice", top.id).docs, 1);
  let lib = folders.readLibrary("alice");
  assert.deepEqual(lib.docs.map((d) => d.id), []);
  assert.deepEqual(lib.trash.folders.map((f) => f.id), [top.id], "only the folder the user trashed is listed");
  assert.deepEqual(lib.trash.docs.map((d) => d.id), [loose.id]);
  assert.throws(() => folders.restoreFolder("alice", sub.id), /with its parent/);
  assert.throws(() => folders.restoreDoc("alice", inSub.id), /with its folder/);
  folders.restoreFolder("alice", top.id);
  lib = folders.readLibrary("alice");
  assert.deepEqual(lib.folders.map((f) => f.id).sort(), [sub.id, top.id].sort());
  assert.equal(store.getDoc("alice", inSub.id).folderId, sub.id, "back where it was");
  assert.equal(folders.restoreDoc("alice", loose.id).trashedAt, undefined);
  folders.trashFolder("alice", top.id);
  const freed = folders.deleteFolderForever("alice", top.id);
  assert.equal(freed.docs, 1);
  assert.ok(!existsSync(join(dataDir, "docs", "alice", inSub.id)));
  store.trashDoc("alice", loose.id);
  assert.equal(folders.emptyTrash("alice").docs, 1);
  assert.deepEqual(folders.readLibrary("alice"), { folders: [], docs: [], trash: { folders: [], docs: [] } });
});

test("versions: every save keeps the previous bytes, capped at MAX_VERSIONS, restore is a new version, prune frees bytes", () => {
  const doc = store.createDoc("bob", { name: "Plan", format: "docx", bytes: docx("v1"), source: "blank" });
  for (let n = 2; n <= store.MAX_VERSIONS + 4; n += 1) store.saveVersion("bob", doc.id, docx(`v${n}`), { rotateKey: true, savedBy: "Bob", source: "editor" });
  let meta = store.getDoc("bob", doc.id);
  let kept = store.listVersions("bob", meta);
  assert.equal(meta.version, store.MAX_VERSIONS + 4);
  assert.equal(kept.length, store.MAX_VERSIONS);
  assert.equal(kept[0].version, 4, "oldest dropped first");
  assert.equal(kept.at(-1).savedBy, "Bob");
  assert.equal(extractText("docx", store.readVersionBytes("bob", meta, 10).bytes), "v10");
  meta = store.restoreVersion("bob", doc.id, 10, "Bob");
  assert.equal(extractText("docx", store.readDocBytes("bob", meta)), "v10");
  assert.equal(meta.versionSource, "restore");
  assert.equal(meta.restoredFrom, 10);
  assert.equal(store.listVersions("bob", meta).at(-1).version, store.MAX_VERSIONS + 4, "the replaced content is kept");
  const usage = quota.storageUsage("bob").usedBytes;
  const pruned = store.pruneVersions("bob", doc.id, 3);
  assert.equal(pruned.removed, store.MAX_VERSIONS - 3);
  assert.equal(store.listVersions("bob", pruned.doc).length, 3);
  assert.ok(quota.storageUsage("bob").usedBytes <= usage - pruned.freedBytes + 1024, "pruning frees quota");
  assert.throws(() => store.readVersionBytes("bob", pruned.doc, 5), /not kept/);
  assert.throws(() => store.getDoc("alice", doc.id), /unknown document/, "alice cannot reach bob's document");
  store.deleteDoc("bob", doc.id);
});

test("editor saves over the quota drop this document's oldest versions first, then refuse with a note on the document", () => {
  addAccount("carol", "user", 0);
  quota.invalidateUsage("carol");
  addAccount("carol", "user", 10 * MB);
  const pad = (n) => Buffer.concat([docx("x"), Buffer.alloc(n)]);
  const doc = store.createDoc("carol", { name: "Heavy", format: "docx", bytes: pad(3 * MB), source: "upload" });
  store.saveVersion("carol", doc.id, pad(3 * MB), { rotateKey: false });
  store.saveVersion("carol", doc.id, pad(3 * MB), { rotateKey: false });
  // 9 MB used (current + 2 versions); another 3 MB save needs room.
  assert.throws(() => store.saveVersion("carol", doc.id, pad(3 * MB), { rotateKey: false }), /Not enough storage/);
  const meta = store.saveVersion("carol", doc.id, pad(3 * MB), { rotateKey: false, makeRoom: true });
  assert.equal(meta.version, 4);
  assert.ok(quota.storageUsage("carol").usedBytes <= 10 * MB);
  assert.ok(store.listVersions("carol", meta).length >= 1);
  assert.throws(() => store.saveVersion("carol", doc.id, pad(12 * MB), { rotateKey: false, makeRoom: true }), /Not enough storage/);
  store.noteSaveError("carol", doc.id, "Storage full");
  assert.equal(store.getDoc("carol", doc.id).lastSaveError.message, "Storage full");
  store.saveVersion("carol", doc.id, pad(10), { rotateKey: false, makeRoom: true });
  assert.equal(store.getDoc("carol", doc.id).lastSaveError, undefined, "a successful save clears the note");
});

test("knife_doc_* tools: folders, move, versions, restore; scoped to the calling account", async () => {
  const folder = await tool("knife_doc_folder_create").execute({ name: "Agent" }, { accountId: "alice" });
  const created = await tool("knife_doc_create").execute({ format: "docx", name: "Draft", paragraphs: ["one"], folderId: folder.id }, { accountId: "alice" });
  store.saveVersion("alice", created.id, docx("two"), { rotateKey: true, source: "editor" });
  const listed = await tool("knife_doc_list").execute({ folderId: folder.id }, { accountId: "alice" });
  assert.deepEqual(listed.docs.map((d) => [d.name, d.folder, d.version, d.keptVersions]), [["Draft.docx", "Agent", 2, 1]]);
  const versions = await tool("knife_doc_versions").execute({ id: created.id }, { accountId: "alice" });
  assert.equal(versions.current.version, 2);
  assert.equal(versions.kept[0].version, 1);
  const old = await tool("knife_doc_read").execute({ id: created.id, version: 1 }, { accountId: "alice" });
  assert.equal(old.text, "one");
  const restored = await tool("knife_doc_restore_version").execute({ id: created.id, version: 1 }, { accountId: "alice" });
  assert.equal(restored.version, 3);
  const moved = await tool("knife_doc_move").execute({ id: created.id, folderId: null }, { accountId: "alice" });
  assert.equal(moved.folder, "/");
  // Bob sees nothing of Alice's, by id or by listing.
  const bobList = await tool("knife_doc_list").execute({}, { accountId: "bob" });
  assert.ok(!bobList.docs.some((d) => d.id === created.id) && !bobList.folders.some((f) => f.id === folder.id));
  for (const [name, args] of [
    ["knife_doc_read", { id: created.id }],
    ["knife_doc_versions", { id: created.id }],
    ["knife_doc_restore_version", { id: created.id, version: 1 }],
    ["knife_doc_move", { id: created.id, folderId: null }],
    ["knife_doc_create", { format: "docx", name: "x", folderId: folder.id }],
    ["knife_doc_folder_create", { name: "x", parentId: folder.id }],
  ]) {
    await assert.rejects(() => tool(name).execute(args, { accountId: "bob" }), /unknown (document|folder)/, name);
  }
  store.deleteDoc("alice", created.id);
});

test("retention: CV snapshots by count and bytes, 5 conversation files per account", () => {
  addAccount("dave", "user", 50 * MB);
  let data_ = emptyCvData();
  for (let n = 0; n < 45; n += 1) data_ = cv.saveCv("dave", { ...data_, profile: { ...data_.profile } });
  assert.equal(readdirSync(join(dataDir, "cv", "dave.snapshots")).length, 40);
  for (let n = 0; n < 8; n += 1) conversations.readConversation("dave", conversations.providerConversationId("http://x/v1", `model-${n}`));
  assert.equal(readdirSync(join(dataDir, "conversations", "dave")).length, conversations.KEEP_CONVERSATIONS);
  quota.invalidateUsage("dave");
  const walked = quota.storageUsage("dave");
  assert.ok(walked.areas.cv > 0 && walked.areas.conversations > 0);
  assert.equal(data.accountStorageBytes("dave"), walked.usedBytes);
  data.deleteAccountData("dave");
  assert.equal(quota.storageUsage("dave").usedBytes, 0);
});
