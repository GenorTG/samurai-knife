// Client identity (src/lib/net/client-ip.mjs), shared by the app (src/lib/accounts/network.ts) and the preloads
// (scripts/client-address.mjs): the same table of requests must give the same client on both sides, IPv6 is bucketed by
// /64 (+ /48), IPv4 by /32 (+ /24), forwarded headers count only from a trusted peer, right-most untrusted entry wins.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/client_ip.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

const core = await import("../src/lib/net/client-ip.mjs");
const mjs = await import("../scripts/client-address.mjs");
const network = await import("../src/lib/accounts/network.ts");
const ipPrefix = await import("../src/lib/accounts/ip-prefix.ts");

const RULES = "127.0.0.1, ::1, 10.0.0.0/8";

const CASES = [
  // [peer, x-forwarded-for, expected client]
  ["192.0.2.50", "203.0.113.9", "192.0.2.50"], // untrusted peer: header ignored
  ["127.0.0.1", "203.0.113.9", "203.0.113.9"],
  ["::ffff:127.0.0.1", "203.0.113.9", "203.0.113.9"], // IPv4-mapped peer
  ["127.0.0.1", "1.1.1.1, 198.51.100.4, 10.0.0.2", "198.51.100.4"], // right-most untrusted wins
  ["127.0.0.1", "garbage, 198.51.100.4", "198.51.100.4"],
  ["127.0.0.1", "10.0.0.7, 10.0.0.2", "10.0.0.2"], // all trusted: right-most entry, never the client-chosen left one
  ["127.0.0.1", "", "127.0.0.1"], // trusted peer, no header: the peer
  ["::1", "2001:DB8::1", "2001:db8::1"],
  ["::1", "[2001:db8::2]", "2001:db8::2"],
];

const rawRequest = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { "x-forwarded-for": xff } : {} });
const webRequest = (peer, xff) => new Request("http://knife.example.com/api/x", { headers: { "x-knife-peer": peer, ...(xff ? { "x-forwarded-for": xff } : {}) } });

test("TS (network.ts) and .mjs (client-address.mjs) resolve the same client for every case", () => {
  const env = { KNIFE_TRUSTED_PROXIES: RULES };
  const rules = core.trustedRules(env);
  for (const [peer, xff, expected] of CASES) {
    assert.equal(mjs.clientAddress(rawRequest(peer, xff), rules), expected, `mjs ${peer} | ${xff}`);
    assert.equal(network.clientAddress(webRequest(peer, xff), env), expected, `ts ${peer} | ${xff}`);
    assert.equal(network.clientIp(webRequest(peer, xff), env), core.addressBuckets(expected).narrow, `bucket ${peer} | ${xff}`);
  }
  assert.equal(network.clientIp(new Request("http://x/", { headers: { "x-forwarded-for": "203.0.113.9" } }), env), "local", "no peer stamp: never trusted");
});

test("IPv6 is bucketed by /64 (any spelling), with a /48 companion; IPv4 by /32 with a /24 companion", () => {
  const a = core.addressBuckets("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
  const b = core.addressBuckets("2001:0db8:0001:0002::1");
  assert.equal(a.narrow, "2001:0db8:0001:0002::/64");
  assert.equal(a.narrow, b.narrow, "compressed and padded forms land in the same /64");
  assert.equal(a.wide, "2001:0db8:0001::/48");
  assert.equal(core.addressBuckets("2001:db8:1:3::9").wide, a.wide);
  assert.notEqual(core.addressBuckets("2001:db8:1:3::9").narrow, a.narrow);
  assert.deepEqual(core.addressBuckets("198.51.100.23"), { narrow: "198.51.100.23", wide: "198.51.100.0/24", family: 4 });
  assert.equal(core.addressBuckets("::ffff:198.51.100.23").narrow, "198.51.100.23");
  assert.equal(core.addressBuckets("local").narrow, "local");
  assert.equal(core.wideKeyOf("2001:0db8:0001:0002::/64"), "2001:0db8:0001::/48");
  assert.equal(core.wideKeyOf("198.51.100.23"), "198.51.100.0/24");
  assert.equal(core.wideKeyOf("local"), null);
  const env = { KNIFE_TRUSTED_PROXIES: "::1" };
  const ips = ["2001:db8:5:6::1", "2001:db8:5:6:ffff::42", "2001:db8:5:6:1:2:3:4"].map((ip) => network.clientIp(webRequest("::1", ip), env));
  assert.equal(new Set(ips).size, 1, "rotating inside a /64 is one client");
});

test("rules: IP and CIDR, both families, malformed rules match nothing", () => {
  assert.equal(core.ipMatches("10.1.2.3", "10.0.0.0/8"), true);
  assert.equal(core.ipMatches("11.1.2.3", "10.0.0.0/8"), false);
  assert.equal(core.ipMatches("::ffff:127.0.0.1", "127.0.0.1"), true);
  assert.equal(core.ipMatches("fd7a:115c:a1e0::1", "fd7a:115c:a1e0::/48"), true);
  assert.equal(core.ipMatches("fd7a:115d::1", "fd7a:115c:a1e0::/48"), false);
  assert.equal(core.ipMatches("1.2.3.4", "garbage"), false);
  assert.equal(core.ipMatches("1.2.3.4", "1.2.3.4/33"), false);
  assert.equal(core.ipMatches("1.2.3.4", "1.2.3.0/2x"), false);
  assert.equal(core.ipMatches("999.1.1.1", "0.0.0.0/0"), false);
  assert.deepEqual(core.parseRule("172.18.0.0/16"), { family: 4, value: 0xac120000n, bits: 16 });
  assert.equal(mjs.ipMatches, core.ipMatches, "one implementation");
  assert.equal(network.ipMatches, core.ipMatches, "one implementation");
});

test("address scopes for the private-mode bind check", () => {
  assert.equal(core.addressScope("127.0.0.1"), "loopback");
  assert.equal(core.addressScope("::1"), "loopback");
  assert.equal(core.addressScope("100.100.1.2"), "tailscale");
  assert.equal(core.addressScope("fd7a:115c:a1e0::5"), "tailscale");
  assert.equal(core.addressScope("192.168.1.10"), "private");
  assert.equal(core.addressScope("172.20.0.1"), "private");
  assert.equal(core.addressScope("8.8.8.8"), "public");
  assert.equal(core.addressScope("2001:db8::1"), "public");
  assert.equal(core.addressScope("knife.example.org"), null);
});

test("HTTPS: X-Forwarded-Proto counts only from a trusted peer (both sides)", () => {
  const env = { KNIFE_TRUSTED_PROXIES: RULES };
  const proto = { "x-forwarded-proto": "https" };
  assert.equal(mjs.requestIsHttps({ socket: { remoteAddress: "127.0.0.1" }, headers: proto }, core.trustedRules(env)), true);
  assert.equal(mjs.requestIsHttps({ socket: { remoteAddress: "192.0.2.1" }, headers: proto }, core.trustedRules(env)), false);
  assert.equal(network.isHttps(new Request("http://x/", { headers: { ...proto, "x-knife-peer": "127.0.0.1" } }), env), true);
  assert.equal(network.isHttps(new Request("http://x/", { headers: { ...proto, "x-knife-peer": "192.0.2.1" } }), env), false);
});

test("one prefix helper (E7): clientPrefix = addressBuckets().narrow, idempotent on clientIp output, same PoW/pending tag", () => {
  const env = { KNIFE_TRUSTED_PROXIES: "::1" };
  for (const raw of ["2001:db8:5:6::1", "198.51.100.23", "::ffff:198.51.100.23", "local"]) {
    assert.equal(ipPrefix.clientPrefix(raw), core.addressBuckets(raw).narrow, raw);
    assert.equal(ipPrefix.clientPrefix(ipPrefix.clientPrefix(raw)), ipPrefix.clientPrefix(raw), `idempotent ${raw}`);
  }
  // Routes hand clientIp (already a prefix) to the PoW binding, pending caps, events and GitHub sign-in; tags must match
  // the ones computed from the raw address (challenges and pending records from before keep working).
  const grouped = network.clientIp(webRequest("::1", "2001:db8:5:6:ffff::42"), env);
  assert.equal(grouped, "2001:0db8:0005:0006::/64");
  assert.equal(ipPrefix.prefixTag(grouped), ipPrefix.prefixTag("2001:db8:5:6::1"));
  assert.equal(core.wideKeyOf(grouped), "2001:0db8:0005::/48");
});
