// Office editor proxy (scripts/office-proxy.mjs): path allow-list, tickets (same format as src/lib/office/proxy.ts),
// cookie gate, header hygiene, websocket pass-through, budgets and the upstream-down answer, against a fake Document Server.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/office_proxy.test.mjs
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

const proxyMod = await import("../scripts/office-proxy.mjs");
const { allowedPath, createOfficeProxy, signTicket, ticketKey, verifyTicket, COOKIE_NAME } = proxyMod;
const { proxyTicket } = await import("../src/lib/office/proxy.ts");

const SECRET = "test-jwt-secret-0123456789";
const KEY = ticketKey(SECRET);

test("allow-list: editor paths pass, service/admin paths and traversal do not", () => {
  for (const ok of [
    "/web-apps/apps/api/documents/api.js",
    "/9.3.5-bb33495cfb0f04ccf4334effd397781f/web-apps/apps/documenteditor/main/index.html?_dc=1",
    "/9.3.5-abc/sdkjs/word/sdk-all-min.js",
    "/9.3.5-abc/sdkjs-plugins/knife-bridge-1234/config.json",
    "/9.3.5-abc/fonts/000",
    "/9.3.5-abc/doc/key123/c/?EIO=4&transport=websocket",
    "/cache/files/data/key123/output.docx/output.docx?md5=x&expires=1",
    "/9.3.5-abc/downloadas/key123?cmd=x",
    "/9.3.5-abc/upload/key123/user/1",
    "/plugins.json",
    "/9.3.5-abc/document_editor_service_worker.js",
    "/9.3.5-abc/sdkjs/slide/themes//themes.js",
  ]) assert.ok(allowedPath(ok), ok);
  for (const bad of [
    "/",
    "/welcome/",
    "/healthcheck",
    "/coauthoring/CommandService.ashx",
    "/ConvertService.ashx",
    "/converter",
    "/docbuilder",
    "/info/info.json",
    "/9.3.5-abc/info/info.json",
    "/internal/cluster/inactive",
    "/9.3.5-abc/internal/x",
    "/admin",
    "/ai-proxy/v1/chat",
    "/9.3.5-abc/ai-proxy",
    "/example/",
    "/hosting/discovery",
    "/web-apps/../info/info.json",
    "/web-apps/%2e%2e/info",
    "/sdkjs/x%2f..%2finfo",
    "/web-apps/a\\b",
    "web-apps/x",
    "//evil.example/web-apps/x",
    "http://evil/web-apps/x",
  ]) assert.equal(allowedPath(bad), null, bad);
});

test("tickets: the app's tickets verify in the proxy; tampered, expired and foreign-key tickets do not", () => {
  const now = Math.floor(Date.now() / 1000);
  const fromApp = proxyTicket("alice", SECRET, now);
  assert.equal(verifyTicket(KEY, fromApp, now)?.account, "alice");
  assert.equal(fromApp, signTicket(KEY, "alice", 6 * 3600, now));
  assert.equal(verifyTicket(ticketKey("other-secret"), fromApp, now), null);
  assert.equal(verifyTicket(KEY, fromApp, now + 6 * 3600 + 1), null);
  const [v, payload, mac] = fromApp.split(".");
  const forged = Buffer.from(JSON.stringify({ a: "admin", e: now + 999 })).toString("base64url");
  assert.equal(verifyTicket(KEY, `${v}.${forged}.${mac}`, now), null);
  assert.equal(verifyTicket(KEY, `${v}.${payload}.${mac.slice(0, -2)}AA`, now), null);
  assert.equal(verifyTicket(KEY, "", now), null);
  assert.equal(verifyTicket(KEY, "x".repeat(600), now), null);
});

/** Listens on loopback; `server.kill()` closes it with every socket, upgraded ones included (closeAllConnections skips those). */
function listen(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.kill = () => {
    server.close();
    for (const socket of sockets) socket.destroy();
  };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/** A fake Document Server: echoes what it got; answers websocket upgrades with 101 and echoes frames' bytes. */
async function fakeUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = 0;
    req.on("data", (c) => (body += c.length));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader("Set-Cookie", "upstream=1");
      res.setHeader("Server", "nginx/9");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ url: req.url }));
    });
  });
  server.on("upgrade", (req, socket) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, upgrade: true });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d) => socket.write(d));
  });
  const port = await listen(server);
  return { server, port, seen };
}

async function proxyServer(upstream, limits = {}) {
  const proxy = createOfficeProxy({
    officeUrl: "https://office.example.test",
    appOrigin: "https://app.example.test",
    config: () => ({ upstream, key: KEY }),
    trusted: ["127.0.0.1"],
    limits,
    log: () => {},
  });
  const server = http.createServer((req, res) => (proxy.matches(req) ? proxy.handleRequest(req, res) : (res.statusCode = 418, res.end("app"))));
  server.on("upgrade", (req, socket, head) => (proxy.matches(req) ? proxy.handleUpgrade(req, socket, head) : socket.destroy()));
  const port = await listen(server);
  return { server, port };
}

function get(port, path, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { host: "office.example.test", ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end();
  });
}

function upgrade(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const lines = [`GET ${path} HTTP/1.1`, "Host: office.example.test", "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (d) => {
      data += d;
      if (data.includes("\r\n\r\n")) {
        const status = Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1]);
        resolve({ status, socket, data });
      }
    });
    socket.on("error", reject);
  });
}

test("proxy: ticket -> cookie gate, header hygiene, websocket, budgets, upstream down", async (t) => {
  const up = await fakeUpstream();
  const px = await proxyServer({ host: "127.0.0.1", port: up.port }, { refusedPerMinute: 1000, requestsPerMinute: 1000 });
  t.after(() => {
    up.server.kill();
    px.server.kill();
  });
  const ticket = signTicket(KEY, "alice");

  // Without a ticket or cookie: refused, never forwarded.
  const anon = await get(px.port, "/web-apps/apps/api/documents/api.js");
  assert.equal(anon.status, 403);
  assert.equal(up.seen.length, 0);

  // Refused paths are 404 even with a valid cookie.
  for (const path of ["/coauthoring/CommandService.ashx", "/info/info.json", "/internal/cluster/inactive", "/ai-proxy/x", "/web-apps/../info/x"]) {
    const res = await get(px.port, path, { cookie: `${COOKIE_NAME}=${ticket}` });
    assert.equal(res.status, 404, path);
  }
  assert.equal(up.seen.length, 0);

  // The ticket on api.js: forwarded without it, cookie set (HttpOnly, Secure, SameSite=Strict), upstream cookie dropped.
  const first = await get(px.port, `/web-apps/apps/api/documents/api.js?knife_ticket=${encodeURIComponent(ticket)}`, {
    "x-forwarded-for": "203.0.113.9",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "evil.example",
    cookie: "knife_session=app-secret",
    "x-knife-peer": "1.2.3.4",
  });
  assert.equal(first.status, 200);
  const sent = up.seen.at(-1);
  assert.equal(sent.url, "/web-apps/apps/api/documents/api.js");
  assert.equal(sent.headers["x-forwarded-host"], "office.example.test");
  assert.equal(sent.headers["x-forwarded-proto"], "https");
  assert.equal(sent.headers["x-forwarded-for"], "203.0.113.9");
  assert.equal(sent.headers.cookie, undefined, "no browser cookie reaches the editor server");
  assert.equal(sent.headers["x-knife-peer"], undefined);
  const setCookie = String(first.headers["set-cookie"]);
  assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=v1\\.`));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Secure/);
  assert.doesNotMatch(setCookie, /upstream=1/);
  assert.equal(first.headers.server, undefined);
  assert.match(first.headers["content-security-policy"], /frame-ancestors https:\/\/app\.example\.test https:\/\/office\.example\.test/);
  assert.match(first.headers["strict-transport-security"], /max-age=/);

  // With the cookie: editor files go through; a ticket only works on api.js.
  const page = await get(px.port, "/9.3.5-abc/web-apps/apps/documenteditor/main/index.html", { cookie: `${COOKIE_NAME}=${ticket}` });
  assert.equal(page.status, 200);
  const ticketElsewhere = await get(px.port, `/9.3.5-abc/sdkjs/word/x.js?knife_ticket=${encodeURIComponent(ticket)}`);
  assert.equal(ticketElsewhere.status, 403);
  const badCookie = await get(px.port, "/9.3.5-abc/sdkjs/word/x.js", { cookie: `${COOKIE_NAME}=${ticket.slice(0, -3)}abc` });
  assert.equal(badCookie.status, 403);
  const wrongMethod = await get(px.port, "/9.3.5-abc/sdkjs/word/x.js", { cookie: `${COOKIE_NAME}=${ticket}` }, "DELETE");
  assert.equal(wrongMethod.status, 405);

  // Websocket: only with the cookie, only on the document channel.
  const noCookie = await upgrade(px.port, "/9.3.5-abc/doc/key1/c/?EIO=4&transport=websocket");
  assert.equal(noCookie.status, 403);
  noCookie.socket.destroy();
  const notWs = await upgrade(px.port, "/9.3.5-abc/sdkjs/x.js", { Cookie: `${COOKIE_NAME}=${ticket}` });
  assert.equal(notWs.status, 404);
  notWs.socket.destroy();
  const ws = await upgrade(px.port, "/9.3.5-abc/doc/key1/c/?EIO=4&transport=websocket", { Cookie: `${COOKIE_NAME}=${ticket}` });
  assert.equal(ws.status, 101);
  const echoed = new Promise((resolve) => ws.socket.once("data", (d) => resolve(String(d))));
  ws.socket.write("ping-frame");
  assert.equal(await echoed, "ping-frame");
  const wsSeen = up.seen.find((s) => s.upgrade);
  assert.equal(wsSeen.headers.cookie, undefined);
  assert.equal(wsSeen.headers["x-forwarded-host"], "office.example.test");
  ws.socket.destroy();

  // Requests for other hosts are not the proxy's.
  const other = await new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: px.port, path: "/web-apps/x", headers: { host: "app.example.test" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
  });
  assert.equal(other, 418);
});

test("proxy: refused-request budget per address, request budget per account, upstream down", async (t) => {
  const up = await fakeUpstream();
  const px = await proxyServer({ host: "127.0.0.1", port: up.port }, { refusedPerMinute: 3, requestsPerMinute: 2 });
  const closed = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
  const downPx = await proxyServer({ host: "127.0.0.1", port: closed });
  t.after(() => {
    for (const s of [up.server, px.server, downPx.server]) s.kill();
  });
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await get(px.port, "/info/info.json")).status);
  assert.deepEqual(statuses, [404, 404, 404, 429, 429]);

  const ticket = signTicket(KEY, "bob");
  const ok = [];
  for (let i = 0; i < 3; i++) ok.push((await get(px.port, "/sdkjs/x.js", { cookie: `${COOKIE_NAME}=${ticket}` })).status);
  assert.deepEqual(ok, [200, 200, 429]);

  const down = await get(downPx.port, "/sdkjs/x.js", { cookie: `${COOKIE_NAME}=${ticket}` });
  assert.equal(down.status, 503);
});
