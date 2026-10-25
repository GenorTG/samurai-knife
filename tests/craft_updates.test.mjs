// Craft apps automatic updates (src/lib/craft/updates.ts): which upstream release qualifies (draft/pre-release,
// known-bad, asset name, download URL, sha256 digest, size), a full check against a fake GitHub (ETag/304, rate limit),
// apply with the digest check while streaming, the static health gate, rollback + hold, the modes.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/craft_updates.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-craft-updates-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_LOG_DIR = "off";
delete process.env.KNIFE_CRAFT_RELEASES_API;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { ARTCRAFT_APPS, findSidecar } = await import("../src/lib/services/definitions.ts");
const { writeZip } = await import("../src/lib/office/zip.ts");
const sites = await import("../src/lib/services/sites.ts");
const channel = await import("../src/lib/services/site-channel.ts");
const updates = await import("../src/lib/craft/updates.ts");

const craft = findSidecar("craft");
const app = (id) => ARTCRAFT_APPS.find((candidate) => candidate.id === id);
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

function zipFor(id, version, files) {
  return writeZip([{ name: `${id}-web-${version}/`, data: "", store: true }, ...Object.entries(files).map(([name, data]) => ({ name: `${id}-web-${version}/${name}`, data }))]);
}

function release(id, version, zip, extra = {}) {
  const name = `${id}-web-${version}.zip`;
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    published_at: "2026-10-20T10:00:00Z",
    assets: [{ name, size: zip.length, digest: `sha256:${sha(zip)}`, browser_download_url: `https://github.com/storytold/${id}/releases/download/v${version}/${name}` }],
    ...extra,
  };
}

test("pickRelease: newest stable release above the current one with the exact asset, URL, digest and a sane size", () => {
  const pc = app("photocraft");
  const z = Buffer.from("zip");
  const good = release("photocraft", "0.12.0", z);
  const newest = release("photocraft", "0.13.0", z);
  const listing = [
    { ...release("photocraft", "0.14.0", z), prerelease: true },
    { ...release("photocraft", "0.15.0", z), draft: true },
    release("photocraft", "0.13.0", z, { assets: [{ ...newest.assets[0], digest: undefined }] }),
    release("photocraft", "0.12.5", z, { assets: [{ ...good.assets[0], name: "photocraft-web-0.12.5.zip", browser_download_url: "https://evil.example/photocraft-web-0.12.5.zip" }] }),
    good,
    release("photocraft", "0.11.0", z),
    { tag_name: "nightly", assets: [] },
  ];
  const picked = updates.pickRelease(pc, "0.11.1", listing);
  assert.equal(picked.release.version, "0.12.0");
  assert.equal(picked.release.sha256, sha(z));
  assert.equal(picked.release.url, "https://github.com/storytold/photocraft/releases/download/v0.12.0/photocraft-web-0.12.0.zip");
  assert.ok(picked.skipped.some((line) => /0\.13\.0: no sha256 digest/.test(line)));
  assert.ok(picked.skipped.some((line) => /0\.12\.5: unexpected download URL/.test(line)));
  assert.equal(updates.pickRelease(pc, "0.12.0", listing).release, null, "nothing newer");
  const huge = release("photocraft", "0.12.0", z, { assets: [{ ...good.assets[0], size: 10 * 1024 ** 3 }] });
  assert.equal(updates.pickRelease(pc, "0.11.1", [huge]).release, null);
  // DeckCraft 0.8.0 / 0.9.0 panic at startup: never picked; 0.10.0 would be.
  const deck = app("deckcraft");
  assert.deepEqual(deck.knownBad, ["0.8.0", "0.9.0"]);
  const deckList = [release("deckcraft", "0.9.0", z), release("deckcraft", "0.8.0", z)];
  assert.equal(updates.pickRelease(deck, "0.7.0", deckList).release, null);
  assert.equal(updates.pickRelease(deck, "0.7.0", [release("deckcraft", "0.10.0", z), ...deckList]).release.version, "0.10.0");
  assert.equal(updates.pickRelease(pc, "0.11.1", { message: "Not Found" }).release, null);
});

function fakeGithub({ listings, zips, calls, status = {} }) {
  return async (url, init = {}) => {
    calls.push({ url, inm: init.headers?.["If-None-Match"] });
    const parsed = new URL(url);
    if (parsed.hostname === "api.github.com") {
      const repo = parsed.pathname.split("/")[3];
      if (status[repo]) return new Response("limited", { status: status[repo], headers: { "x-ratelimit-reset": "4102444800" } });
      // Like GitHub: the ETag follows the listing, so a changed listing is a 200 again.
      const body = JSON.stringify(listings[repo] ?? []);
      const etag = `"etag-${repo}-${sha(Buffer.from(body)).slice(0, 8)}"`;
      if (init.headers?.["If-None-Match"] === etag) return new Response(null, { status: 304 });
      return new Response(body, { status: 200, headers: { etag } });
    }
    const zip = zips.get(url);
    return zip ? new Response(zip, { status: 200 }) : new Response("missing", { status: 404 });
  };
}

test("check + apply: notify records, auto switches (download checked against the digest), ETag reused, rollback holds", async () => {
  const pc = app("photocraft");
  // The pinned release is "installed" (so rollback has something to go back to).
  const pinZip = zipFor("photocraft", pc.version, { "index.html": "pin", "app/parts.txt": "x" });
  const pin = { ...sites.pinRelease(pc), sha256: sha(pinZip), bytes: pinZip.length };
  await sites.installRelease(craft, pc, pin, { phase() {}, log() {} }, async () => new Response(pinZip));
  channel.writeChannel("craft", { mode: "auto", apps: { photocraft: { active: pin } } });

  const next = "0.12.0";
  const zip = zipFor("photocraft", next, { "index.html": "new", "app/parts.txt": "y", "photocraft-web-boot-0123456789abcdef_bg.wasm": "w" });
  const listing = release("photocraft", next, zip);
  const zips = new Map([[listing.assets[0].browser_download_url, zip]]);
  const calls = [];
  const fetcher = fakeGithub({ listings: { photocraft: [listing] }, zips, calls });

  const notified = await updates.checkCraftUpdates({ apply: false, fetcher });
  assert.deepEqual(notified.applied, []);
  assert.equal(notified.channel.apps.photocraft.available.version, next);
  assert.equal(sites.activeRelease(craft, pc).version, pc.version, "notify only: nothing switched");
  assert.equal(calls.filter((c) => c.url.startsWith("https://api.github.com/")).length, ARTCRAFT_APPS.length, "one listing per app");
  assert.ok(calls.every((c) => !c.url.startsWith("https://api.github.com/") || c.url.endsWith("/releases?per_page=20")));

  calls.length = 0;
  const applied = await updates.checkCraftUpdates({ apply: true, fetcher });
  assert.ok(calls.some((c) => /^"etag-photocraft-[0-9a-f]{8}"$/.test(c.inm ?? "")), "If-None-Match on the second check");
  assert.deepEqual(applied.applied, [`PhotoCraft ${next}`]);
  assert.equal(sites.activeRelease(craft, pc).version, next);
  assert.equal(readFileSync(join(dataDir, "services", "craft-content", "photocraft", "index.html"), "utf8"), "new");
  const view = updates.craftUpdatesView().apps.find((a) => a.id === "photocraft");
  assert.deepEqual([view.active, view.served, view.previous, view.available, view.change], [next, next, pc.version, null, "update"]);

  // Rollback: back to the pin, held so the next automatic check does not undo it.
  await updates.rollbackCraft("photocraft");
  assert.equal(sites.activeRelease(craft, pc).version, pc.version);
  assert.equal(readFileSync(join(dataDir, "services", "craft-content", "photocraft", "index.html"), "utf8"), "pin");
  assert.equal(channel.readChannel("craft").apps.photocraft.hold, true);
  const again = await updates.checkCraftUpdates({ apply: true, fetcher: fakeGithub({ listings: { photocraft: [listing] }, zips, calls: [] }) });
  assert.deepEqual(again.applied, [], "held");
  assert.equal(again.channel.apps.photocraft.available.version, next, "still offered");
  updates.holdCraft("photocraft", false);
  await updates.applyCraftUpdate("photocraft", fetcher);
  assert.equal(sites.activeRelease(craft, pc).version, next);
});

test("apply refuses a download that does not match the published digest, and a release that fails the health gate", async () => {
  const vc = app("vectorcraft");
  const zip = zipFor("vectorcraft", "0.18.0", { "index.html": "x", "v.wasm": "w" });
  const listing = release("vectorcraft", "0.18.0", zip);
  const tampered = zipFor("vectorcraft", "0.18.0", { "index.html": "y", "v.wasm": "w" });
  assert.equal(tampered.length, zip.length, "same size, other bytes: only the digest can tell");
  const fetcher = fakeGithub({ listings: { vectorcraft: [listing] }, zips: new Map([[listing.assets[0].browser_download_url, tampered]]), calls: [] });
  channel.writeChannel("craft", { mode: "auto", apps: {} });
  const result = await updates.checkCraftUpdates({ apply: true, fetcher });
  assert.deepEqual(result.applied, []);
  assert.match(result.errors.join(), /VectorCraft: update to 0\.18\.0 failed: .*does not match the release/);
  assert.equal(sites.activeRelease(craft, vc).version, vc.version);
  assert.ok(!existsSync(join(dataDir, "services", "craft", "releases", sites.releaseFolder(vc, { version: "0.18.0", sha256: sha(zip) }))));

  // Matches the digest but has no WebAssembly: refused by the static check, removed again.
  const noWasm = zipFor("vectorcraft", "0.19.0", { "index.html": "x", "main.js": "y" });
  const listing2 = release("vectorcraft", "0.19.0", noWasm);
  const fetcher2 = fakeGithub({ listings: { vectorcraft: [listing2] }, zips: new Map([[listing2.assets[0].browser_download_url, noWasm]]), calls: [] });
  const result2 = await updates.checkCraftUpdates({ apply: true, fetcher: fetcher2 });
  assert.match(result2.errors.join(), /no WebAssembly found/);
  assert.equal(sites.activeRelease(craft, vc).version, vc.version);
});

test("a GitHub rate limit stops the check and sets retryAfter; the next check is refused until then; modes", async () => {
  channel.writeChannel("craft", { mode: "auto", apps: {} });
  const calls = [];
  const result = await updates.checkCraftUpdates({ apply: false, fetcher: fakeGithub({ listings: {}, zips: new Map(), calls, status: { vectorcraft: 403 } }) });
  assert.match(result.channel.error, /rate limit \(HTTP 403\)/);
  assert.equal(result.channel.retryAfter, "2100-01-01T00:00:00.000Z");
  assert.equal(calls.length, 2, "photocraft, then vectorcraft hit the limit: no more calls");
  await assert.rejects(updates.checkCraftUpdates({ apply: false, fetcher: fakeGithub({ listings: {}, zips: new Map(), calls: [] }) }), /GitHub asked to wait/);
  assert.equal(updates.setCraftUpdateMode("notify").mode, "notify");
  assert.throws(() => updates.setCraftUpdateMode("sometimes"), /Unknown mode/);
  assert.equal(updates.releasesApi({ KNIFE_CRAFT_RELEASES_API: "http://127.0.0.1:3499/" }), "http://127.0.0.1:3499");
});
