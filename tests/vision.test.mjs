// Vision (docs/ACCOUNTS.md "Vision", docs/WEBSITE-STUDIO.md "Screenshots"): per-profile vision settings and how images
// are routed (native / helper / none), the chat-round image injection, the in-memory image store, the screenshot
// proxy's SSRF refusals, the target rules (own site only), the describer against the mock provider, and the tools.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/vision.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-vision-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_STORAGE_KEY_FILE = join(dataDir, "storage.key");
delete process.env.KNIFE_AUTH_MODE;
delete process.env.KNIFE_PUBLIC_URL;

const store = await import("../src/lib/accounts/store.ts");
const config = await import("../src/lib/vision/config.ts");
const inject = await import("../src/lib/vision/inject.ts");
const images = await import("../src/lib/vision/images.ts");
const proxy = await import("../src/lib/vision/proxy.ts");
const targets = await import("../src/lib/vision/targets.ts");
const describe = await import("../src/lib/vision/describe.ts");
const shot = await import("../src/lib/vision/screenshot.ts");
const siteStore = await import("../src/lib/site/store.ts");
const { callKnifeTool, KNIFE_TOOLS } = await import("../src/lib/mcp/tools.ts");
const { createKnifeMcpServer } = await import("../src/lib/mcp/server.ts");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1f1e1a40000000049454e44ae426082", "hex");
const cfg = (model, extra = {}) => ({ baseUrl: "https://api.example.test/v1", apiKey: "sk-test-0123456789", model, ...extra });

let mock;
let mockPort;
test.before(async () => {
  mockPort = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  mock = spawn(process.execPath, ["tests/mock_provider.mjs", String(mockPort)], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${mockPort}/v1/models`, { headers: { authorization: "Bearer mock-key" } });
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  store.mutateStore((s) => {
    s.accounts.push(store.newAccountRecord({ id: "vis", displayName: "Vis" }));
    s.accounts.push(store.newAccountRecord({ id: "other", displayName: "Other" }));
  });
});

test.after(() => {
  mock?.kill();
  images.clearImages();
  rmSync(dataDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ settings and routing */

test("profiles saved before vision existed stay text-only: no image, no helper", () => {
  assert.equal(config.visionModeOf(cfg("m")), "none");
  assert.deepEqual(config.visionRoute(cfg("m"), []), { mode: "none" });
  assert.deepEqual(config.visionRoute(null, []), { mode: "none" });
  assert.equal(config.describerFor(cfg("m"), []), null);
  assert.equal(store.toPublicProvider(cfg("m")).vision, "none");
  assert.equal(store.toPublicProvider(cfg("m")).visionHelper, null);
});

test("routing: native sees itself, a text-only model gets its helper, a missing or self helper counts as none", () => {
  const helper = { id: "helper1", name: "GPT vision", config: cfg("gpt-vision", { vision: "native" }) };
  const text = cfg("deepseek", { visionHelper: "helper1" });
  assert.deepEqual(config.visionRoute(cfg("qwen-vl", { vision: "native" }), [helper]), { mode: "native" });
  const routed = config.visionRoute(text, [helper], "text1");
  assert.equal(routed.mode, "helper");
  assert.equal(routed.profileId, "helper1");
  assert.equal(routed.config.model, "gpt-vision");
  assert.deepEqual(config.visionRoute(cfg("deepseek", { visionHelper: "gone" }), [helper]), { mode: "none" });
  assert.deepEqual(config.visionRoute(cfg("deepseek", { visionHelper: "self" }), [{ id: "self", name: "x", config: cfg("deepseek") }], "self"), { mode: "none" });
  // A native model with a helper still sees for itself in the assistant; describe() prefers the helper it was given.
  const nativeWithHelper = cfg("qwen-vl", { vision: "native", visionHelper: "helper1" });
  assert.equal(config.visionRoute(nativeWithHelper, [helper]).mode, "native");
  assert.equal(config.describerFor(nativeWithHelper, [helper]).config.model, "gpt-vision");
  assert.equal(config.describerFor(cfg("qwen-vl", { vision: "native" }), [], "a").profileId, "a");
  assert.match(config.visionHelperProblem("x", [{ id: "y" }]), /not a saved profile/);
  assert.match(config.visionHelperProblem("y", [{ id: "y" }], "y"), /its own vision helper/);
  assert.equal(config.visionHelperProblem("y", [{ id: "y" }], "z"), null);
});

test("store: vision fields are kept, shown without secrets, and a deleted helper is unlinked", () => {
  store.setProvider("vis", cfg("deepseek"));
  const helper = store.saveProviderProfile("vis", { name: "Vision", config: cfg("gpt-vision", { vision: "native" }) });
  let account = store.getAccount("vis");
  const textId = store.activeProfileIdOf(account);
  store.saveProviderProfile("vis", { profileId: textId, name: "Default", config: { ...account.provider, visionHelper: helper.profileId } });
  account = store.getAccount("vis");
  assert.equal(account.provider.visionHelper, helper.profileId, "the active profile's change is mirrored into provider");
  const pub = store.toPublicAccount(account);
  assert.deepEqual(pub.providerProfiles.map((p) => [p.model, p.vision, p.visionHelper]), [["deepseek", "none", helper.profileId], ["gpt-vision", "native", null]]);
  assert.ok(!JSON.stringify(pub).includes("sk-test"), "no key in the public view");
  store.deleteProviderProfile("vis", helper.profileId);
  account = store.getAccount("vis");
  assert.equal(account.provider.visionHelper, undefined);
  assert.equal(account.providerProfiles[0].config.visionHelper, undefined);
});

/* ------------------------------------------------------------------ chat injection */

test("injection: only the latest tool batch's images, at most 3, unknown ids skipped, nothing else changes", () => {
  const ref = (id) => JSON.stringify({ imageArtifact: id, page: "x" });
  const ids = ["vis_" + "a".repeat(20), "vis_" + "b".repeat(20), "vis_" + "c".repeat(20), "vis_" + "d".repeat(20), "vis_" + "e".repeat(20)];
  const messages = [
    { role: "user", content: "look" },
    { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "knife_site_screenshot", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "1", content: ref(ids[0]) },
    { role: "assistant", content: null, tool_calls: [] },
    { role: "tool", tool_call_id: "2", content: ref(ids[1]) },
    { role: "tool", tool_call_id: "3", content: `${ref(ids[2])}\n${ref(ids[3])}\n${ref(ids[4])}` },
  ];
  assert.deepEqual(inject.latestImageRefs(messages), ids.slice(1, 4));
  const lookup = (id) => (id === ids[2] ? null : { mime: "image/png", data: PNG });
  const out = inject.withLatestImages(messages, lookup);
  assert.deepEqual(out.injected, [ids[1], ids[3]]);
  assert.equal(out.messages.length, messages.length + 1);
  const added = out.messages.at(-1);
  assert.equal(added.role, "user");
  assert.match(added.content[0].text, /third-party data/);
  assert.equal(added.content.filter((p) => p.type === "image_url").length, 2);
  assert.match(added.content[2].image_url.url, /^data:image\/png;base64,iVBOR/);
  // A conversation whose latest round has no images is passed through untouched.
  const plain = [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }, { role: "user", content: ref(ids[0]) }];
  assert.deepEqual(inject.withLatestImages(plain, lookup).messages, plain);
});

/* ------------------------------------------------------------------ image store */

test("image store: per account, bounded, expires", () => {
  images.clearImages();
  const one = images.putImage({ accountId: "vis", mime: "image/png", bytes: PNG, width: 1, height: 1, source: "https://me.example/" });
  assert.match(one.id, images.IMAGE_ID);
  assert.equal(images.getImage("vis", one.id).bytes.length, PNG.length);
  assert.equal(images.getImage("other", one.id), null, "another account's id is unknown");
  assert.equal(images.getImage("vis", "vis_../../etc"), null);
  for (let i = 0; i < images.MAX_PER_ACCOUNT; i++) images.putImage({ accountId: "vis", mime: "image/png", bytes: PNG, width: 1, height: 1, source: "x" });
  assert.equal(images.getImage("vis", one.id), null, "the oldest is pushed out");
  const fresh = images.putImage({ accountId: "vis", mime: "image/png", bytes: PNG, width: 1, height: 1, source: "x" }, 1_000);
  assert.equal(images.getImage("vis", fresh.id, 1_000 + images.TTL_MS + 1), null, "expired");
  assert.equal(shot.sniffImage(PNG), "image/png");
  assert.equal(shot.sniffImage(Buffer.from("<svg/>")), null);
});

/* ------------------------------------------------------------------ the proxy (SSRF) */

const PUBLIC = { allowPrivate: false, ports: new Set(["", "80", "443", "8080", "8443"]), httpsOnly: false };
const fakeResolve = (map) => async (host) => {
  const address = map[host];
  if (!address) throw new Error("ENOTFOUND");
  return [{ address, family: address.includes(":") ? 6 : 4 }];
};

test("proxy: every private, metadata and local destination is refused before any connection", async () => {
  const resolve = fakeResolve({ "rebind.example": "10.0.0.7", "meta.example": "169.254.169.254", "good.example": "93.184.216.34", "v6.example": "::1" });
  for (const url of ["https://127.0.0.1/", "http://localhost/", "https://rebind.example/", "https://meta.example/", "https://v6.example/", "http://[::1]/", "https://100.112.80.61/", "https://good.example:22/"]) {
    await assert.rejects(proxy.admitDestination(new URL(url), { policy: PUBLIC, resolve }), /refusing|not allowed|public address/, url);
  }
  const ok = await proxy.admitDestination(new URL("https://good.example/"), { policy: PUBLIC, resolve });
  assert.deepEqual(ok.map((a) => a.address), ["93.184.216.34"]);
  let admitted = 0;
  await assert.rejects(proxy.admitDestination(new URL("https://good.example/"), { policy: PUBLIC, resolve, admit: () => { admitted += 1; throw new Error("over budget"); } }), /over budget/);
  assert.equal(admitted, 1);
  assert.equal(proxy.connectTarget("example.com:443").href, "https://example.com/");
  assert.equal(proxy.connectTarget("[::1]:8443").hostname, "[::1]");
  for (const bad of ["example.com", "a:b:c", "x.com:99999", "user@x.com:443", "x.com:443/path", ""]) assert.equal(proxy.connectTarget(bad), null, bad);
});

/** One raw request through the proxy's unix socket; resolves with the status line. */
function viaProxy(socketPath, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath, () => socket.write(text));
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\r\n")) {
        socket.destroy();
        resolve(data.split("\r\n")[0]);
      }
    });
    socket.on("error", reject);
  });
}

test("proxy: a running proxy refuses CONNECT and plain HTTP to loopback in public policy, and tunnels allowed ones", async () => {
  const target = http.createServer((_req, res) => res.end("inside"));
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const port = target.address().port;
  const dir = mkdtempSync(join(tmpdir(), "knife-proxy-"));
  const strict = await proxy.startScreenshotProxy(join(dir, "p1.sock"), { policy: { ...PUBLIC, ports: null }, limits: proxy.DEFAULT_PROXY_LIMITS });
  assert.match(await viaProxy(strict.socketPath, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`), / 403 /);
  assert.match(await viaProxy(strict.socketPath, `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`), / 403 /);
  assert.match(await viaProxy(strict.socketPath, `GET http://localhost:${port}/ HTTP/1.1\r\nHost: localhost\r\n\r\n`), / 403 /);
  assert.equal(strict.stats().refused, 3);
  assert.equal(strict.stats().connections, 0);
  strict.close();
  // The same request under a policy that allows it (private mode) goes through, counted.
  const open = await proxy.startScreenshotProxy(join(dir, "p2.sock"), { policy: { allowPrivate: true, ports: null, httpsOnly: false }, limits: { maxConnections: 1, maxBytes: 1_000_000 } });
  assert.match(await viaProxy(open.socketPath, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\n`), / 200 /);
  assert.match(await viaProxy(open.socketPath, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\n`), / 429 /, "the connection cap holds");
  open.close();
  target.close();
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ targets: own site only */

test("targets: twins, paths, and a public-mode user is held to their own verified site", async () => {
  assert.deepEqual(targets.twinOrigins("https://me.example/x"), ["https://me.example", "http://me.example", "https://www.me.example", "http://www.me.example"]);
  assert.equal(targets.pathOn("https://me.example/", "/about?x=1"), "https://me.example/about?x=1");
  for (const bad of ["//evil.example/", "https://evil.example/", "about", "/a b", "/\\evil"]) assert.throws(() => targets.pathOn("https://me.example/", bad), bad);

  process.env.KNIFE_AUTH_MODE = "public";
  try {
    await assert.rejects(targets.resolveScreenshotTarget("vis", { target: "production" }), /add your website first/);
    siteStore.mutateSite("vis", (s) => {
      s.siteUrl = { url: "https://me.example", pages: [], token: "tok", verifiedOrigin: "", setAt: new Date().toISOString() };
    });
    await assert.rejects(targets.resolveScreenshotTarget("vis", { target: "production" }), /not verified yet/);
    siteStore.mutateSite("vis", (s) => {
      s.siteUrl.verifiedOrigin = "https://me.example";
    });
    const prod = await targets.resolveScreenshotTarget("vis", { target: "production", path: "/about" });
    assert.equal(prod.url, "https://me.example/about");
    assert.ok(prod.allowedOrigins.includes("https://www.me.example"));
    await assert.rejects(targets.resolveScreenshotTarget("vis", { target: "url", url: "https://evil.example/" }), /own website only/);
    await assert.rejects(targets.resolveScreenshotTarget("vis", { target: "url", url: "http://169.254.169.254/latest" }), /own website only/);
    await assert.rejects(targets.resolveScreenshotTarget("vis", { target: "preview" }), /need Vercel connected/);
    assert.equal((await targets.resolveScreenshotTarget("vis", { target: "url", url: "https://me.example/blog" })).kind, "site");
  } finally {
    delete process.env.KNIFE_AUTH_MODE;
  }
});

/* ------------------------------------------------------------------ describer + tools against the mock provider */

test("describe: the helper model gets the picture as an image part; without one the account is told how to set it up", async () => {
  store.mutateStore((s) => {
    s.accounts.push(store.newAccountRecord({ id: "desc", displayName: "Desc" }));
  });
  const mockCfg = (model, extra = {}) => ({ baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "mock-key", model, ...extra });
  store.setProvider("desc", mockCfg("text-only"));
  await assert.rejects(describe.describeImage("desc", { mime: "image/png", bytes: PNG }), /No model can read images/);
  const helper = store.saveProviderProfile("desc", { name: "Helper", config: mockCfg("vision-helper", { vision: "native" }) });
  const account = store.getAccount("desc");
  store.saveProviderProfile("desc", { profileId: store.activeProfileIdOf(account), name: "Default", config: { ...account.provider, visionHelper: helper.profileId } });
  const d = await describe.describeImage("desc", { mime: "image/png", bytes: PNG }, "Is the logo visible?");
  assert.match(d.text, /^VISION: saw 1 image\(s\) \[image\/png\]/);
  assert.equal(d.model, "vision-helper");
  const log = await (await fetch(`http://127.0.0.1:${mockPort}/__log`)).json();
  const sent = log.at(-1).messages.at(-1);
  assert.deepEqual(sent.images, ["image/png"]);
  assert.match(sent.text, /Is the logo visible\?/);

  // knife_vision_describe over a stored screenshot; another account cannot read it.
  const image = images.putImage({ accountId: "desc", mime: "image/png", bytes: PNG, width: 1, height: 1, source: "https://me.example/" });
  const out = await callKnifeTool("knife_vision_describe", { image: image.id }, { accountId: "desc", admin: false });
  assert.match(out.description, /<<<UNTRUSTED_CONTENT id=.*\nVISION: saw 1 image/);
  await assert.rejects(callKnifeTool("knife_vision_describe", { image: image.id }, { accountId: "other", admin: false }), /Unknown or expired image/);
  await assert.rejects(callKnifeTool("knife_vision_describe", { image: "../../x" }, { accountId: "desc", admin: false }), /screenshot id/);
});

test("tools: registered with the right effects, offered to MCP and the assistant, screenshot refused off-site", async () => {
  const screenshotTool = KNIFE_TOOLS.find((t) => t.name === "knife_site_screenshot");
  assert.equal(screenshotTool.effect, "outbound");
  assert.deepEqual(screenshotTool.urlArgs, ["url"]);
  assert.equal(screenshotTool.untrustedOutput, true);
  assert.equal(KNIFE_TOOLS.find((t) => t.name === "knife_vision_describe").untrustedOutput, true);
  const server = createKnifeMcpServer({ accountId: "vis", admin: false });
  assert.ok(server, "the MCP server registers the vision tools without error");
  process.env.KNIFE_AUTH_MODE = "public";
  try {
    await assert.rejects(callKnifeTool("knife_site_screenshot", { target: "url", url: "https://evil.example/" }, { accountId: "vis", admin: false, surface: "assistant" }), /own website only/);
  } finally {
    delete process.env.KNIFE_AUTH_MODE;
  }
});
