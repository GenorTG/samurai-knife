// Personal MCP URL and key scopes (docs/MCP.md "Connecting", "Key scopes"): /api/mcp/u/<username> takes only a Bearer key
// of that account; read-only keys list and call only tools that change nothing; KNIFE_MCP_REQUIRE_KEY; old /api/mcp kept.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/mcp_personal.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-mcp-personal-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_STORAGE_KEY_FILE = join(dataDir, "storage.key");
process.env.KNIFE_EMAIL_DNS = "off";
delete process.env.KNIFE_AUTH_MODE;
delete process.env.KNIFE_PUBLIC_URL;
delete process.env.KNIFE_MCP_REQUIRE_KEY;
process.env.KNIFE_HOST = "127.0.0.1";
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import("../src/lib/accounts/store.ts");
const keys = await import("../src/lib/accounts/mcp-keys.ts");
const { mcpToolsFor, annotationsFor } = await import("../src/lib/mcp/server.ts");
const { handleMcpRequest } = await import("../src/lib/mcp/http.ts");
const { mcpClientConfigs } = await import("../src/lib/mcp/client-configs.ts");

const ORIGIN = "http://127.0.0.1:3210";
for (const id of ["alice", "bob"]) {
  store.mutateStore((s) => {
    s.accounts.push(store.newAccountRecord({ id, displayName: id, status: "active" }));
  });
}

/** One JSON-RPC call to an MCP endpoint, as a client would send it. */
async function rpc(path, method, params, headers = {}) {
  const request = new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { host: "127.0.0.1:3210", "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const username = /^\/api\/mcp\/u\/(.*)$/.exec(path)?.[1];
  const response = await handleMcpRequest(request, username === undefined ? undefined : { username: decodeURIComponent(username) });
  const text = await response.text();
  let body = null;
  const sse = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  try {
    body = JSON.parse(sse || text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}
const listed = (reply) => reply.body.result.tools.map((t) => t.name);

test("keys carry a scope; old records without one are full; the view never has the hash", () => {
  const full = keys.createMcpKey("alice", "laptop");
  const read = keys.createMcpKey("alice", "reader", "read-only");
  assert.equal(full.view.scope, "full");
  assert.equal(read.view.scope, "read-only");
  assert.deepEqual(keys.listMcpKeys("alice").map((k) => k.scope), ["full", "read-only"]);
  assert.equal(keys.callerForMcpKey({ username: "alice", key: read.key }).scope, "read-only");
  // A key file from before scopes: no `scope` field reads as full.
  const path = join(dataDir, "mcp-keys.json");
  const file = JSON.parse(readFileSync(path, "utf8"));
  delete file.keys[0].scope;
  writeFileSync(path, JSON.stringify(file));
  assert.equal(keys.callerForMcpKey({ username: "alice", key: full.key }).scope, "full");
  assert.ok(!JSON.stringify(keys.listMcpKeys("alice")).includes("hash"));
  // A record with an unknown scope is dropped (fail closed), never treated as full.
  file.keys[0].scope = "admin";
  writeFileSync(path, JSON.stringify(file));
  assert.equal(keys.callerForMcpKey({ username: "alice", key: full.key }), null);
  delete file.keys[0].scope;
  writeFileSync(path, JSON.stringify(file));
});

test("a key belongs to exactly one username (as stored); revoked keys are dead", () => {
  const { key, view } = keys.createMcpKey("bob", "ci");
  assert.equal(keys.callerForMcpKey({ username: "bob", key }).account.id, "bob");
  assert.equal(keys.callerForMcpKey({ username: "alice", key }), null);
  assert.equal(keys.callerForMcpKey({ username: "Bob", key }), null, "no case folding on the per-user lookup");
  keys.revokeMcpKey("bob", view.id);
  assert.equal(keys.callerForMcpKey({ username: "bob", key }), null);
});

test("Bearer parsing and KNIFE_MCP_REQUIRE_KEY", () => {
  const req = (authorization) => new Request("http://x/", authorization ? { headers: { authorization } } : {});
  assert.equal(keys.bearerKey(req()), null);
  assert.equal(keys.bearerKey(req("Bearer skm_abc")), "skm_abc");
  assert.equal(keys.bearerKey(req("bearer   skm_abc")), "skm_abc");
  assert.equal(keys.bearerKey(req("Basic eDp5")), "malformed");
  assert.equal(keys.bearerKey(req("Bearer a b")), "malformed");
  assert.equal(keys.mcpKeyRequired(true), true, "public mode always");
  assert.equal(keys.mcpKeyRequired(false), false, "private mode default: off");
  process.env.KNIFE_MCP_REQUIRE_KEY = "1";
  try {
    assert.equal(keys.mcpKeyRequired(false), true);
  } finally {
    delete process.env.KNIFE_MCP_REQUIRE_KEY;
  }
});

test("read-only scope: only readOnlyHint tools, never a write, destructive or UI tool", () => {
  const all = mcpToolsFor({ accountId: "alice", admin: false });
  const read = mcpToolsFor({ accountId: "alice", admin: false, readOnly: true });
  assert.ok(read.length > 10 && read.length < all.length, `${read.length} of ${all.length}`);
  for (const tool of read) assert.equal(annotationsFor(tool).readOnlyHint, true, tool.name);
  const names = read.map((t) => t.name);
  for (const write of ["knife_cv_patch", "knife_cv_job_delete", "knife_doc_create", "knife_ui_call", "knife_site_write"]) {
    assert.ok(all.some((t) => t.name === write), `${write} exists`);
    assert.ok(!names.includes(write), `${write} hidden from a read-only key`);
  }
  assert.ok(names.includes("knife_cv_get") && names.includes("knife_hash"));
});

test("personal URL: Bearer key of that account only; same generic 401 otherwise", async () => {
  const alice = keys.createMcpKey("alice", "personal");
  const bob = keys.createMcpKey("bob", "personal");
  const ok = await rpc("/api/mcp/u/alice", "tools/list", {}, { authorization: `Bearer ${alice.key}` });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.result, JSON.stringify(ok.body).slice(0, 400));
  assert.ok(listed(ok).includes("knife_cv_patch"));
  const wrong = [
    ["no key", "/api/mcp/u/alice", {}],
    ["bob's key", "/api/mcp/u/alice", { authorization: `Bearer ${bob.key}` }],
    ["bad key", "/api/mcp/u/alice", { authorization: `Bearer ${alice.key.slice(0, -1)}x` }],
    ["Basic", "/api/mcp/u/alice", { authorization: `Basic ${Buffer.from(`alice:${alice.key}`).toString("base64")}` }],
    ["case variant", "/api/mcp/u/Alice", { authorization: `Bearer ${alice.key}` }],
    ["traversal", "/api/mcp/u/..%2Falice", { authorization: `Bearer ${alice.key}` }],
    ["encoded name", "/api/mcp/u/%61lice%00", { authorization: `Bearer ${alice.key}` }],
    ["unknown user", "/api/mcp/u/nobody", { authorization: `Bearer ${alice.key}` }],
    ["X-Knife-User does not override the path", "/api/mcp/u/bob", { authorization: `Bearer ${alice.key}`, "x-knife-user": "alice" }],
  ];
  for (const [what, path, headers] of wrong) {
    const reply = await rpc(path, "tools/list", {}, headers);
    assert.equal(reply.status, 401, what);
    assert.match(reply.headers.get("www-authenticate") ?? "", /^Bearer /, what);
    assert.ok(["invalid_mcp_key", "mcp_key_required"].includes(reply.body.error), what);
    assert.ok(!JSON.stringify(reply.body).includes("alice") || what === "none", `${what}: the answer names no account`);
  }
});

test("read-only key over HTTP: write tools neither listed nor callable; old /api/mcp unchanged", async () => {
  const read = keys.createMcpKey("bob", "reader", "read-only");
  const list = await rpc("/api/mcp/u/bob", "tools/list", {}, { authorization: `Bearer ${read.key}` });
  assert.equal(list.status, 200);
  assert.ok(!listed(list).includes("knife_cv_patch"));
  const call = await rpc("/api/mcp/u/bob", "tools/call", { name: "knife_cv_patch", arguments: { ops: [{ op: "set", path: "/summary/en", value: "x" }] } }, { authorization: `Bearer ${read.key}` });
  const refused = call.body.error || call.body.result?.isError;
  assert.ok(refused, `refused: ${JSON.stringify(call.body).slice(0, 200)}`);
  const hash = await rpc("/api/mcp/u/bob", "tools/call", { name: "knife_hash", arguments: { text: "a" } }, { authorization: `Bearer ${read.key}` });
  assert.ok(!hash.body.result.isError, "a read tool runs");
  // The shared endpoint: Bearer + X-Knife-User, the same scope applies.
  const shared = await rpc("/api/mcp", "tools/list", {}, { authorization: `Bearer ${read.key}`, "x-knife-user": "bob" });
  assert.equal(shared.status, 200);
  assert.ok(!listed(shared).includes("knife_cv_patch"));
  // Private mode without a key: the default account, unless KNIFE_MCP_REQUIRE_KEY.
  assert.equal((await rpc("/api/mcp", "tools/list", {})).status, 200);
  process.env.KNIFE_MCP_REQUIRE_KEY = "1";
  try {
    const refusedNoKey = await rpc("/api/mcp", "tools/list", {});
    assert.equal(refusedNoKey.status, 401);
    assert.equal(refusedNoKey.body.error, "mcp_key_required");
  } finally {
    delete process.env.KNIFE_MCP_REQUIRE_KEY;
  }
});

test("client configs for the account page carry the personal URL and the Bearer key", () => {
  const configs = mcpClientConfigs("https://knife.example/api/mcp/u/alice", "skm_x");
  assert.deepEqual(configs.map((c) => c.id), ["openclaw", "claude", "cursor"]);
  assert.match(configs[0].text, /^openclaw mcp add samurai-knife --url https:\/\/knife\.example\/api\/mcp\/u\/alice --transport streamable-http --header "Authorization=Bearer skm_x"$/);
  assert.match(configs[1].text, /^claude mcp add --transport http samurai-knife https:\/\/knife\.example\/api\/mcp\/u\/alice --header "Authorization: Bearer skm_x"$/);
  assert.deepEqual(JSON.parse(configs[2].text), { mcpServers: { "samurai-knife": { url: "https://knife.example/api/mcp/u/alice", headers: { Authorization: "Bearer skm_x" } } } });
});
