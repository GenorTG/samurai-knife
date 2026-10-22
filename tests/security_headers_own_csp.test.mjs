// scripts/security-headers.mjs: a route's own (sandboxing) CSP replaces the app's, which a production Next server would
// otherwise keep (it does not override a header set before the route ran); webhook paths start under the strictest one.
// Run: node --test tests/security_headers_own_csp.test.mjs
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

const { applyOwnCsp, HOOK_CSP, HOOK_PATH } = await import("../scripts/security-headers.mjs");
const APP_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'";

async function serve(handler) {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Security-Policy", HOOK_PATH.test(req.url) ? HOOK_CSP : APP_CSP);
    applyOwnCsp(res);
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { url: (path) => `http://127.0.0.1:${port}${path}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("the marker replaces the app's CSP, is never sent, and only sandboxing policies are taken", async () => {
  const s = await serve((req, res) => {
    if (req.url === "/own") res.setHeader("X-Knife-Csp", "sandbox; default-src 'none'");
    if (req.url === "/loose") res.setHeader("X-Knife-Csp", "default-src *");
    if (req.url === "/object") {
      res.writeHead(200, { "X-Knife-Csp": "default-src 'none'; sandbox", "content-type": "text/plain" });
      return res.end("x");
    }
    res.end("ok");
  });
  try {
    const own = await fetch(s.url("/own"));
    assert.equal(own.headers.get("content-security-policy"), "sandbox; default-src 'none'");
    assert.equal(own.headers.get("x-knife-csp"), null);
    const loose = await fetch(s.url("/loose"));
    assert.equal(loose.headers.get("content-security-policy"), APP_CSP, "a loosening policy is ignored");
    const object = await fetch(s.url("/object"));
    assert.equal(object.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    assert.equal(object.headers.get("x-knife-csp"), null);
    const plain = await fetch(s.url("/plain"));
    assert.equal(plain.headers.get("content-security-policy"), APP_CSP);
    const hook = await fetch(s.url("/api/hooks/abc/x"));
    assert.equal(hook.headers.get("content-security-policy"), HOOK_CSP, "webhooks start sandboxed");
  } finally {
    await s.close();
  }
});
