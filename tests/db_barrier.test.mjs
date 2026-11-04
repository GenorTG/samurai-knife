// The commit barrier (scripts/db-barrier.mjs + src/lib/db/barrier.ts, docs/DB-POSTGRES.md "Commit barrier"): a response
// that registered a commit goes out only after it, unchanged; a failed commit turns it into a 503 without Set-Cookie;
// a response with nothing pending is never delayed; per-request isolation (another request's commit never holds it).
// The response is written the way Next writes it (compression-style wrappers around write/writeHead included).
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/db_barrier.test.mjs
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

process.env.KNIFE_DB_URL = "postgres://u:p@127.0.0.1:1/unused"; // the preload installs itself only with a database
await import("../scripts/db-barrier.mjs");
const { holdResponseFor } = await import("../src/lib/db/barrier.ts");
delete process.env.KNIFE_DB_URL;

/** Wraps write/writeHead/end like Next's bundled compression does (per response, after the preload). */
function wrapLikeCompression(res) {
  const write = res.write;
  const end = res.end;
  res.write = function (...args) {
    if (!this.headersSent) this._implicitHeader();
    return write.apply(this, args);
  };
  res.end = function (...args) {
    if (!this.headersSent) this._implicitHeader();
    return end.apply(this, args);
  };
}

const routes = new Map();
const server = http.createServer((req, res) => {
  wrapLikeCompression(res);
  void routes.get(req.url)(req, res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const later = (ms, fail = false) => new Promise((resolve, reject) => setTimeout(() => (fail ? reject(new Error("commit failed")) : resolve()), ms));

routes.set("/saved", async (req, res) => {
  holdResponseFor(later(150));
  await new Promise((resolve) => setImmediate(resolve));
  res.setHeader("set-cookie", "s=1");
  res.writeHead(201, { "content-type": "application/json" });
  res.write('{"ok":');
  res.end("true}");
});
routes.set("/failed", async (req, res) => {
  holdResponseFor(later(30, true));
  res.setHeader("set-cookie", "session=granted");
  res.statusCode = 200;
  res.end('{"ok":true}');
});
routes.set("/read", async (req, res) => {
  res.end("plain read");
});
routes.set("/late", async (req, res) => {
  // A commit registered after the response started streaming: what is already written may be on its way; the rest waits.
  res.write("start ");
  holdResponseFor(later(300));
  res.end("end");
});

test("a held response goes out only after its commit, unchanged", async () => {
  const started = performance.now();
  const response = await fetch(`${base}/saved`);
  const elapsed = performance.now() - started;
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("set-cookie"), "s=1");
  assert.equal(await response.text(), '{"ok":true}');
  assert.ok(elapsed >= 140, `waited for the commit (${elapsed.toFixed(0)} ms)`);
});

test("a failed commit becomes 503 storage_unavailable without the answer's cookie", async () => {
  const response = await fetch(`${base}/failed`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("retry-after"), "2");
  assert.deepEqual((await response.json()).error, "storage_unavailable");
});

test("reads are never delayed, also while another request's commit is pending", async () => {
  const slow = fetch(`${base}/saved`);
  const started = performance.now();
  const read = await fetch(`${base}/read`);
  assert.equal(await read.text(), "plain read");
  assert.ok(performance.now() - started < 100, "not held by the other request");
  await slow;
});

test("a commit registered while streaming never corrupts the response", async () => {
  const response = await fetch(`${base}/late`);
  assert.equal(await response.text(), "start end");
});
