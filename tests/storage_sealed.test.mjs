// Per-account files at rest (src/lib/storage/sealed.ts): every store that writes through writeAccountFile (CV + snapshots +
// photo, office documents/meta/versions/folders, conversations, course progress, usage ledger, tool drafts) leaves only
// sealed bytes on disk; a file moved into another account does not open; plaintext written before sealing still reads and
// is sealed by its next write; KNIFE_STORAGE_KEY_FILE keeps the key outside the data dir.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/storage_sealed.test.mjs
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-sealed-"));
const keyDir = mkdtempSync(join(tmpdir(), "knife-sealed-key-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_STORAGE_KEY_FILE = join(keyDir, "storage.key");
test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(keyDir, { recursive: true, force: true });
});

const sealed = await import("../src/lib/storage/sealed.ts");
const quota = await import("../src/lib/storage/quota.ts");
const { accountScope } = await import("../src/lib/storage/scope.ts");
const cv = await import("../src/lib/cv/store.ts");
const { emptyCvData } = await import("../src/lib/cv/schema.ts");
const photo = await import("../src/lib/cv/photo-store.ts");
const office = await import("../src/lib/office/store.ts");
const folders = await import("../src/lib/office/folders.ts");
const { buildDocument } = await import("../src/lib/office/templates.ts");
const conversations = await import("../src/lib/agent-client/conversation-store.ts");
const progress = await import("../src/lib/learn/progress.ts");
const ledger = await import("../src/lib/accounts/usage-ledger.ts");
const workspace = await import("../src/lib/workspace-state/store.ts");

const MARKER = "marker-7f3a-plaintext";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(MARKER), Buffer.from([0xff, 0xd9])]);

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

test("the key lives at KNIFE_STORAGE_KEY_FILE (0600), not in the data dir", () => {
  quota.writeAccountFile("keyuser", accountScope("keyuser").workspaceFile, "{}");
  assert.ok(existsSync(process.env.KNIFE_STORAGE_KEY_FILE));
  assert.equal(statSync(process.env.KNIFE_STORAGE_KEY_FILE).mode & 0o777, 0o600);
  assert.equal(existsSync(join(dataDir, "storage.key")), false);
});

test("every account store leaves only sealed bytes on disk and reads back", () => {
  const profile = emptyCvData();
  profile.profile.contact.name = MARKER;
  cv.saveCv("alice", profile);
  cv.saveCv("alice", profile); // second save writes a snapshot of the first
  photo.savePhoto("alice", JPEG);
  const folder = folders.createFolder("alice", MARKER, null);
  const doc = office.createDoc("alice", { name: MARKER, format: "docx", bytes: buildDocument("docx"), source: "blank", folderId: folder.id });
  office.saveVersion("alice", doc.id, buildDocument("docx"), { rotateKey: true }); // the first bytes become a kept version
  const providerId = conversations.providerConversationId("http://mock/v1", "mock-model");
  const initial = conversations.readConversation("alice", providerId);
  conversations.writeConversation("alice", providerId, { ...initial, messages: [{ role: "user", content: MARKER }] });
  progress.updateLesson("alice", "sql", "select-all", (p) => ({ ...p, lastQuery: MARKER }));
  ledger.recordRound("alice", { model: MARKER, usage: null, ms: 5, failed: false });
  workspace.saveWorkspaceTool("alice", "text", { "textarea::input:0": MARKER });

  const files = filesUnder(dataDir).filter((path) => !path.endsWith("accounts.json"));
  assert.ok(files.length >= 9, `expected every store to have written (${files.length} files)`);
  for (const path of files) {
    const bytes = readFileSync(path);
    assert.ok(sealed.isSealedBytes(bytes), `${path} is sealed`);
    assert.equal(bytes.includes(Buffer.from(MARKER)), false, `${path} carries no plaintext`);
    assert.equal(statSync(path).mode & 0o777, 0o600, `${path} is private`);
  }

  assert.equal(cv.loadCv("alice").profile.contact.name, MARKER);
  assert.deepEqual(photo.readPhoto("alice"), JPEG);
  assert.equal(photo.photoMeta("alice").bytes, JPEG.length, "sizes are plaintext sizes");
  assert.equal(folders.readFolders("alice")[0].name, MARKER);
  const meta = office.getDoc("alice", doc.id);
  assert.ok(office.readDocBytes("alice", meta).subarray(0, 2).equals(Buffer.from("PK")), "the document opens as a ZIP again");
  const [kept] = office.listVersions("alice", meta);
  assert.equal(kept.bytes, buildDocument("docx").length, "kept versions report plaintext sizes");
  assert.ok(office.readVersionBytes("alice", meta, kept.version).bytes.subarray(0, 2).equals(Buffer.from("PK")), "a kept version is not sealed twice");
  assert.equal(conversations.readConversation("alice", providerId).messages[0].content, MARKER);
  assert.equal(progress.readProgress("alice", "sql").lessons["select-all"].lastQuery, MARKER);
  assert.deepEqual(ledger.usageSummary("alice").models.map((m) => m.model), [MARKER]);
  assert.equal(workspace.readWorkspaceState("alice").text["textarea::input:0"], MARKER);
});

test("a file copied into another account's place does not open", () => {
  const from = accountScope("alice").learnFile;
  const to = accountScope("bob").learnFile;
  mkdirSync(join(dataDir, "learn"), { recursive: true });
  copyFileSync(from, to);
  assert.throws(() => sealed.readAccountText("bob", to), /does not open with this account's key/);
  assert.throws(() => progress.readProgress("bob", "sql"));
});

test("plaintext written before sealing still reads and is sealed by its next write", () => {
  const path = accountScope("carol").learnFile;
  writeFileSync(path, JSON.stringify({ version: 1, courses: { sql: { lessons: {}, current: "intro" } } }), { mode: 0o600 });
  assert.equal(progress.readProgress("carol", "sql").current, "intro");
  progress.updateLesson("carol", "sql", "intro", (p) => p);
  assert.ok(sealed.isSealedBytes(readFileSync(path)));
  assert.equal(progress.readProgress("carol", "sql").current, "intro");
});

test("without the key a sealed file does not open and no new key is made for reading", () => {
  const key = readFileSync(process.env.KNIFE_STORAGE_KEY_FILE);
  rmSync(process.env.KNIFE_STORAGE_KEY_FILE);
  sealed.resetStorageKeyCache();
  try {
    assert.throws(() => sealed.readAccountText("alice", accountScope("alice").learnFile), /storage key is missing/);
    assert.equal(existsSync(process.env.KNIFE_STORAGE_KEY_FILE), false);
  } finally {
    writeFileSync(process.env.KNIFE_STORAGE_KEY_FILE, key, { mode: 0o600 });
    sealed.resetStorageKeyCache();
  }
  assert.ok(sealed.readAccountText("alice", accountScope("alice").learnFile).length > 0);
});

test("sealAccountStorage seals an account's plaintext files in place, keeps mtimes, skips symlinks", async () => {
  const { sealAccountStorage } = await import("../src/lib/storage/migrate.ts");
  const { symlinkSync, utimesSync } = await import("node:fs");
  const conv = join(dataDir, "conversations", "dave");
  mkdirSync(conv, { recursive: true });
  const old = join(conv, "legacy.json");
  writeFileSync(old, JSON.stringify({ marker: MARKER }), { mode: 0o600 });
  const when = new Date("2026-01-02T03:04:05Z");
  utimesSync(old, when, when);
  writeFileSync(join(dataDir, "cv", "dave.json"), JSON.stringify({ marker: MARKER }), { mode: 0o600 });
  const outside = join(keyDir, "outside.txt");
  writeFileSync(outside, MARKER);
  symlinkSync(outside, join(conv, "link.json"));

  assert.equal(sealAccountStorage("dave", { dryRun: true }).sealed, 2);
  assert.equal(sealed.isSealedBytes(readFileSync(old)), false, "a dry run writes nothing");
  const report = sealAccountStorage("dave");
  assert.equal(report.sealed, 2);
  assert.ok(sealed.isSealedBytes(readFileSync(old)));
  assert.equal(statSync(old).mtimeMs, when.getTime(), "mtime kept");
  assert.equal(JSON.parse(sealed.readAccountText("dave", old)).marker, MARKER);
  assert.equal(readFileSync(outside, "utf8"), MARKER, "the symlink target was not touched");
  assert.deepEqual(sealAccountStorage("dave"), { sealed: 0, alreadySealed: 2, files: [] }, "idempotent");
});

test("unsealAccountStorage opens every sealed file in place (rollback), keeping mtimes", async () => {
  const { unsealAccountStorage } = await import("../src/lib/storage/migrate.ts");
  const path = join(dataDir, "conversations", "dave", "legacy.json");
  const before = statSync(path).mtimeMs;
  assert.equal(unsealAccountStorage("dave", { dryRun: true }).sealed, 2);
  assert.ok(sealed.isSealedBytes(readFileSync(path)), "a dry run writes nothing");
  assert.equal(unsealAccountStorage("dave").sealed, 2);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).marker, MARKER, "plaintext again");
  assert.equal(statSync(path).mtimeMs, before);
  assert.equal(unsealAccountStorage("dave").sealed, 0, "idempotent");
});

test("tool drafts: the least recently saved tools make room, a re-save moves a tool to the end", () => {
  const big = "x".repeat(90_000);
  const fields = (n) => Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`textarea::${n}:${i}`, big]));
  for (let i = 0; i < 6; i += 1) workspace.saveWorkspaceTool("erin", `tool-${i}`, fields(i)); // ~450 KB each
  workspace.saveWorkspaceTool("erin", "tool-1", fields(1)); // tool-1 is now the most recent
  workspace.saveWorkspaceTool("erin", "tool-6", fields(6));
  const names = Object.keys(workspace.readWorkspaceState("erin"));
  assert.ok(names.includes("tool-1") && names.includes("tool-6"), names.join());
  assert.ok(!names.includes("tool-0"), "the oldest draft went first");
  assert.ok(Buffer.byteLength(JSON.stringify(workspace.readWorkspaceState("erin"))) <= 2 * 1024 * 1024);
  assert.equal(workspace.deleteWorkspaceTool("erin", "tool-6"), true);
  assert.equal(workspace.deleteWorkspaceTool("erin", "tool-6"), false);
});

test("renameAccount moves and re-seals everything, the provider key opens under the new id, MCP keys follow", async () => {
  const { renameAccount } = await import("../src/lib/storage/migrate.ts");
  const accounts = await import("../src/lib/accounts/store.ts");
  const keys = await import("../src/lib/accounts/mcp-keys.ts");
  accounts.mutateStore((s) => {
    s.accounts.push(accounts.newAccountRecord({ id: "olduser", displayName: "Old", provider: { baseUrl: "https://api.example.test/v1", model: "m", apiKey: "sk-secret-provider-key-123" } }));
  });
  const profile = emptyCvData();
  profile.profile.contact.name = MARKER;
  cv.saveCv("olduser", profile);
  cv.saveCv("olduser", profile);
  photo.savePhoto("olduser", JPEG);
  progress.updateLesson("olduser", "sql", "select-all", (p) => ({ ...p, lastQuery: MARKER }));
  workspace.saveWorkspaceTool("olduser", "text", { a: MARKER });
  const doc = office.createDoc("olduser", { name: MARKER, format: "docx", bytes: buildDocument("docx"), source: "blank" });
  const { key } = keys.createMcpKey("olduser", "laptop");

  const report = renameAccount("olduser", "newuser");
  assert.ok(report.files >= 6, `${report.files} files`);
  assert.equal(report.mcpKeysMoved, 1);
  assert.ok(!accounts.getAccount("olduser"));
  assert.equal(accounts.getAccount("newuser").provider.apiKey, "sk-secret-provider-key-123", "provider key re-sealed under the new id");
  assert.equal(cv.loadCv("newuser").profile.contact.name, MARKER);
  assert.equal(cv.undoCv("newuser"), true, "snapshots moved too");
  assert.deepEqual(photo.readPhoto("newuser"), JPEG);
  assert.equal(progress.readProgress("newuser", "sql").lessons["select-all"].lastQuery, MARKER);
  assert.equal(workspace.readWorkspaceState("newuser").text.a, MARKER);
  assert.ok(office.readDocBytes("newuser", office.getDoc("newuser", doc.id)).subarray(0, 2).equals(Buffer.from("PK")));
  assert.equal(keys.listMcpKeys("newuser").length, 1);
  assert.ok(key.startsWith("skm_"));
  assert.equal(cv.loadCv("olduser").profile.contact.name, "", "nothing left under the old id");
  assert.equal(existsSync(join(dataDir, "docs", "olduser")), false);
  assert.throws(() => renameAccount("newuser", "admin"), /usable username/);
  accounts.mutateStore((st) => {
    st.accounts.push(accounts.newAccountRecord({ id: "taken", displayName: "Taken" }));
  });
  assert.throws(() => renameAccount("newuser", "taken"), /already exists/);
});
