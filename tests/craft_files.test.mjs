// Craft files (src/lib/craft/files.ts): what the Craft apps save to the account. Save / replace by app + name / list /
// read / delete, file-name cleaning, sealed at rest, counted in the quota (area `craft`) and refused when full, removed
// with the account, the per-account save rate, the chooser's `accept` matching.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/craft_files.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-craft-files-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_AUTH_MODE = "public";
process.env.KNIFE_EMAIL_DNS = "off";
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import("../src/lib/accounts/store.ts");
const quota = await import("../src/lib/storage/quota.ts");
const files = await import("../src/lib/craft/files.ts");
const { deleteAccountData } = await import("../src/lib/accounts/data.ts");
const { accepts } = await import("../src/lib/craft/accept.ts");

store.mutateStore((s) => {
  s.accounts.push(store.newAccountRecord({ id: "alice", displayName: "Alice", role: "user", status: "active", storageQuotaBytes: 1024 * 1024 }));
  s.accounts.push(store.newAccountRecord({ id: "bob", displayName: "Bob", role: "user", status: "active", storageQuotaBytes: 1024 * 1024 }));
});

test("save, replace by app + name, list, read, delete; another account sees nothing", () => {
  const png = Buffer.from("\x89PNG fake image bytes");
  const first = files.saveCraftFile("alice", { app: "photocraft", name: "../../etc/Holiday.png", mime: "image/png", bytes: png }, new Date("2026-10-21T10:00:00Z"));
  assert.equal(first.name, "Holiday.png", "no path parts");
  assert.match(first.id, /^[0-9a-f]{20}$/);
  assert.deepEqual(files.readCraftFile("alice", first.id).bytes, png);
  // Same app + same name: the same file, replaced.
  const bigger = Buffer.alloc(5000, 1);
  const second = files.saveCraftFile("alice", { app: "photocraft", name: "Holiday.png", mime: "image/png", bytes: bigger }, new Date("2026-10-21T11:00:00Z"));
  assert.equal(second.id, first.id);
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.size, 5000);
  // Same name from another app: a separate file.
  const pdf = files.saveCraftFile("alice", { app: "pdfcraft", name: "Holiday.png", mime: "weird type!!", bytes: Buffer.from("%PDF") });
  assert.notEqual(pdf.id, first.id);
  assert.equal(pdf.mime, "application/octet-stream", "an odd type is never stored as given");
  assert.deepEqual(files.listCraftFiles("alice").map((file) => file.app).sort(), ["pdfcraft", "photocraft"]);
  assert.deepEqual(files.listCraftFiles("bob"), []);
  assert.throws(() => files.readCraftFile("bob", first.id), /Unknown file/);
  files.deleteCraftFile("alice", pdf.id);
  assert.deepEqual(files.listCraftFiles("alice").map((file) => file.id), [first.id]);
  assert.throws(() => files.deleteCraftFile("alice", pdf.id), /Unknown file/);
  assert.throws(() => files.readCraftFile("alice", "../index"), /Unknown file/);
});

test("sealed at rest: neither the index nor the blob holds the plaintext", () => {
  const marker = "PLAINTEXT-MARKER-42";
  files.saveCraftFile("alice", { app: "wordcraft", name: `${marker}.docx`, bytes: Buffer.from(`${marker} body`) });
  const dir = join(dataDir, "craft-files", "alice");
  for (const name of readdirSync(dir)) assert.ok(!readFileSync(join(dir, name)).includes(marker), name);
});

test("quota: counted in the `craft` area, a save that does not fit is refused (507), deleting frees it", () => {
  quota.invalidateUsage("bob");
  const before = quota.storageUsage("bob").areas.craft;
  const kept = files.saveCraftFile("bob", { app: "gridcraft", name: "a.csv", bytes: Buffer.alloc(600 * 1024, 2) });
  assert.ok(quota.storageUsage("bob").areas.craft >= before + 600 * 1024);
  assert.throws(() => files.saveCraftFile("bob", { app: "gridcraft", name: "b.csv", bytes: Buffer.alloc(600 * 1024, 3) }), (error) => error instanceof quota.QuotaExceededError && error.status === 507);
  assert.deepEqual(files.listCraftFiles("bob").map((file) => file.name), ["a.csv"], "nothing half-written");
  // Replacing a file with a smaller one always fits.
  files.saveCraftFile("bob", { app: "gridcraft", name: "a.csv", bytes: Buffer.alloc(10, 2) });
  files.deleteCraftFile("bob", kept.id);
  quota.invalidateUsage("bob");
  assert.ok(quota.storageUsage("bob").areas.craft < 1024);
});

test("bad input: unknown app, empty, over 50 MB", () => {
  assert.throws(() => files.saveCraftFile("alice", { app: "notcraft", name: "x", bytes: Buffer.from("x") }), /Unknown app/);
  assert.throws(() => files.saveCraftFile("alice", { app: "photocraft", name: "x", bytes: Buffer.alloc(0) }), /empty file/);
  assert.throws(() => files.saveCraftFile("alice", { app: "photocraft", name: "x", bytes: { byteLength: files.MAX_CRAFT_FILE_BYTES + 1 } }), (error) => error.status === 413);
  assert.equal(files.cleanFileName('  ..hidden"<x>|.png\n'), "hiddenx.png");
  assert.equal(files.cleanFileName(""), "untitled");
  assert.equal(files.cleanFileName("a/b\\c.txt"), "c.txt");
});

test("save rate: 30 a minute per account, then refused until the minute passes", () => {
  const t = 1_000_000;
  for (let i = 0; i < 30; i += 1) assert.equal(files.takeSaveSlot("rate-test", 30, t + i), true);
  assert.equal(files.takeSaveSlot("rate-test", 30, t + 31), false);
  assert.equal(files.takeSaveSlot("rate-other", 30, t + 31), true, "per account");
  assert.equal(files.takeSaveSlot("rate-test", 30, t + 61_000), true);
});

test("account deletion removes the Craft files", () => {
  files.saveCraftFile("alice", { app: "photocraft", name: "keep.png", bytes: Buffer.from("x") });
  assert.ok(existsSync(join(dataDir, "craft-files", "alice")));
  deleteAccountData("alice");
  assert.ok(!existsSync(join(dataDir, "craft-files", "alice")));
});

test("the chooser's accept matching (extensions, type/*, exact types, empty = all)", () => {
  const png = { name: "Holiday.PNG", mime: "image/png" };
  assert.equal(accepts("", png), true);
  assert.equal(accepts(".png,.jpg", png), true);
  assert.equal(accepts("image/*", png), true);
  assert.equal(accepts("application/pdf", png), false);
  assert.equal(accepts(".pdf, application/pdf", { name: "a.pdf", mime: "application/octet-stream" }), true);
});

test("a save without a type gets the type its extension names; a given type wins; unknown stays generic", async () => {
  const { mimeFor } = await import("../src/lib/craft/files.ts");
  assert.equal(mimeFor("speed.mp4", ""), "video/mp4");
  assert.equal(mimeFor("speed.MP4", "application/octet-stream"), "video/mp4");
  assert.equal(mimeFor("intro.webm", undefined), "video/webm");
  assert.equal(mimeFor("a.png", "image/webp"), "image/webp", "the app's own type is kept");
  assert.equal(mimeFor("project.fcproj", ""), "application/octet-stream");
  assert.equal(mimeFor("a.png", "weird type!!"), "application/octet-stream", "an invalid type is not replaced by a guess");
});
