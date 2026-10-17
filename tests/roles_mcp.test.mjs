// Roles and per-account isolation helpers: tool scopes and the role filter (src/lib/mcp/define.ts, tools.ts), MCP keys
// (src/lib/accounts/mcp-keys.ts), per-owner fairness in the work queue and the job store, the course run slots
// (src/lib/learn/sql/slots.ts) and the child-process environment (src/lib/child-env.ts).
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/roles_mcp.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-roles-unit-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_AUTH_MODE = "public";
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const store = await import("../src/lib/accounts/store.ts");
const keys = await import("../src/lib/accounts/mcp-keys.ts");
const { defineTool, toolAllowed } = await import("../src/lib/mcp/define.ts");
const z = await import("zod/v4");
const { WorkQueue } = await import("../src/lib/work-queue.ts");
const { withLearnerSlot } = await import("../src/lib/learn/sql/slots.ts");
const { childEnv } = await import("../src/lib/child-env.ts");

const ADMIN_TOOLS = ["knife_cv_github_repos", "knife_cv_github_repo_facts", "knife_cv_local_repo_facts", "knife_cv_showcase_rank", "knife_cv_project_from_github"];
const deferred = () => {
  let resolve;
  const promise = new Promise((res) => (resolve = res));
  return { promise, resolve };
};

// The tool modules import CV code Node's type stripping cannot load, so scopes are read from the sources here; the e2e
// suite (tests/functional/roles_mcp_e2e.py) checks the served lists and calls.
function declaredTools() {
  const dir = new URL("../src/lib/mcp/", import.meta.url);
  const out = [];
  for (const file of readdirSync(dir).filter((name) => name.startsWith("tools") && name.endsWith(".ts"))) {
    const source = readFileSync(new URL(file, dir), "utf8");
    const defines = source.split("defineTool({").length - 1;
    const found = [...source.matchAll(/defineTool\(\{\s*name: "([a-z_]+)",\s*scope: "([a-z]+)",/g)];
    assert.equal(found.length, defines, `${file}: every defineTool names its scope right after its name`);
    for (const match of found) out.push({ file, name: match[1], scope: match[2] });
  }
  return out;
}

test("every tool declares a known scope; exactly the GitHub/local-repo tools are admin-only", () => {
  const tools = declaredTools();
  assert.ok(tools.length >= 60, `found ${tools.length}`);
  for (const tool of tools) assert.ok(["pure", "account", "admin"].includes(tool.scope), tool.name);
  assert.deepEqual(tools.filter((tool) => tool.scope === "admin").map((tool) => tool.name).sort(), [...ADMIN_TOOLS].sort());
  for (const tool of tools.filter((t) => t.file === "tools-ui.ts")) assert.equal(tool.scope, "account");
  for (const tool of tools.filter((t) => /^tools-(cv|docs|learn)/.test(t.file) && !ADMIN_TOOLS.includes(t.name))) assert.equal(tool.scope, "account", tool.name);
});

test("toolAllowed: pure for anyone, account needs an account, admin needs an admin, unknown scope never", () => {
  const user = { accountId: "bob", admin: false };
  const admin = { accountId: "genor", admin: true };
  assert.ok(toolAllowed({ scope: "pure" }, undefined));
  assert.ok(!toolAllowed({ scope: "account" }, undefined));
  assert.ok(toolAllowed({ scope: "account" }, user));
  assert.ok(!toolAllowed({ scope: "admin" }, user));
  assert.ok(toolAllowed({ scope: "admin" }, admin));
  assert.ok(!toolAllowed({ scope: "secret" }, admin));
});

test("a defined admin tool refuses a non-admin caller even when dispatched directly", async () => {
  let ran = 0;
  const tool = defineTool({ name: "t_admin", scope: "admin", description: "", schema: z.object({}), run: () => ++ran });
  await assert.rejects(tool.execute({}, { accountId: "bob", admin: false }), /administrator/);
  await assert.rejects(tool.execute({}, undefined), /account context/);
  assert.equal(await tool.execute({}, { accountId: "genor", admin: true }), 1);
  assert.equal(ran, 1);
});

function addAccount(id, extra = {}) {
  store.mutateStore((s) => {
    s.accounts.push(store.newAccountRecord({
      id,
      displayName: id,
      passwordHash: "scrypt$16384$8$1$AAAA$BBBB",
      email: `${id}@example.com`,
      emailVerifiedAt: "2026-01-01T00:00:00.000Z",
      role: "user",
      status: "active",
      ...extra,
    }));
    if (!s.defaultAccountId) s.defaultAccountId = id;
  });
}

test("MCP keys: shown once, stored hashed (0600), bound to their account, revocable", () => {
  addAccount("alice");
  addAccount("bob");
  const { key, view } = keys.createMcpKey("alice", "laptop");
  assert.match(key, /^skm_[A-Za-z0-9_-]{43}$/);
  const raw = readFileSync(join(dataDir, "mcp-keys.json"), "utf8");
  assert.ok(!raw.includes(key), "the raw key is never stored");
  assert.equal(statSync(join(dataDir, "mcp-keys.json")).mode & 0o777, 0o600);
  assert.equal(keys.accountForMcpKey({ username: "alice", key })?.id, "alice");
  assert.equal(keys.accountForMcpKey({ username: "bob", key }), null, "another username with alice's key");
  assert.equal(keys.accountForMcpKey({ username: "alice", key: `${key.slice(0, -1)}x` }), null);
  assert.deepEqual(keys.listMcpKeys("bob"), []);
  assert.equal(keys.listMcpKeys("alice")[0].id, view.id);
  assert.ok(keys.listMcpKeys("alice")[0].lastUsedAt, "last use recorded");
  assert.equal(keys.revokeMcpKey("bob", view.id), false, "bob cannot revoke alice's key");
  assert.equal(keys.revokeMcpKey("alice", view.id), true);
  assert.equal(keys.accountForMcpKey({ username: "alice", key }), null, "revoked key");
});

test("MCP keys: a disabled account's key stops working; deletion removes them; at most 10", () => {
  const { key } = keys.createMcpKey("bob", "ci");
  store.mutateStore((s) => {
    s.accounts.find((a) => a.id === "bob").status = "disabled";
  });
  assert.equal(keys.accountForMcpKey({ username: "bob", key }), null);
  assert.equal(keys.revokeAllMcpKeys("bob"), 1);
  for (let i = 0; i < keys.MAX_KEYS_PER_ACCOUNT; i += 1) keys.createMcpKey("alice", `k${i}`);
  assert.throws(() => keys.createMcpKey("alice", "one too many"), /At most/);
  assert.throws(() => keys.createMcpKey("alice", "   "), /name/);
});

test("MCP credentials: Basic and Bearer + X-Knife-User; anything else is malformed", () => {
  const basic = new Request("http://x/api/mcp", { headers: { authorization: `Basic ${Buffer.from("Alice:skm_k").toString("base64")}` } });
  assert.deepEqual(keys.mcpCredentials(basic), { username: "alice", key: "skm_k" });
  const bearer = new Request("http://x/api/mcp", { headers: { authorization: "Bearer skm_k", "x-knife-user": "alice" } });
  assert.deepEqual(keys.mcpCredentials(bearer), { username: "alice", key: "skm_k" });
  assert.equal(keys.mcpCredentials(new Request("http://x/api/mcp", { headers: { authorization: "Bearer skm_k" } })), "malformed");
  assert.equal(keys.mcpCredentials(new Request("http://x/api/mcp", { headers: { authorization: "Token abc" } })), "malformed");
  assert.equal(keys.mcpCredentials(new Request("http://x/api/mcp")), null);
});

test("work queue: per-owner cap, and a free slot goes to the owner with fewer running jobs", async () => {
  const queue = new WorkQueue({ lane: { concurrency: 1, maxDepth: 10, perOwner: 3 } });
  const order = [];
  const gates = [];
  const submit = (owner, tag) => {
    const gate = deferred();
    gates.push(gate);
    return queue.submit("lane", async () => {
      order.push(tag);
      await gate.promise;
    }, { owner });
  };
  const jobs = [submit("a", "a1"), submit("a", "a2"), submit("a", "a3")];
  assert.throws(() => submit("a", "a4"), (error) => error.code === "QUEUE_FULL" && error.scope === "owner");
  jobs.push(submit("b", "b1"));
  // a1 runs; a2, a3, b1 wait. When a1 ends, b1 (owner with nothing running) goes before a2.
  gates[0].resolve();
  await jobs[0].promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["a1", "b1"]);
  for (const gate of gates) gate.resolve();
  await Promise.all(jobs.map((job) => job.promise));
  assert.deepEqual(order, ["a1", "b1", "a2", "a3"]);
  // No owner: no per-owner cap.
  const anon = new WorkQueue({ lane: { concurrency: 1, maxDepth: 10, perOwner: 1 } });
  const both = [anon.submit("lane", async () => 1), anon.submit("lane", async () => 2)];
  assert.deepEqual(await Promise.all(both.map((job) => job.promise)), [1, 2]);
});

test("course run slots: a second run of the same account is refused, other accounts still run", async () => {
  const gate = deferred();
  const first = withLearnerSlot("alice", () => gate.promise);
  await assert.rejects(withLearnerSlot("alice", async () => 1), (error) => error.code === "run_in_progress" && error.status === 429);
  assert.equal(await withLearnerSlot("bob", async () => "bob ran"), "bob ran");
  gate.resolve("done");
  assert.equal(await first, "done");
  assert.equal(await withLearnerSlot("alice", async () => "again"), "again");
});

test("course run slots: past the server cap a run waits for a free slot", async () => {
  process.env.KNIFE_LEARN_MAX_RUNS = "1";
  try {
    const gate = deferred();
    const first = withLearnerSlot("u1", () => gate.promise);
    let second = false;
    const waiting = withLearnerSlot("u2", async () => {
      second = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(second, false, "waits while the only slot is taken");
    gate.resolve();
    await first;
    await waiting;
    assert.equal(second, true);
  } finally {
    delete process.env.KNIFE_LEARN_MAX_RUNS;
  }
});

test("child processes never inherit the server's secrets", () => {
  process.env.KNIFE_SMTP_PASS = "smtp-secret";
  process.env.OPENAI_API_KEY = "sk-secret";
  const env = childEnv(["TESSDATA_PREFIX"], { PYTHONDONTWRITEBYTECODE: "1" });
  assert.equal(env.KNIFE_SMTP_PASS, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.KNIFE_DATA_DIR, undefined);
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
});
