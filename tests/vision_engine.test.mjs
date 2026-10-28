// Screenshot engine end to end (src/lib/vision/screenshot.ts, proxy.ts, server/py/scripts/site_screenshot.py): a real
// Chromium behind the SSRF-checked proxy against a local fake site. Skipped when the machine lacks Chromium or a Python
// with `playwright` (set KNIFE_VISION_PYTHON to one, e.g. a venv with server/py/requirements.txt).
// Run: KNIFE_VISION_PYTHON=/path/venv/bin/python node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/vision_engine.test.mjs
// With KNIFE_VISION_BWRAP=1 the script runs inside the bubblewrap sandbox exactly as in public mode.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const python = process.env.KNIFE_VISION_PYTHON?.trim() ?? "";
const hasPlaywright = python && spawnSync(python, ["-c", "import playwright"], { stdio: "ignore" }).status === 0;
const dataDir = mkdtempSync(join(tmpdir(), "knife-vision-engine-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_STORAGE_KEY_FILE = join(dataDir, "storage.key");
if (python) process.env.KNIFE_PYTHON = python;
process.env.KNIFE_PY_SANDBOX = process.env.KNIFE_VISION_BWRAP === "1" ? "bwrap" : "off";

const { chromiumPath, takeScreenshot, sniffImage } = await import("../src/lib/vision/screenshot.ts");
const { getImage, clearImages } = await import("../src/lib/vision/images.ts");
const skip = !hasPlaywright ? "needs KNIFE_VISION_PYTHON with playwright" : !chromiumPath() ? "needs Chromium" : false;

/** A server answering `routes` (path -> [status, type, body]) and counting hits per path. */
function serve(routes) {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const route = routes(path, req);
    if (!route) return res.writeHead(404).end("missing");
    res.writeHead(route[0], { "content-type": route[1], ...(route[3] ?? {}) }).end(route[2]);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, hits })));
}

const accounts = await import("../src/lib/accounts/store.ts");
accounts.mutateStore((s) => {
  s.accounts.push(accounts.newAccountRecord({ id: "owner", displayName: "Owner" }));
});

test.after(() => {
  clearImages();
  rmSync(dataDir, { recursive: true, force: true });
});

test("a real browser behind the proxy: page rendered, other ports refused, navigation off the site aborted", { skip, timeout: 120_000 }, async () => {
  const secret = await serve(() => [200, "image/png", "SECRET"]);
  const site = await serve((path, req) => {
    if (path === "/") {
      return [200, "text/html", `<!doctype html><html><head><title>Fake site</title><link rel="stylesheet" href="/s.css"></head>
        <body><h1>Hello vision</h1><img src="http://127.0.0.1:${secret.port}/leak.png"><p style="height:3000px">tall</p></body></html>`];
    }
    if (path === "/s.css") return [200, "text/css", "body{background:#fafafa;font-family:sans-serif} h1{color:#c00}"];
    if (path === "/away") return [200, "text/html", `<script>location.href="http://127.0.0.1:${secret.port}/";</script>`];
    if (path === "/protected") {
      return req.headers["x-vercel-protection-bypass"] === "s3cret" ? [200, "text/html", "<h1>secret preview</h1>"] : [401, "text/html", "<h1>login</h1>"];
    }
    return null;
  });
  const origin = `http://127.0.0.1:${site.port}`;
  // The site is on loopback, so the test policy allows private addresses but only the site's port: the secret server
  // (another port) stands for every address the real public-mode policy refuses.
  const policy = { allowPrivate: true, ports: new Set([String(site.port)]), httpsOnly: false };
  try {
    const target = { url: `${origin}/`, kind: "url", allowedOrigins: [origin] };
    const shot = await takeScreenshot("owner", target, { viewport: "desktop", fullPage: true, policy });
    assert.equal(shot.title, "Fake site");
    assert.equal(sniffImage(shot.image.bytes), shot.image.mime);
    assert.ok(shot.image.height > 800 && shot.image.height <= 4000, `full page height ${shot.image.height}`);
    assert.equal(getImage("owner", shot.image.id)?.id, shot.image.id);
    assert.equal(getImage("someone-else", shot.image.id), null);
    assert.equal(secret.hits.size, 0, "the browser reached a port the policy does not allow");
    assert.ok(shot.refusedConnections >= 1, "the proxy refused the off-policy image");
    assert.equal(site.hits.get("/s.css"), 1);

    await assert.rejects(
      takeScreenshot("owner", { url: `${origin}/away`, kind: "url", allowedOrigins: [origin] }, { viewport: "mobile", policy }),
      /left the allowed site/,
    );
    assert.equal(secret.hits.size, 0, "a navigation off the allowed origins went out");
    const mobile = await takeScreenshot("owner", target, { viewport: "mobile", format: "jpeg", policy });
    assert.equal(mobile.image.width, 390);
    assert.equal(mobile.image.mime, "image/jpeg");

    const bypass = { host: `127.0.0.1:${site.port}`, headers: { "x-vercel-protection-bypass": "s3cret" } };
    const ok = await takeScreenshot("owner", { url: `${origin}/protected`, kind: "preview", allowedOrigins: [origin], hostHeaders: bypass }, { viewport: "desktop", policy });
    assert.equal(ok.status, 200);
    assert.equal(ok.title, "");
    const denied = await takeScreenshot("owner", { url: `${origin}/protected`, kind: "url", allowedOrigins: [origin] }, { viewport: "desktop", policy });
    assert.equal(denied.status, 401, "no bypass header without hostHeaders");
  } finally {
    site.server.close();
    secret.server.close();
  }
});
