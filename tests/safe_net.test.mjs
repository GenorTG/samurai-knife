// Public-mode safety net: SSRF-safe outbound requests, per-account outbound policy and budget, provider error echo,
// streaming body limits (JSON and multipart), provider keys sealed at rest.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/safe_net.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-safenet-unit-"));
process.env.KNIFE_DATA_DIR = dataDir;
delete process.env.KNIFE_AUTH_MODE;
// A stand-in for "this server's public IPv4" and "the LAN's delegated IPv6 prefix".
process.env.KNIFE_SSRF_DENY_CIDRS = "93.184.215.0/24, 2a02:db8:4242::/48, not-a-cidr";
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const policyMod = await import("../src/lib/net/address-policy.ts");
const net = await import("../src/lib/net/safe-fetch.ts");
const outbound = await import("../src/lib/net/outbound.ts");
const provider = await import("../src/lib/accounts/provider.ts");
const httpMod = await import("../src/lib/accounts/http.ts");
const upload = await import("../src/lib/multipart-upload.ts");
const store = await import("../src/lib/accounts/store.ts");

const PUBLIC = "93.184.216.34";
const USER = { allowPrivate: false, ports: null, httpsOnly: true };
const OPEN = { allowPrivate: true, ports: null, httpsOnly: false };

function fakeNet(dns = {}) {
  const calls = { resolve: [], transport: [] };
  return {
    calls,
    resolve: async (host) => {
      calls.resolve.push(host);
      const answer = host in dns ? dns[host] : [PUBLIC];
      return answer.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    transport: async (request) => {
      calls.transport.push({ url: request.url.href, ip: request.ip.address, method: request.method, body: request.body });
      const status = request.url.pathname === "/redirect" ? 302 : 200;
      return { status, headers: { "content-type": "application/json", location: "http://127.0.0.1/" }, body: (async function* () { yield new TextEncoder().encode('{"data":[]}'); })(), close() {} };
    },
  };
}

// ---- address policy ---------------------------------------------------------------------------

test("CIDR parsing and matching (IPv4, IPv6, bare addresses, junk)", () => {
  const { parseCidr, inCidr, parseCidrList } = policyMod;
  assert.ok(inCidr("203.0.113.9", parseCidr("203.0.113.0/24")));
  assert.ok(!inCidr("203.0.114.9", parseCidr("203.0.113.0/24")));
  assert.ok(inCidr("93.184.215.7", parseCidr("93.184.215.7")));
  assert.ok(inCidr("2a02:db8:4242:1::5", parseCidr("2a02:db8:4242::/48")));
  assert.ok(!inCidr("2a02:db8:4243::5", parseCidr("2a02:db8:4242::/48")));
  assert.ok(!inCidr("93.184.215.7", parseCidr("2a02:db8:4242::/48")), "families never match each other");
  assert.ok(inCidr("10.1.2.3", parseCidr("10.0.0.0/7")), "prefix not on a byte boundary");
  for (const bad of ["", "10.0.0.0/33", "fd00::/129", "x/8", "10.0.0.0/8/1", "10.0.0.0/-1"]) assert.equal(parseCidr(bad), null, bad);
  assert.deepEqual(parseCidrList(" 1.2.3.4 , ,fd00::/8 nope").invalid, ["nope"]);
});

test("deny list = KNIFE_SSRF_DENY_CIDRS + this machine's interface addresses", () => {
  const deny = net.denyList();
  assert.ok(deny.some((c) => c.text === "93.184.215.0/24"));
  assert.ok(deny.some((c) => c.text === "2a02:db8:4242::/48"));
  assert.ok(deny.some((c) => c.text === "127.0.0.1/32"), "loopback interface listed");
  assert.match(policyMod.blockedAddressReason("93.184.215.80", deny), /own network/);
  assert.match(policyMod.blockedAddressReason("2a02:db8:4242:7::1", deny), /own network/);
  assert.equal(policyMod.blockedAddressReason(PUBLIC, deny), null);
});

// ---- safeFetch --------------------------------------------------------------------------------

test("SSRF matrix: private, loopback, Tailscale, ULA, mapped, own network: refused before any connection (user policy)", async () => {
  const urls = [
    "https://127.0.0.1/v1", "https://10.1.2.3/v1", "https://192.168.1.10:8080/api", "https://172.17.0.1:5432/", "https://100.64.0.1/v1",
    "https://100.101.102.103:3210/", "https://[::1]/v1", "https://[fd7a:115c:a1e0::1]/v1", "https://[fd00::5]/", "https://[fe80::1]/",
    "https://[::ffff:127.0.0.1]/", "https://169.254.169.254/latest/", "https://93.184.215.80/v1", "https://[2a02:db8:4242::10]/v1",
    "https://localhost/v1", "https://ollama.local/v1", "https://0.0.0.0/", "https://2130706433/", "https://user:pw@example.com/",
    "http://example.com/v1", "file:///etc/passwd",
  ];
  for (const url of urls) {
    const fake = fakeNet();
    await assert.rejects(net.safeFetch(url, { policy: USER, resolve: fake.resolve, transport: fake.transport }), (e) => e instanceof net.OutboundError && e.kind === "refused", url);
    assert.equal(fake.calls.transport.length, 0, `${url} must not connect`);
  }
});

test("a DNS name resolving to a private or own-network address is refused (any bad address in the answer)", async () => {
  for (const answer of [["10.0.0.7"], ["127.0.0.1"], [PUBLIC, "192.168.1.5"], ["fd00::1"], ["93.184.215.3"], ["100.100.100.100"], ["::ffff:10.0.0.1"]]) {
    const fake = fakeNet({ "llm.example": answer });
    await assert.rejects(net.safeFetch("https://llm.example/v1/models", { policy: USER, resolve: fake.resolve, transport: fake.transport }), /not a public address/, answer.join());
    assert.equal(fake.calls.transport.length, 0);
  }
  const fake = fakeNet({ "empty.example": [] });
  await assert.rejects(net.safeFetch("https://empty.example/", { policy: USER, resolve: fake.resolve, transport: fake.transport }), (e) => e.kind === "resolve");
});

test("public target: one resolution, connection pinned to it, POST body passed, redirects are errors", async () => {
  const fake = fakeNet({ "api.example": [PUBLIC] });
  const response = await net.safeFetch("https://api.example/v1/chat/completions", { method: "POST", body: "{}", policy: USER, resolve: fake.resolve, transport: fake.transport });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [] });
  assert.deepEqual(fake.calls.transport, [{ url: "https://api.example/v1/chat/completions", ip: PUBLIC, method: "POST", body: "{}" }]);
  assert.deepEqual(fake.calls.resolve, ["api.example"]);
  await assert.rejects(net.safeFetch("https://api.example/redirect", { policy: USER, resolve: fake.resolve, transport: fake.transport }), /redirects are not followed/);
});

test("admin opt-out / private mode policy reaches loopback, still pinned, still no credentials", async () => {
  const fake = fakeNet({ "laip.lan": ["192.168.1.20"] });
  const ok = await net.safeFetch("http://laip.lan:8080/v1/models", { policy: OPEN, resolve: fake.resolve, transport: fake.transport });
  assert.equal(ok.status, 200);
  assert.equal(fake.calls.transport[0].ip, "192.168.1.20");
  await assert.rejects(net.safeFetch("http://u:p@127.0.0.1/", { policy: OPEN, resolve: fake.resolve, transport: fake.transport }), /credentials/);
});

test("real transport: pinned to the resolved address, Host header keeps the name, body streams, abort works", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ host: req.headers.host, method: req.method, body, url: req.url });
      if (req.url === "/slow") return; // never answers
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("hello ");
      setTimeout(() => res.end("world"), 20);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const resolve = async () => [{ address: "127.0.0.1", family: 4 }];
    const response = await net.safeFetch(`http://pinned.example:${port}/x?y=1`, { method: "POST", body: "payload", policy: OPEN, resolve });
    assert.equal(await response.text(), "hello world");
    assert.deepEqual(seen[0], { host: `pinned.example:${port}`, method: "POST", body: "payload", url: "/x?y=1" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(net.safeFetch(`http://pinned.example:${port}/slow`, { policy: OPEN, resolve, signal: controller.signal }), (e) => e.name === "AbortError");
    // the user policy refuses the same server outright
    await assert.rejects(net.safeFetch(`https://127.0.0.1:${port}/`, { policy: USER }), /not a public address/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// ---- per-account policy ---------------------------------------------------------------------

test("provider policy: private mode open; public mode users public+https only; admins public unless they opted in", () => {
  const user = { id: "u1", role: "user", privateNetwork: true };
  const admin = { id: "a1", role: "admin", privateNetwork: false };
  const owner = { id: "o1", role: "admin", privateNetwork: true };
  delete process.env.KNIFE_AUTH_MODE;
  assert.deepEqual(outbound.providerPolicy(user), OPEN);
  process.env.KNIFE_AUTH_MODE = "public";
  try {
    assert.deepEqual(outbound.providerPolicy(user), { allowPrivate: false, ports: null, httpsOnly: true }, "a user's privateNetwork flag is ignored");
    assert.deepEqual(outbound.providerPolicy(admin), { allowPrivate: false, ports: null, httpsOnly: false });
    assert.deepEqual(outbound.providerPolicy(owner), { allowPrivate: true, ports: null, httpsOnly: false });
    assert.equal(outbound.mayEchoUpstream(user), false);
    assert.equal(outbound.mayEchoUpstream(owner), true);
    assert.equal(outbound.strictHeaders(user), true);
    assert.equal(outbound.strictHeaders(admin), false);
  } finally {
    delete process.env.KNIFE_AUTH_MODE;
  }
});

test("outbound budget: public-mode users are rate limited per purpose, admins and private mode are not", () => {
  process.env.KNIFE_AUTH_MODE = "public";
  try {
    const user = { id: "budget-user", role: "user" };
    for (let i = 0; i < 20; i += 1) assert.equal(outbound.consumeOutbound(user, "provider-test").ok, true, `test ${i}`);
    const refused = outbound.consumeOutbound(user, "provider-test");
    assert.equal(refused.ok, false);
    assert.ok(refused.retryAfterSeconds > 0);
    assert.equal(outbound.consumeOutbound(user, "provider").ok, true, "separate bucket per purpose");
    for (let i = 0; i < 40; i += 1) outbound.consumeOutbound(user, "page");
    assert.equal(outbound.consumeOutbound(user, "page").ok, false);
    for (let i = 0; i < 50; i += 1) assert.equal(outbound.consumeOutbound({ id: "budget-admin", role: "admin" }, "page").ok, true);
  } finally {
    delete process.env.KNIFE_AUTH_MODE;
  }
  for (let i = 0; i < 50; i += 1) assert.equal(outbound.consumeOutbound({ id: "budget-user", role: "user" }, "provider-test").ok, true);
});

test("extra headers: the strict (public user) list refuses proxy, client-address, hop-by-hop and gateway headers", () => {
  const strictRefused = ["X-Forwarded-For", "x-forwarded-host", "Forwarded", "X-Real-IP", "X-Original-URL", "Proxy-Authorization", "TE", "Upgrade", "Via", "x-openclaw-model", "X-HTTP-Method-Override", "CF-Connecting-IP", "Keep-Alive"];
  for (const name of strictRefused) {
    assert.ok(provider.validateExtraHeaders({ [name]: "x" }, true), name);
    if (!["x-openclaw-model"].includes(name)) continue;
    assert.equal(provider.validateExtraHeaders({ [name]: "x" }, false), null, `${name} stays allowed for admins (gateway preset)`);
  }
  for (const name of ["Host", "Authorization", "Cookie", "Connection", "Transfer-Encoding", "Content-Length"]) assert.ok(provider.validateExtraHeaders({ [name]: "x" }, false), name);
  assert.equal(provider.validateExtraHeaders({ "HTTP-Referer": "https://example.com", "X-Title": "app", "x-opencode-session": "s1" }, true), null);
  assert.ok(provider.validateExtraHeaders({ "X-Ok": "a\r\nInjected: 1" }, true));
});

test("provider Test: refused for a user on loopback; raw bodies echoed only when allowed; JSON errors always", async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/json")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key" } }));
    } else {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<html>router admin page SECRET-INTERNAL</html>");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cfg = (path) => ({ baseUrl: `${base}${path}`, apiKey: "sk-test-123456789", model: "m" });
    const refused = await provider.testProvider(cfg("/v1"), { policy: USER, echoUpstream: false });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, null);
    assert.match(refused.error, /not allowed/);
    const hidden = await provider.testProvider(cfg("/v1"), { policy: OPEN, echoUpstream: false });
    assert.equal(hidden.status, 404);
    assert.ok(!hidden.error.includes("SECRET-INTERNAL"), hidden.error);
    const shown = await provider.testProvider(cfg("/v1"), { policy: OPEN, echoUpstream: true });
    assert.match(shown.error, /SECRET-INTERNAL/);
    const json = await provider.testProvider(cfg("/json"), { policy: OPEN, echoUpstream: false });
    assert.match(json.error, /HTTP 401: invalid api key/);
    assert.equal(await provider.baseUrlProblem(`${base}/v1`, OPEN), null);
    assert.match(await provider.baseUrlProblem(`${base}/v1`, USER), /only https/);
    assert.match(await provider.baseUrlProblem("https://127.0.0.1/v1", USER), /not a public address/);
  } finally {
    server.close();
  }
});

// ---- body limits ----------------------------------------------------------------------------

function streamingRequest(chunks, headers = {}, { onPull } = {}) {
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      onPull?.(index);
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
  });
  return new Request("http://knife.test/api/x", { method: "POST", headers, body, duplex: "half" });
}

test("readJsonBody: a declared Content-Length over the cap is refused without reading the body", async () => {
  const request = streamingRequest([new Uint8Array(10)], { "content-type": "application/json", "content-length": "5000" });
  const read = await httpMod.readJsonBody(request, 1024);
  assert.equal(read.response.status, 413);
  const body = await read.response.json();
  assert.equal(body.error, "payload_too_large");
  assert.match(body.message, /larger than 1 KB/);
  assert.equal(request.bodyUsed, false, "nothing read");
});

test("readJsonBody: a chunked body is cut off as soon as it passes the cap (never buffered whole)", async () => {
  let pulled = 0;
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  const chunks = Array.from({ length: 1000 }, () => chunk); // 64 MB if it were read to the end
  const read = await httpMod.readJsonBody(streamingRequest(chunks, { "content-type": "application/json" }, { onPull: () => { pulled += 1; } }), 256 * 1024);
  assert.equal(read.response.status, 413);
  assert.ok(pulled <= 7, `stopped after ${pulled} chunks`);
  const ok = await httpMod.readJsonBody(streamingRequest([new TextEncoder().encode('{"a":'), new TextEncoder().encode("1}")], { "content-type": "application/json" }), 1024);
  assert.deepEqual(ok.body, { a: 1 });
  const wrongType = await httpMod.readJsonBody(streamingRequest([new Uint8Array(1)], { "content-type": "text/plain" }), 1024);
  assert.equal(wrongType.response.status, 415);
});

test("withCappedBody: the request is re-created under the cap, refused over it", async () => {
  const ok = await httpMod.withCappedBody(streamingRequest([new TextEncoder().encode('{"jsonrpc":"2.0"}')], { "content-type": "application/json" }), 1024);
  assert.equal(await ok.request.text(), '{"jsonrpc":"2.0"}');
  const big = await httpMod.withCappedBody(streamingRequest([new Uint8Array(2048)], { "content-type": "application/json" }), 1024);
  assert.equal(big.response.status, 413);
});

function multipartBody(boundary, parts) {
  const enc = new TextEncoder();
  const pieces = [];
  for (const part of parts) {
    const disposition = part.filename !== undefined ? `form-data; name="${part.name}"; filename="${part.filename}"` : `form-data; name="${part.name}"`;
    pieces.push(enc.encode(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${part.filename !== undefined ? "Content-Type: application/pdf\r\n" : ""}\r\n`));
    pieces.push(typeof part.data === "string" ? enc.encode(part.data) : part.data);
    pieces.push(enc.encode("\r\n"));
  }
  pieces.push(enc.encode(`--${boundary}--\r\n`));
  return Buffer.concat(pieces);
}

function chunked(buffer, size) {
  const out = [];
  for (let i = 0; i < buffer.length; i += size) out.push(new Uint8Array(buffer.subarray(i, i + size)));
  return out;
}

test("multipart upload: streamed to disk, any chunking (boundary split across chunks), fields kept, names sanitised", async () => {
  const boundary = "----knifeBoundary7MA4YWxk";
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(70_000, 7), Buffer.from(`\r\n--${boundary.slice(0, 10)}not-a-delimiter\r\n`)]);
  const body = multipartBody(boundary, [
    { name: "action", data: "merge" },
    { name: "params", data: '{"a":1}' },
    { name: "file", filename: "../../etc/evil name.pdf", data: pdf },
    { name: "file", filename: "b.pdf", data: "%PDF-b" },
  ]);
  for (const size of [1, 7, 4096, body.length]) {
    const dir = mkdtempSync(join(tmpdir(), "knife-safenet-upload-"));
    try {
      const form = await upload.receiveMultipart(streamingRequest(chunked(body, size), { "content-type": `multipart/form-data; boundary=${boundary}` }), dir, { maxTotalBytes: 1_000_000, maxFileBytes: 500_000, maxFiles: 5 });
      assert.deepEqual([...form.fields.entries()], [["action", ["merge"]], ["params", ['{"a":1}']]], `chunk ${size}`);
      assert.equal(form.files.length, 2);
      assert.equal(form.files[0].name, "../../etc/evil name.pdf");
      assert.equal(form.files[0].path, join(dir, "1-evil_name.pdf"));
      assert.equal(form.files[0].size, pdf.length);
      assert.ok(readFileSync(form.files[0].path).equals(pdf), `file bytes intact (chunk ${size})`);
      assert.equal(readFileSync(form.files[1].path, "utf8"), "%PDF-b");
      assert.equal(statSync(form.files[0].path).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("multipart upload: request cap, file cap and file count are enforced while streaming", async () => {
  const boundary = "b0undary";
  const type = { "content-type": `multipart/form-data; boundary=${boundary}` };
  const big = multipartBody(boundary, [{ name: "file", filename: "a.pdf", data: Buffer.alloc(300_000, 1) }]);
  const cases = [
    { limits: { maxTotalBytes: 100_000, maxFileBytes: 1_000_000, maxFiles: 5 }, body: big, re: /Upload is over/ },
    { limits: { maxTotalBytes: 1_000_000, maxFileBytes: 100_000, maxFiles: 5, fileTooLarge: (n) => `${n} too big` }, body: big, re: /a\.pdf too big/ },
    { limits: { maxTotalBytes: 1_000_000, maxFileBytes: 100_000, maxFiles: 1 }, body: multipartBody(boundary, [{ name: "file", filename: "a.pdf", data: "1" }, { name: "file", filename: "b.pdf", data: "2" }]), re: /Too many files/ },
  ];
  for (const { limits, body, re } of cases) {
    const dir = mkdtempSync(join(tmpdir(), "knife-safenet-upload-"));
    let pulled = 0;
    try {
      await assert.rejects(upload.receiveMultipart(streamingRequest(chunked(body, 16 * 1024), type, { onPull: () => { pulled += 1; } }), dir, limits), (e) => e instanceof upload.UploadError && e.status === 413 && re.test(e.message));
      assert.ok(pulled < Math.ceil(body.length / (16 * 1024)) + 1 || re.source.includes("Too many"), "stopped before the end");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const declared = mkdtempSync(join(tmpdir(), "knife-safenet-upload-"));
  await assert.rejects(upload.receiveMultipart(streamingRequest([], { ...type, "content-length": "999999999" }), declared, { maxTotalBytes: 1000, maxFileBytes: 1000, maxFiles: 1 }), /Upload is over/);
  await assert.rejects(upload.receiveMultipart(streamingRequest([], { "content-type": "application/json" }), declared, { maxTotalBytes: 1000, maxFileBytes: 1000, maxFiles: 1 }), (e) => e.status === 415);
  await assert.rejects(upload.receiveMultipart(streamingRequest([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\nunterminated`)], type), declared, { maxTotalBytes: 1000, maxFileBytes: 1000, maxFiles: 1 }), (e) => e.status === 400);
  rmSync(declared, { recursive: true, force: true });
});

// ---- provider keys at rest ------------------------------------------------------------------

test("provider keys: plaintext migrated on first read, sealed on disk (0600 key), opened in memory, CLI interop, AAD bound", () => {
  const dir = mkdtempSync(join(tmpdir(), "knife-safenet-keys-"));
  const previous = process.env.KNIFE_DATA_DIR;
  process.env.KNIFE_DATA_DIR = dir;
  try {
    const file = join(dir, "accounts.json");
    const KEY_A = "sk-live-AAAAAAAAAAAAAAAA";
    const KEY_B = "sk-live-BBBBBBBBBBBBBBBB";
    writeFileSync(file, JSON.stringify({
      version: 2,
      defaultAccountId: "genor",
      accounts: [
        { id: "genor", displayName: "Genor", provider: { baseUrl: "http://127.0.0.1:1234/v1", apiKey: KEY_A, model: "m", extraHeaders: { "X-Api-Key": "hdr-secret-1" } }, createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "bob", displayName: "Bob", provider: { baseUrl: "https://api.example/v1", apiKey: KEY_B, model: "m" }, createdAt: "2026-01-01T00:00:00.000Z", role: "user" },
        { id: "nokey", displayName: "No key", provider: { baseUrl: "http://127.0.0.1:1234/v1", apiKey: "", model: "m" }, createdAt: "2026-01-01T00:00:00.000Z" },
      ],
    }), { mode: 0o600 });
    const read = store.readStore();
    assert.equal(read.accounts[0].provider.apiKey, KEY_A);
    assert.equal(read.accounts[0].provider.extraHeaders["X-Api-Key"], "hdr-secret-1");
    const raw = readFileSync(file, "utf8");
    assert.ok(!raw.includes(KEY_A) && !raw.includes(KEY_B) && !raw.includes("hdr-secret-1"), "resealed by the first read");
    assert.match(JSON.parse(raw).accounts[1].provider.apiKey, /^enc:v1:/);
    assert.equal(JSON.parse(raw).accounts[2].provider.apiKey, "", "an empty key stays empty");
    assert.equal(statSync(join(dir, "provider-keys.key")).mode & 0o777, 0o600);
    assert.equal(store.getAccount("bob").provider.apiKey, KEY_B);
    // a mutation keeps them sealed and readable
    store.setProvider("bob", { baseUrl: "https://api.example/v1", apiKey: "sk-new-CCCCCCCCCCCC", model: "m2" });
    assert.ok(!readFileSync(file, "utf8").includes("sk-new-CCCCCCCCCCCC"));
    assert.equal(store.getAccount("bob").provider.apiKey, "sk-new-CCCCCCCCCCCC");
    // the CLI opens what the server sealed
    const cli = spawnSync(process.execPath, ["scripts/accounts.mjs", "provider-json", "genor"], { env: { ...process.env, KNIFE_DATA_DIR: dir }, encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).apiKey, KEY_A);
    // a sealed value moved to another account does not open (AAD = account + field)
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.accounts[1].provider.apiKey = doc.accounts[0].provider.apiKey;
    writeFileSync(file, JSON.stringify(doc), { mode: 0o600 });
    assert.throws(() => store.readStore(), /does not decrypt/);
    // a missing key file is an error, never a silent empty key
    doc.accounts[1].provider.apiKey = "";
    writeFileSync(file, JSON.stringify(doc), { mode: 0o600 });
    rmSync(join(dir, "provider-keys.key"));
    assert.throws(() => store.readStore(), /provider-keys\.key is missing/);
    assert.ok(!readdirSync(dir).some((name) => name.endsWith(".tmp")));
  } finally {
    process.env.KNIFE_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(existsSync(dataDir));
});

// ---- python lane ----------------------------------------------------------------------------

test("python lane: minimal child env (no server secrets), HOME = scratch, per-lane resource limits", async () => {
  process.env.KNIFE_SMTP_PASS = "smtp-secret";
  process.env.OPENCLAW_GATEWAY_TOKEN = "gw-secret";
  try {
    const python = await import("../src/lib/python.ts");
    const env = python.childEnv("/tmp/knife-scratch-x", python.laneLimits("heavy", 180_000));
    assert.equal(env.HOME, "/tmp/knife-scratch-x");
    assert.ok(env.PATH);
    for (const leaked of ["KNIFE_SMTP_PASS", "OPENCLAW_GATEWAY_TOKEN", "KNIFE_DATA_DIR", "KNIFE_SSRF_DENY_CIDRS"]) assert.equal(env[leaked], undefined, leaked);
    assert.equal(env.KNIFE_RLIMIT_AS_MB, "3072");
    assert.equal(env.KNIFE_RLIMIT_CPU_SEC, "365");
    assert.equal(python.laneLimits("light", 30_000).KNIFE_RLIMIT_AS_MB, "1024");
    process.env.KNIFE_PY_MEM_MB_LIGHT = "0";
    assert.equal(python.laneLimits("light", 30_000).KNIFE_RLIMIT_AS_MB, "0", "0 = no limit");
  } finally {
    delete process.env.KNIFE_SMTP_PASS;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.KNIFE_PY_MEM_MB_LIGHT;
  }
});

// ---- security headers -----------------------------------------------------------------------

test("security headers: CSP allows exactly what the app needs, frames only the editor origin, HSTS only for https", async () => {
  const { securityHeaders, sidecarOrigins, originOf } = await import("../scripts/security-headers.mjs");
  const map = (list) => Object.fromEntries(list);
  const prod = map(securityHeaders({ publicUrl: "https://knife.example.org", frameOrigins: ["https://office.example.org"] }));
  const csp = prod["Content-Security-Policy"];
  for (const part of ["default-src 'self'", "frame-ancestors 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "worker-src 'self' blob:", "'wasm-unsafe-eval'", "upgrade-insecure-requests"]) assert.ok(csp.includes(part), part);
  assert.match(csp, /frame-src 'self' blob: https:\/\/office\.example\.org/);
  assert.match(csp, /script-src [^;]*https:\/\/office\.example\.org/);
  assert.match(csp, /connect-src 'self' https:\/\/office\.example\.org(;|$)/);
  assert.equal(prod["Strict-Transport-Security"], "max-age=15552000");
  assert.equal(prod["X-Content-Type-Options"], "nosniff");
  const plain = map(securityHeaders({ publicUrl: "http://100.64.0.7:3210", dev: true }));
  assert.equal(plain["Strict-Transport-Security"], undefined);
  assert.ok(!plain["Content-Security-Policy"].includes("upgrade-insecure-requests"));
  assert.match(plain["Content-Security-Policy"], /connect-src 'self' ws: wss:/);
  assert.equal(originOf("javascript:alert(1)"), null);
  const dir = mkdtempSync(join(tmpdir(), "knife-safenet-csp-"));
  try {
    assert.deepEqual(sidecarOrigins(dir), []);
    const services = join(dir, "services", "office");
    (await import("node:fs")).mkdirSync(services, { recursive: true });
    writeFileSync(join(services, "state.json"), JSON.stringify({ bindHost: "100.64.0.7", hostPort: 3211 }));
    assert.deepEqual(sidecarOrigins(dir), ["http://100.64.0.7:3211"]);
    writeFileSync(join(services, "state.json"), JSON.stringify({ bindHost: "100.64.0.7", hostPort: 3211, publicUrl: "https://office.example.org/" }));
    assert.deepEqual(sidecarOrigins(dir), ["https://office.example.org"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CSP office origin in public mode (host audit M3): only an https KNIFE_OFFICE_PUBLIC_URL on a public name, never the state file", async () => {
  const { officeOrigins, sidecarOrigins, extraFrameOrigins, isPrivateHost, publicOriginVerdict } = await import("../scripts/security-headers.mjs");
  const dir = mkdtempSync(join(tmpdir(), "knife-safenet-csp-public-"));
  try {
    const services = join(dir, "services", "office");
    (await import("node:fs")).mkdirSync(services, { recursive: true });
    // The live incident: the state file named the dev server's Tailscale address and port.
    writeFileSync(join(services, "state.json"), JSON.stringify({ bindHost: "100.64.0.7", hostPort: 3212, publicUrl: "http://100.64.0.7:3212" }));
    const pub = { KNIFE_AUTH_MODE: "public" };
    assert.deepEqual(officeOrigins(dir, pub), { origins: [], warning: null }, "no office URL configured: no origin at all (fail closed)");
    assert.deepEqual(sidecarOrigins(dir, pub), []);
    assert.deepEqual(sidecarOrigins(dir, { KNIFE_AUTH_MODE: "Public " }), [], "any non-private mode value is public");
    assert.deepEqual(sidecarOrigins(dir, { ...pub, KNIFE_OFFICE_PUBLIC_URL: "https://office.example.org/editor" }), ["https://office.example.org"]);
    for (const bad of ["http://office.example.org", "https://100.64.0.7:3212", "https://10.1.2.3", "https://[::1]:8443", "https://[fd12::1]", "https://[::ffff:192.168.1.5]",
      "https://localhost", "https://box.local", "https://office.tailnet-x.ts.net", "https://intranet", "https://user:pw@office.example.org", "javascript:alert(1)", "not a url"]) {
      const result = officeOrigins(dir, { ...pub, KNIFE_OFFICE_PUBLIC_URL: bad });
      assert.deepEqual(result.origins, [], bad);
      assert.match(result.warning, /KNIFE_OFFICE_PUBLIC_URL .*left out of the CSP/, bad);
    }
    // KNIFE_CSP_FRAME_ORIGINS gets the same rule in public mode; private mode keeps every http(s) origin.
    const extra = "https://embed.example.org, http://plain.example.org https://192.168.1.9 javascript:x";
    assert.deepEqual(extraFrameOrigins({ ...pub, KNIFE_CSP_FRAME_ORIGINS: extra }), { origins: ["https://embed.example.org"], dropped: ["http://plain.example.org", "https://192.168.1.9", "javascript:x"] });
    assert.deepEqual(extraFrameOrigins({ KNIFE_CSP_FRAME_ORIGINS: extra }).origins, ["https://embed.example.org", "http://plain.example.org", "https://192.168.1.9"]);
    // Private mode is unchanged: the state file's publicUrl, else bind:port.
    assert.deepEqual(sidecarOrigins(dir, {}), ["http://100.64.0.7:3212"]);
    assert.deepEqual(sidecarOrigins(dir, { KNIFE_AUTH_MODE: "private", KNIFE_OFFICE_PUBLIC_URL: "http://100.64.0.7:3299" }), ["http://100.64.0.7:3299"]);
    for (const [host, expected] of [["8.8.8.8", false], ["office.example.org", false], ["[2001:db8::1]", false], ["172.20.0.1", true], ["169.254.169.254", true], ["0.0.0.0", true], ["", true]]) {
      assert.equal(isPrivateHost(host), expected, host);
    }
    assert.equal(publicOriginVerdict("https://office.example.org:8443/x").origin, "https://office.example.org:8443");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
