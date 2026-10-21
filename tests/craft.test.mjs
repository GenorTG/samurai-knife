// ArtCraft sidecar (`craft`): the pinned app definitions, compose rendering (read-only nginx, no capabilities, the assets
// mount, the generated config in `command`), the nginx.conf (MIME, caching per the apps' hosting notes, CSP and
// frame-ancestors), release download + verification + unpacking against a fake fetch, pruning, the launch URLs with
// tickets, the ArtCraft proxy (scripts/craft-proxy.mjs) against a fake nginx, and the app CSP's frame-src.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/craft.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { parse } from "yaml";

const dataDir = mkdtempSync(join(tmpdir(), "knife-craft-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_HOST = "100.64.0.7";
process.env.KNIFE_PORT = "3210";
for (const name of ["KNIFE_SIDECAR_PREFIX", "KNIFE_CRAFT_PUBLIC_URL", "KNIFE_OFFICE_PUBLIC_URL", "KNIFE_PUBLIC_URL", "KNIFE_ALLOWED_HOSTS", "KNIFE_AUTH_MODE"]) delete process.env[name];
process.env.KNIFE_CRAFT_PROXY_INSTALL = "0";
process.env.KNIFE_OFFICE_PROXY_INSTALL = "0";
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { findSidecar, ARTCRAFT_APPS } = await import("../src/lib/services/definitions.ts");
const { renderCompose } = await import("../src/lib/services/compose.ts");
const sites = await import("../src/lib/services/sites.ts");
const { writeZip } = await import("../src/lib/office/zip.ts");
const state = await import("../src/lib/services/state.ts");
const { bindHostFor, composeHashOf } = await import("../src/lib/services/manager.ts");
const urls = await import("../src/lib/services/urls.ts");
const { craftLaunch, craftTicket } = await import("../src/lib/craft/launch.ts");
const proxyMod = await import("../scripts/craft-proxy.mjs");
const { craftPath, createCraftProxy, craftTicketKey, signCraftTicket, COOKIE_NAME } = proxyMod;
const { verifyTicket } = await import("../scripts/office-proxy.mjs");
const { craftOrigins, securityHeaders } = await import("../scripts/security-headers.mjs");

const craft = findSidecar("craft");
const silent = { phase() {}, log() {} };

/* ------------------------------------------------------------------------------------------- definition */

test("definition: seven pinned apps (https release URL, sha256, size), the sandbox each README asks for", () => {
  assert.deepEqual(ARTCRAFT_APPS.map((app) => app.id), ["photocraft", "vectorcraft", "filmcraft", "lightcraft", "effectcraft", "designcraft", "pdfcraft"]);
  for (const app of ARTCRAFT_APPS) {
    assert.match(app.sha256, /^[0-9a-f]{64}$/, app.id);
    assert.equal(app.url, `https://github.com/storytold/${app.id}/releases/download/v${app.version}/${app.id}-web-${app.version}.zip`);
    assert.ok(app.bytes > 1_000_000, app.id);
    for (const token of ["allow-scripts", "allow-same-origin", "allow-downloads", "allow-popups"]) assert.ok(app.sandbox.includes(token), `${app.id} ${token}`);
    assert.ok(!app.sandbox.includes("allow-top-navigation") && !app.sandbox.includes("allow-forms"), `${app.id}: nothing beyond the README`);
  }
  // LightCraft's confirmations (restore, ?reset) need modals; it draws with WebGL2 only.
  const light = ARTCRAFT_APPS.find((app) => app.id === "lightcraft");
  assert.ok(light.sandbox.includes("allow-modals"));
  assert.equal(light.webgpu, false);
  assert.deepEqual([craft.security.capAdd, craft.security.pidsLimit, craft.memLimit, craft.callsBack], [[], 64, "256m", false]);
  assert.match(craft.image, /^nginxinc\/nginx-unprivileged:[\w.-]+@sha256:[0-9a-f]{64}$/, "pinned by digest");
  assert.deepEqual(craft.usedBy, ["artcraft"]);
});

test("compose: read-only root with a tmpfs, no capabilities, fixed entrypoint + generated config, assets mounted read-only", () => {
  const command = sites.sitesConfig(craft).command;
  const svc = parse(renderCompose(craft, { bindHost: "100.64.0.7", hostPort: 3215, command })).services.nginx;
  assert.equal(svc.read_only, true);
  assert.deepEqual(svc.tmpfs, ["/tmp:size=64m,mode=1777"]);
  assert.deepEqual(svc.cap_drop, ["ALL"]);
  assert.equal(svc.cap_add, undefined);
  assert.deepEqual(svc.security_opt, ["no-new-privileges:true"]);
  assert.equal(svc.pids_limit, 64);
  assert.deepEqual(svc.entrypoint, ["nginx"]);
  assert.match(command.join(" "), /^-c \/srv\/craft\/conf-[0-9a-f]{12}\/nginx\.conf$/);
  assert.deepEqual(svc.command, command);
  assert.deepEqual(svc.volumes, ["./assets:/srv/craft:ro"]);
  assert.deepEqual(svc.ports, ["100.64.0.7:3215:8080"]);
  assert.deepEqual(svc.healthcheck.test, ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]);
  assert.equal(svc.env_file[0], "secrets.env");
});

test("addresses: own port on KNIFE_HOST in private mode; loopback + the craft host while KNIFE_CRAFT_PUBLIC_URL is set", () => {
  assert.equal(bindHostFor(craft), "100.64.0.7");
  assert.equal(urls.craftProxyUrl(), null);
  process.env.KNIFE_CRAFT_PUBLIC_URL = "https://craft.knife.example.org/ignored/path";
  try {
    assert.equal(bindHostFor(craft), "127.0.0.1");
    assert.equal(urls.craftProxyUrl(), "https://craft.knife.example.org");
    assert.equal(urls.publicUrl({ id: "craft", bindHost: "127.0.0.1", hostPort: 3215 }), "https://craft.knife.example.org");
    assert.equal(bindHostFor(findSidecar("office")), "100.64.0.7", "the office editor is not affected");
  } finally {
    delete process.env.KNIFE_CRAFT_PUBLIC_URL;
  }
  assert.deepEqual(urls.appOrigins({ KNIFE_HOST: "100.64.0.7", KNIFE_PORT: "3212", KNIFE_ALLOWED_HOSTS: "box.tail.ts.net" }), [
    "http://localhost:3212", "http://127.0.0.1:3212", "http://100.64.0.7:3212", "http://box.tail.ts.net:3212",
  ]);
  assert.deepEqual(urls.appOrigins({ KNIFE_HOST: "172.17.0.1", KNIFE_PUBLIC_URL: "https://knife.example.org/" }), ["https://knife.example.org"]);
});

/* ------------------------------------------------------------------------------------------- nginx.conf */

test("nginx.conf: wasm MIME, gzip_static, GET/HEAD only, CSP for WebAssembly, frame-ancestors = the app's origins", () => {
  const conf = sites.renderNginxConf(craft, ["https://knife.example.org"]);
  assert.match(conf, /application\/wasm wasm;/);
  assert.match(conf, /text\/javascript js mjs;/);
  assert.match(conf, /gzip_static on;/);
  assert.match(conf, /gzip off;/);
  assert.match(conf, /absolute_redirect off;/);
  assert.match(conf, /\$request_method !~ \^\(GET\|HEAD\)\$/);
  assert.match(conf, /location ~ \/\\\. \{ return 404; \}/, "dotfiles are 404");
  assert.match(conf, /pid \/tmp\/nginx\.pid;/);
  assert.doesNotMatch(conf, /Set-Cookie|add_header Set-Cookie/i);
  assert.doesNotMatch(conf, /Cross-Origin-Opener-Policy/, "plain http: browsers ignore COOP (Chromium logs an error)");
  assert.match(sites.renderNginxConf(craft, ["https://knife.example.org"], { https: true }), /Cross-Origin-Opener-Policy "same-origin"/);
  assert.match(sites.sitesConfig(craft, { KNIFE_CRAFT_PUBLIC_URL: "https://craft.knife.example.org", KNIFE_PUBLIC_URL: "https://knife.example.org" }).conf, /Cross-Origin-Opener-Policy/);
  for (const app of ARTCRAFT_APPS) {
    assert.ok(conf.includes(`location /${app.id}/ {\n      root /srv/craft/${sites.siteFolder(app)};`), app.id);
    assert.ok(conf.includes(`location = /${app.id} { return 301 /${app.id}/; }`), app.id);
  }
  const csp = sites.siteCsp(["https://knife.example.org"]);
  assert.match(csp, /script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'/);
  assert.match(csp, /worker-src 'self' blob:/);
  assert.match(csp, /frame-ancestors https:\/\/knife\.example\.org$/);
  assert.doesNotMatch(csp, /'unsafe-eval'|https:\s|\*/);
  assert.equal(sites.siteCsp([]).endsWith("frame-ancestors 'none'"), true);
  // Changing who may frame the apps changes the config folder, the command and so the compose hash (recreate on ensure).
  const a = sites.sitesConfig(craft, { KNIFE_HOST: "100.64.0.7", KNIFE_PORT: "3210" });
  const b = sites.sitesConfig(craft, { KNIFE_HOST: "100.64.0.7", KNIFE_PORT: "3212" });
  assert.notEqual(a.folder, b.folder);
  assert.notDeepEqual(a.command, b.command);
});

test("caching: hash-named files immutable, files that keep their names revalidate (each app's hosting notes)", () => {
  // nginx matches these PCRE patterns against the full URI; JavaScript's RegExp reads them the same way.
  const cached = (id, path) => {
    const app = ARTCRAFT_APPS.find((candidate) => candidate.id === id);
    return app.immutable.some((pattern) => new RegExp(sites.immutableLocation(app, pattern)).test(`/${id}${path}`));
  };
  const cases = [
    ["photocraft", "/app/photocraft-web-45b1ceab367af014.part-aa", true],
    ["photocraft", "/photocraft-web-boot-d93edd26fc524094_bg.wasm", true],
    ["photocraft", "/photocraft-web-boot-d93edd26fc524094.js", true],
    ["photocraft", "/app/photocraft-web.js", false],
    ["photocraft", "/app/parts.txt", false],
    ["photocraft", "/index.html", false],
    ["photocraft", "/", false],
    ["vectorcraft", "/vectorcraft-web-d0094b3b031c2f0c_bg.wasm", true],
    ["vectorcraft", "/fonts/63111b5b2e074dd4/NotoSansArabic.ttf", true],
    ["vectorcraft", "/index.html", false],
    ["filmcraft", "/filmcraft_web_bg.wasm", true],
    ["filmcraft", "/index.html", false],
    ["lightcraft", "/lightcraft_web_bg.wasm", false],
    ["lightcraft", "/worker.js", false],
    ["effectcraft", "/effectcraft_web_bg.wasm", false],
    ["effectcraft", "/sw.js", false],
    ["designcraft", "/designcraft-web-92f623d7d2fa3eba_bg.wasm", true],
    ["pdfcraft", "/pdfcraft-web-5c41d0edd9acf531.js", true],
    ["pdfcraft", "/pdfcraft-web.js", false],
  ];
  for (const [id, path, expected] of cases) assert.equal(cached(id, path), expected, `${id}${path}`);
});

/* ------------------------------------------------------------------------------------------- download + unpack */

function fakeRelease(id, version, files) {
  const zip = writeZip([
    { name: `${id}-web-${version}/`, data: "", store: true },
    ...Object.entries(files).map(([name, data]) => ({ name: `${id}-web-${version}/${name}`, data })),
  ]);
  return { zip, sha256: createHash("sha256").update(zip).digest("hex") };
}

function fakeDef(id, apps) {
  return { ...craft, id, sites: { ...craft.sites, apps } };
}

function fakeFetch(map, calls = []) {
  return async (url) => {
    calls.push(url);
    const body = map.get(url);
    if (!body) return new Response("missing", { status: 404 });
    return new Response(body, { status: 200 });
  };
}

test("installSites: verified download, unpacked under <app>-<version>-<sha12>/<app>/, .gz twins, dotfiles skipped, pruned on update", async () => {
  const big = "console.log('x');\n".repeat(200);
  const v1 = fakeRelease("democraft", "1.0.0", {
    "index.html": `<!doctype html><title>demo</title>${" ".repeat(2048)}`,
    "demo-0123456789abcdef_bg.wasm": Buffer.alloc(4096, 7),
    "app/glue.js": big,
    "app/x.part-aa": Buffer.alloc(3000, 1),
    ".htaccess": "deny",
    "fonts/abc/Font.ttf": Buffer.alloc(10, 2),
  });
  const app = { ...ARTCRAFT_APPS[6], id: "democraft", name: "DemoCraft", version: "1.0.0", url: "https://example.invalid/democraft-1.zip", sha256: v1.sha256, bytes: v1.zip.length };
  const def = fakeDef("craft-demo", [app]);
  const calls = [];
  const progress = [];
  const installed = await sites.installSites(def, { phase: (text, percent) => progress.push([text, percent]), log() {} }, fakeFetch(new Map([[app.url, v1.zip]]), calls));
  assert.deepEqual(installed, ["democraft"]);
  const root = join(dataDir, "services", "craft-demo", "assets", sites.siteFolder(app), "democraft");
  assert.equal(readFileSync(join(root, "app", "glue.js"), "utf8"), big);
  assert.equal(gunzipSync(readFileSync(join(root, "app", "glue.js.gz"))).toString("utf8"), big, "gzip twin of the glue");
  assert.ok(existsSync(join(root, "demo-0123456789abcdef_bg.wasm.gz")));
  assert.ok(!existsSync(join(root, "app", "x.part-aa.gz")), "the gzipped parts are served as they are");
  assert.ok(!existsSync(join(root, ".htaccess")), "dotfiles are not unpacked");
  assert.ok(!existsSync(join(root, "fonts", "abc", "Font.ttf.gz")), "files under 1 KB get no twin");
  assert.ok(!existsSync(join(dataDir, "services", "craft-demo", "downloads")), "the zip is deleted after unpacking");
  assert.ok(progress.some(([, percent]) => percent === 100));
  // Nothing missing now: no second download.
  assert.deepEqual(await sites.installSites(def, silent, fakeFetch(new Map(), calls)), []);
  assert.equal(calls.length, 1);

  // An update pins 1.1.0: the new folder is added next to the old one; pruneSites drops the old version and old configs.
  sites.writeSitesConf(def);
  const v2 = fakeRelease("democraft", "1.1.0", { "index.html": "<!doctype html>v2" });
  const app2 = { ...app, version: "1.1.0", url: "https://example.invalid/democraft-2.zip", sha256: v2.sha256, bytes: v2.zip.length };
  const def2 = fakeDef("craft-demo", [app2]);
  await sites.installSites(def2, silent, fakeFetch(new Map([[app2.url, v2.zip]])));
  sites.writeSitesConf(def2);
  const assets = join(dataDir, "services", "craft-demo", "assets");
  assert.equal(readdirSync(assets).length, 4, "two versions + two configs before pruning");
  const removed = sites.pruneSites(def2);
  assert.deepEqual(readdirSync(assets).sort(), [sites.sitesConfig(def2).folder, sites.siteFolder(app2)].sort());
  assert.equal(removed.length, 2);
});

test("installSites: a download that does not match the pin (hash, size) or a malformed release unpacks nothing", async () => {
  const good = fakeRelease("badcraft", "1.0.0", { "index.html": "<!doctype html>" });
  const app = { ...ARTCRAFT_APPS[6], id: "badcraft", name: "BadCraft", version: "1.0.0", url: "https://example.invalid/bad.zip", sha256: good.sha256, bytes: good.zip.length };
  const assets = join(dataDir, "services", "craft-bad", "assets");
  const tampered = Buffer.from(good.zip);
  tampered[tampered.length - 30] ^= 1;
  await assert.rejects(sites.installSites(fakeDef("craft-bad", [app]), silent, fakeFetch(new Map([[app.url, tampered]]))), /does not match the pinned release/);
  await assert.rejects(sites.installSites(fakeDef("craft-bad", [app]), silent, fakeFetch(new Map([[app.url, Buffer.concat([good.zip, Buffer.alloc(10)])]]))), /larger than the pinned/);
  await assert.rejects(sites.installSites(fakeDef("craft-bad", [app]), silent, fakeFetch(new Map())), /HTTP 404/);
  // Correctly pinned but unexpected content: an entry outside the release folder, a traversal name, no index.html.
  for (const [files, message] of [
    [{ "../../evil.js": "x" }, /entry name not allowed/],
    [{ "a/b c.js": "x" }, /entry name not allowed/],
    [{ "main.js": "x" }, /no index\.html/],
  ]) {
    const release = fakeRelease("badcraft", "1.0.0", files);
    const pinned = { ...app, sha256: release.sha256, bytes: release.zip.length };
    await assert.rejects(sites.installSites(fakeDef("craft-bad", [pinned]), silent, fakeFetch(new Map([[app.url, release.zip]]))), message);
  }
  const foreign = writeZip([{ name: "othercraft-web-1.0.0/index.html", data: "x" }]);
  const pinned = { ...app, sha256: createHash("sha256").update(foreign).digest("hex"), bytes: foreign.length };
  await assert.rejects(sites.installSites(fakeDef("craft-bad", [pinned]), silent, fakeFetch(new Map([[app.url, foreign]]))), /unexpected entry/);
  assert.deepEqual(existsSync(assets) ? readdirSync(assets) : [], [], "nothing half-unpacked is left");
  assert.equal(sites.siteEntryPath(app, "badcraft-web-1.0.0/"), null);
  assert.equal(sites.siteEntryPath(app, "badcraft-web-1.0.0/app/x.js"), "app/x.js");
});

test("compose hash: a new pinned version changes the config, so a running container is recreated at the next ensure", () => {
  const st = { id: "craft", image: craft.image, bindHost: "100.64.0.7", hostPort: 3215, idleStopMinutes: 30, installedAt: "x", updatedAt: "x" };
  const bumped = { ...craft, sites: { ...craft.sites, apps: craft.sites.apps.map((app, i) => (i === 0 ? { ...app, version: "9.9.9" } : app)) } };
  assert.notEqual(composeHashOf(craft, st), composeHashOf(bumped, st));
});

/* ------------------------------------------------------------------------------------------- launch + proxy */

test("launch: private mode = the sidecar's own origin without tickets; KNIFE_CRAFT_PUBLIC_URL = the craft host with a ticket the proxy accepts", () => {
  assert.equal(craftLaunch("genor"), null, "not installed");
  state.ensureSecrets(craft);
  state.writeState({ id: "craft", image: craft.image, bindHost: "100.64.0.7", hostPort: 3215, idleStopMinutes: 30, installedAt: "x", updatedAt: "x" });
  const plain = craftLaunch("genor");
  assert.equal(plain.origin, "http://100.64.0.7:3215");
  assert.equal(plain.proxied, false);
  assert.equal(plain.apps.find((app) => app.id === "pdfcraft").url, "http://100.64.0.7:3215/pdfcraft/");
  process.env.KNIFE_CRAFT_PUBLIC_URL = "https://craft.knife.example.org";
  try {
    const proxied = craftLaunch("alice");
    assert.equal(proxied.proxied, true);
    const url = new URL(proxied.apps[0].url);
    assert.equal(url.origin + url.pathname, "https://craft.knife.example.org/photocraft/");
    const secret = state.ensureSecrets(craft).TICKET_SECRET;
    assert.equal(verifyTicket(craftTicketKey(secret), url.searchParams.get("knife_ticket"))?.account, "alice");
  } finally {
    delete process.env.KNIFE_CRAFT_PUBLIC_URL;
  }
  const now = Math.floor(Date.now() / 1000);
  assert.equal(craftTicket("bob", "s3cret", now), signCraftTicket(craftTicketKey("s3cret"), "bob", 12 * 3600, now), "same format as the proxy");
  assert.equal(verifyTicket(craftTicketKey("other"), craftTicket("bob", "s3cret", now), now), null);
});

test("proxy paths: /<app>/<file> only, plainly written", () => {
  for (const ok of ["/photocraft/", "/photocraft", "/photocraft/app/photocraft-web-45b1ceab367af014.part-aa", "/vectorcraft/fonts/63111b5b2e074dd4/NotoSansArabic.ttf", "/filmcraft/filmcraft_web.js?v=abc"]) assert.ok(craftPath(ok), ok);
  for (const bad of ["/", "/photocraft/../x", "/photocraft/%2e%2e/x", "/photocraft//x", "/photocraft/a\\b", "/Photo/", "photocraft/", "http://evil/photocraft/", "/photocraft/a b"]) assert.equal(craftPath(bad), null, bad);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function request(port, path, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { host: "craft.knife.example.org", ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("proxy: ticket -> 303 without it + HttpOnly cookie; cookie gate; only cache headers reach nginx; Set-Cookie dropped; GET/HEAD only", async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers, method: req.method });
    res.writeHead(200, { "content-type": "application/wasm", "set-cookie": "x=1", server: "nginx", "content-security-policy": "frame-ancestors https://knife.example.org", etag: '"1"' });
    res.end(req.method === "HEAD" ? undefined : "wasm-bytes");
  });
  const upstreamPort = await listen(upstream);
  const key = craftTicketKey("secret-1");
  let current = { upstream: { host: "127.0.0.1", port: upstreamPort }, key };
  const proxy = createCraftProxy({ craftUrl: "https://craft.knife.example.org", config: () => current, trusted: [], log: () => {}, limits: { refusedPerMinute: 1000 } });
  const front = http.createServer((req, res) => (proxy.matches(req) ? proxy.handleRequest(req, res) : res.end("next")));
  front.on("upgrade", (req, socket) => proxy.handleUpgrade(req, socket));
  const port = await listen(front);
  try {
    assert.equal((await request(port, "/photocraft/", { headers: { host: "app.knife.example.org" } })).body, "next", "other hosts go to Next");
    const ticket = signCraftTicket(key, "alice");
    const redirect = await request(port, `/photocraft/?webgl&knife_ticket=${encodeURIComponent(ticket)}`);
    assert.equal(redirect.status, 303);
    assert.equal(redirect.headers.location, "/photocraft/?webgl=");
    assert.match(redirect.headers["set-cookie"][0], new RegExp(`^${COOKIE_NAME}=v1\\.[^;]+; Path=/; Max-Age=\\d+; HttpOnly; SameSite=Strict; Secure$`));
    assert.equal(redirect.headers["cache-control"], "no-store");
    assert.equal(seen.length, 0, "the ticket request never reaches nginx");

    assert.equal((await request(port, "/photocraft/")).status, 403, "no cookie");
    assert.equal((await request(port, "/photocraft/", { headers: { cookie: `${COOKIE_NAME}=forged` } })).status, 403);
    assert.equal((await request(port, `/photocraft/?knife_ticket=${encodeURIComponent(signCraftTicket(craftTicketKey("other"), "alice"))}`)).status, 403, "foreign ticket");

    const ok = await request(port, "/photocraft/x_bg.wasm", {
      headers: { cookie: `other=1; ${COOKIE_NAME}=${ticket}`, "accept-encoding": "gzip", "if-none-match": '"0"', authorization: "Bearer x", "x-forwarded-for": "1.2.3.4", "x-knife-peer": "1.1.1.1" },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, "wasm-bytes");
    assert.equal(ok.headers["set-cookie"], undefined);
    assert.equal(ok.headers.server, undefined);
    assert.equal(ok.headers["strict-transport-security"], "max-age=15552000");
    assert.equal(ok.headers["content-security-policy"], "frame-ancestors https://knife.example.org", "nginx's CSP passes through");
    const got = seen.at(-1);
    assert.equal(got.url, "/photocraft/x_bg.wasm");
    assert.deepEqual(Object.keys(got.headers).filter((name) => !["host", "connection"].includes(name)).sort(), ["accept-encoding", "if-none-match"]);

    assert.equal((await request(port, "/photocraft/", { method: "HEAD", headers: { cookie: `${COOKIE_NAME}=${ticket}` } })).status, 200);
    assert.equal((await request(port, "/photocraft/", { method: "POST", headers: { cookie: `${COOKIE_NAME}=${ticket}` } })).status, 405);
    assert.equal((await request(port, "/photocraft/../etc/passwd", { headers: { cookie: `${COOKIE_NAME}=${ticket}` } })).status, 404);

    // Websockets are refused.
    const answer = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write("GET /photocraft/ HTTP/1.1\r\nHost: craft.knife.example.org\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"));
      let text = "";
      socket.on("data", (chunk) => (text += chunk));
      socket.on("close", () => resolve(text));
    });
    assert.match(answer, /^HTTP\/1\.1 404/);

    // Sidecar stopped / not installed.
    current = { upstream: { host: "127.0.0.1", port: 1 }, key };
    assert.equal((await request(port, "/photocraft/", { headers: { cookie: `${COOKIE_NAME}=${ticket}` } })).status, 503);
    current = { upstream: null, key: null };
    assert.equal((await request(port, "/photocraft/", { headers: { cookie: `${COOKIE_NAME}=${ticket}` } })).status, 503);
  } finally {
    front.close();
    upstream.close();
    front.closeAllConnections?.();
    upstream.closeAllConnections?.();
  }
});

test("proxy: refused requests are budgeted per client address (then 429)", async () => {
  const proxy = createCraftProxy({ craftUrl: "http://craft.knife.test", config: () => ({ upstream: { host: "127.0.0.1", port: 1 }, key: craftTicketKey("k") }), trusted: [], log: () => {}, limits: { refusedPerMinute: 3 } });
  const front = http.createServer((req, res) => proxy.handleRequest(req, res));
  const port = await listen(front);
  try {
    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await request(port, "/photocraft/", { headers: { host: "craft.knife.test" } })).status);
    assert.deepEqual(statuses, [403, 403, 403, 429, 429]);
  } finally {
    front.close();
    front.closeAllConnections?.();
  }
});

/* ------------------------------------------------------------------------------------------- app CSP */

test("app CSP: the craft origin is a frame-src only (never script/connect); public mode trusts only an https KNIFE_CRAFT_PUBLIC_URL", () => {
  const dir = mkdtempSync(join(tmpdir(), "knife-craft-csp-"));
  try {
    mkdirSync(join(dir, "services", "craft"), { recursive: true });
    writeFileSync(join(dir, "services", "craft", "state.json"), JSON.stringify({ bindHost: "100.64.0.7", hostPort: 3215 }));
    assert.deepEqual(craftOrigins(dir, { KNIFE_AUTH_MODE: "private" }).origins, ["http://100.64.0.7:3215"]);
    assert.deepEqual(craftOrigins(dir, { KNIFE_AUTH_MODE: "private", KNIFE_CRAFT_PUBLIC_URL: "http://craft.knife.test:3400" }).origins, ["http://craft.knife.test:3400"]);
    const pub = { KNIFE_AUTH_MODE: "public" };
    assert.deepEqual(craftOrigins(dir, pub).origins, [], "public mode never reads the state file");
    assert.deepEqual(craftOrigins(dir, { ...pub, KNIFE_CRAFT_PUBLIC_URL: "https://craft.knife.example.org/x" }).origins, ["https://craft.knife.example.org"]);
    for (const bad of ["http://craft.knife.example.org", "https://100.64.0.7:3215", "https://craft.box.ts.net"]) {
      const result = craftOrigins(dir, { ...pub, KNIFE_CRAFT_PUBLIC_URL: bad });
      assert.deepEqual(result.origins, [], bad);
      assert.match(result.warning, /KNIFE_CRAFT_PUBLIC_URL .*left out of the CSP/);
    }
    const csp = securityHeaders({ frameOrigins: ["https://office.example.org"], frameOnlyOrigins: ["https://craft.example.org"] }).find(([name]) => name === "Content-Security-Policy")[1];
    const directive = (name) => csp.split("; ").find((part) => part.startsWith(`${name} `));
    assert.match(directive("frame-src"), /https:\/\/office\.example\.org https:\/\/craft\.example\.org/);
    assert.doesNotMatch(directive("script-src"), /craft/);
    assert.doesNotMatch(directive("connect-src"), /craft/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
