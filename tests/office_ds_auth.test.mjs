// Office Document Server tokens (src/lib/office/ds-auth.ts) and the two guard-less DS routes: every token kind is
// refused where another kind is expected (the browser-visible editor config or a capability is never a DS token), the
// editor config expires, capabilities die with the account (disabled, deleted and registered again), and the save
// callback's download is read with a size cap. Regression for the audit's office findings (authz L4, injection #7,
// abuse #16).
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/office_ds_auth.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-ds-auth-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_HOST = "100.64.0.7";
process.env.KNIFE_PORT = "3210";
delete process.env.KNIFE_AUTH_MODE;
delete process.env.KNIFE_SIDECAR_APP_URL;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { findSidecar } = await import("../src/lib/services/definitions.ts");
const state = await import("../src/lib/services/state.ts");
const accounts = await import("../src/lib/accounts/store.ts");
const { signJwt, verifyJwt } = await import("../src/lib/jwt-hs256.ts");
const { buildDocument } = await import("../src/lib/office/templates.ts");
const docs = await import("../src/lib/office/store.ts");
const auth = await import("../src/lib/office/ds-auth.ts");
const editor = await import("../src/lib/office/editor.ts");
const { readCapped } = await import("../src/lib/office/callback.ts");
const fileRoute = await import("../src/app/api/office/ds/file/route.ts");
const callbackRoute = await import("../src/app/api/office/ds/callback/route.ts");

const office = findSidecar("office");
state.ensureSecrets(office);
state.writeState({ id: "office", image: office.image, bindHost: "100.64.0.7", hostPort: 3211, idleStopMinutes: 30, installedAt: "x", updatedAt: "x" });
const secret = state.readSecret("office", "JWT_SECRET");

function addAccount(id, fields = {}) {
  accounts.mutateStore((s) => {
    s.accounts = s.accounts.filter((a) => a.id !== id);
    s.accounts.push(accounts.newAccountRecord({ id, displayName: id, status: "active", ...fields }));
  });
  accounts.invalidateStoreCache();
  return accounts.getAccount(id);
}

function setStatus(id, status) {
  accounts.mutateStore((s) => {
    for (const a of s.accounts) if (a.id === id) a.status = status;
  });
  accounts.invalidateStoreCache();
}

/** What a session gets: the signed config with its two capability URLs. */
function openEditor(account) {
  const doc = docs.createDoc(account.id, { name: "Notes", format: "docx", bytes: buildDocument("docx"), source: "blank" });
  const { config } = editor.editorConfig(account, doc, { mode: "edit" });
  const t = (url) => decodeURIComponent(new URL(url).searchParams.get("t"));
  return { doc, config, fileT: t(config.document.url), callbackT: t(config.editorConfig.callbackUrl) };
}

/** The DS's own outbox tokens, as the 9.3.5 image signs them (header wraps in `payload`, body token is the callback). */
const dsHeader = (payload) => `Bearer ${signJwt({ payload }, secret, { expiresInSec: 300 })}`;
const dsBody = (body) => signJwt(body, secret, { expiresInSec: 300 });

function fileRequest(t, authorization) {
  const headers = authorization ? { authorization } : {};
  return new Request(`http://100.64.0.7:3210/api/office/ds/file?t=${encodeURIComponent(t)}`, { headers });
}

function callbackRequest(t, body, authorization) {
  const headers = { "content-type": "application/json", ...(authorization ? { authorization } : {}) };
  return new Request(`http://100.64.0.7:3210/api/office/ds/callback?t=${encodeURIComponent(t)}`, { method: "POST", headers, body: JSON.stringify(body) });
}

test("the real DS token shapes pass: file download with a header token, callback with the body token", async () => {
  const alice = addAccount("alice");
  const { doc, fileT, callbackT } = openEditor(alice);
  const file = await fileRoute.GET(fileRequest(fileT, dsHeader({ url: "x" })));
  assert.equal(file.status, 200);
  assert.ok((await file.arrayBuffer()).byteLength > 100);
  const body = { key: doc.key, status: 1, users: ["alice"] };
  const cb = await callbackRoute.POST(callbackRequest(callbackT, { ...body, token: dsBody(body) }, dsHeader(body)));
  assert.equal(cb.status, 200);
  assert.deepEqual(await cb.json(), { error: 0 });
});

test("cross-kind: the browser's editor config token is not a DS token (header or body)", async () => {
  const alice = addAccount("alice");
  const { doc, config, fileT, callbackT } = openEditor(alice);
  const browserToken = config.token;
  const file = await fileRoute.GET(fileRequest(fileT, `Bearer ${browserToken}`));
  assert.equal(file.status, 403, "editor config as the DS Bearer");
  const cb = await callbackRoute.POST(callbackRequest(callbackT, { key: doc.key, status: 2, url: "http://x/", token: browserToken }));
  assert.equal(cb.status, 403, "editor config as the callback body token");
  const cb2 = await callbackRoute.POST(callbackRequest(callbackT, { key: doc.key, status: 2 }, `Bearer ${browserToken}`));
  assert.equal(cb2.status, 403);
});

test("cross-kind: capability tokens are neither DS tokens nor each other, and DS-secret tokens are no capability", async () => {
  const alice = addAccount("alice");
  const { doc, fileT, callbackT } = openEditor(alice);
  assert.equal((await fileRoute.GET(fileRequest(fileT, `Bearer ${fileT}`))).status, 403, "file capability as Bearer");
  assert.equal((await fileRoute.GET(fileRequest(fileT, `Bearer ${callbackT}`))).status, 403, "callback capability as Bearer");
  assert.equal((await fileRoute.GET(fileRequest(callbackT, dsHeader({ url: "x" })))).status, 403, "callback capability on the file route");
  // A capability-shaped token signed with the raw DS secret (what an editor-config holder could never make anyway).
  const forged = signJwt({ acc: "alice", doc: doc.id, use: "file", ep: auth.accountEpoch(alice) }, secret, { expiresInSec: 60 });
  assert.equal((await fileRoute.GET(fileRequest(forged, dsHeader({ url: "x" })))).status, 403, "raw-secret capability");
  const cb = await callbackRoute.POST(callbackRequest(callbackT, { token: callbackT }));
  assert.equal(cb.status, 403, "capability as the callback body token");
  assert.throws(() => auth.readCapability(fileT, "callback"), /wrong capability/);
});

test("DS tokens must be the DS's shape: a header token without payload or exp, a body token without key/status, refused", () => {
  const req = (authorization) => new Request("http://x/", { headers: { authorization } });
  assert.throws(() => auth.readServerToken(req(`Bearer ${signJwt({ status: 2, key: "k" }, secret, { expiresInSec: 60 })}`)), /not a Document Server token/);
  assert.throws(() => auth.readServerToken(req(`Bearer ${signJwt({ payload: { url: "x" } }, secret)}`)), /not a Document Server token/, "no exp");
  assert.deepEqual(auth.readServerToken(req(dsHeader({ status: 2, key: "k" }))), { status: 2, key: "k" });
  assert.throws(() => auth.readServerToken(new Request("http://x/"), signJwt({ status: 6 }, secret, { expiresInSec: 60 })), /callback token/);
  assert.throws(() => auth.readServerToken(new Request("http://x/"), signJwt({ status: 6, key: "k" }, secret)), /callback token/, "no exp");
  assert.equal(auth.readServerToken(new Request("http://x/"), dsBody({ status: 6, key: "k" })).status, 6);
});

test("the editor config expires (24 h), and its capabilities carry the account epoch", () => {
  const alice = addAccount("alice");
  const { config, fileT } = openEditor(alice);
  const claims = verifyJwt(config.token, secret);
  assert.equal(typeof claims.exp, "number");
  assert.equal(claims.exp - claims.iat, auth.EDITOR_TOKEN_TTL_SEC);
  const cap = auth.readCapability(fileT, "file");
  assert.equal(cap.acc, "alice");
  assert.equal(cap.ep, auth.accountEpoch(alice));
  assert.throws(() => verifyJwt(fileT, secret), /bad signature/, "capabilities use their own key");
});

test("a disabled account's capabilities are refused; enabled again they work", async () => {
  const bob = addAccount("bob");
  const { doc, fileT, callbackT } = openEditor(bob);
  setStatus("bob", "disabled");
  assert.equal((await fileRoute.GET(fileRequest(fileT, dsHeader({ url: "x" })))).status, 403);
  const body = { key: doc.key, status: 1, users: ["bob"] };
  assert.equal((await callbackRoute.POST(callbackRequest(callbackT, { ...body, token: dsBody(body) }))).status, 403);
  setStatus("bob", "active");
  assert.equal((await fileRoute.GET(fileRequest(fileT, dsHeader({ url: "x" })))).status, 200);
});

test("deleted and registered again under the same id: the old capabilities are dead", async () => {
  const carol = addAccount("carol", { createdAt: "2026-01-01T00:00:00.000Z" });
  const { fileT } = openEditor(carol);
  addAccount("carol", { createdAt: "2026-10-18T00:00:00.000Z" });
  const response = await fileRoute.GET(fileRequest(fileT, dsHeader({ url: "x" })));
  assert.equal(response.status, 403);
  assert.doesNotMatch(JSON.stringify(await response.json()), /carol/, "no detail about the account");
  accounts.mutateStore((s) => {
    s.accounts = s.accounts.filter((a) => a.id !== "carol");
  });
  accounts.invalidateStoreCache();
  assert.equal((await fileRoute.GET(fileRequest(fileT, dsHeader({ url: "x" })))).status, 403, "deleted");
});

test("callback download: read with a cap, abandoned past it even without a Content-Length", async () => {
  let pulled = 0;
  const endless = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(64 * 1024));
    },
  });
  await assert.rejects(readCapped(new Response(endless), 1024 * 1024), /exceeds the size limit/);
  assert.ok(pulled < 40, `stopped after ${pulled} chunks`);
  const ok = await readCapped(new Response(new Uint8Array(1000)), 1000);
  assert.equal(ok.length, 1000);
});
