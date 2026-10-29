// Vision detection (docs/ACCOUNTS.md "Vision detection"): the probe picture, the answer classifier, a real probe
// against a local OpenAI-compatible stub (sees / refuses / drops the image / fails), the shared learned-capability
// cache (keying, expiry, no secrets, merge into a model list) and the assistant's per-turn limits (bounds, storage).
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/vision_probe.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";

const dataDir = mkdtempSync(join(tmpdir(), "knife-vision-probe-"));
process.env.KNIFE_DATA_DIR = dataDir;
delete process.env.KNIFE_AUTH_MODE;
delete process.env.KNIFE_PUBLIC_URL;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const probe = await import("../src/lib/vision/probe.ts");
const caps = await import("../src/lib/vision/capabilities.ts");
const limits = await import("../src/lib/agent-client/turn-limits.ts");
const store = await import("../src/lib/accounts/store.ts");
const { OPEN_NET } = await import("../src/lib/accounts/provider.ts");

const KEY = "sk-probe-secret-0123456789abcdef";

/** RGB at (x, y) of an RGB PNG (filter 0 rows), as the probe writes it. */
function pixel(png, x, y) {
  let at = 8;
  let width = 0;
  const idat = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") width = data.readUInt32BE(0);
    if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(idat));
  const start = y * (width * 3 + 1) + 1 + x * 3;
  return [rows[start], rows[start + 1], rows[start + 2]];
}

/* ----------------------------------------------------------------------------------------------- picture + classifier */

test("the probe picture is a valid PNG with the two colours left and right", () => {
  const png = probe.twoColourPng("red", "blue");
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 32);
  assert.deepEqual(pixel(png, 3, 5), [...probe.PROBE_COLOURS.red]);
  assert.deepEqual(pixel(png, 60, 30), [...probe.PROBE_COLOURS.blue]);
  assert.ok(png.length < 500, `tiny picture (${png.length} bytes)`);
});

test("colours are two different ones", () => {
  for (let i = 0; i < 50; i += 1) {
    const [a, b] = probe.pickColours();
    assert.notEqual(a, b);
  }
  assert.deepEqual(probe.pickColours(() => 0), ["red", "green"]);
});

const answer = (content, status = 200) => ({ ok: true, status, text: JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }) });
const failure = (status, error) => ({ ok: true, status, text: JSON.stringify({ error }) });

test("classifier: the right colours in order = sees images", () => {
  assert.deepEqual(probe.classifyProbe(answer("red blue"), ["red", "blue"]), { vision: true, reason: "saw", status: 200 });
  assert.equal(probe.classifyProbe(answer("Left: Red. Right: Blue."), ["red", "blue"]).vision, true);
  // Wrong order or wrong colours: no evidence either way (never cached).
  assert.deepEqual(probe.classifyProbe(answer("blue red"), ["red", "blue"]), { vision: null, reason: "unclear", status: 200 });
  assert.equal(probe.classifyProbe(answer("green yellow"), ["red", "blue"]).vision, null);
  assert.equal(probe.classifyProbe(answer(""), ["red", "blue"]).reason, "unclear");
  assert.equal(probe.classifyProbe({ ok: true, status: 200, text: "not json" }, ["red", "blue"]).reason, "unclear");
});

test("classifier: no-image answers and image errors = text only", () => {
  for (const text of ["NO_IMAGE", "I'm sorry, I cannot see images.", "I can't view attachments", "There is no image in your message.", "I am a text-only model."]) {
    assert.deepEqual(probe.classifyProbe(answer(text), ["red", "blue"]), { vision: false, reason: "no_image", status: 200 }, text);
  }
  for (const [status, error] of [
    [400, { message: "This model does not support image input." }],
    [400, "Invalid content type. image_url is only supported by certain models."],
    [422, { message: "Unsupported content part: image_url" }],
    [400, { message: "Model is not multimodal" }],
    [415, { message: "content-type of part not allowed" }],
  ]) {
    assert.deepEqual(probe.classifyProbe(failure(status, error), ["red", "blue"]), { vision: false, reason: "rejected", status });
  }
});

test("classifier: errors that say nothing about images stay unknown", () => {
  for (const [status, error] of [
    [401, { message: "invalid key for image models" }],
    [403, { message: "image forbidden" }],
    [404, { message: "model not found" }],
    [429, { message: "rate limited" }],
    [500, { message: "image pipeline crashed" }],
    [400, { message: "max_tokens is too large" }],
  ]) {
    assert.deepEqual(probe.classifyProbe(failure(status, error), ["red", "blue"]), { vision: null, reason: "error", status }, `${status}`);
  }
  assert.deepEqual(probe.classifyProbe({ ok: false, failure: "timeout" }, ["red", "blue"]), { vision: null, reason: "error", status: null });
});

/* --------------------------------------------------------------------------------------------- a real probe round */

test("probeVision against a stub: sees / refuses / drops / fails / max_completion_tokens retry", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      seen.push({ auth: req.headers.authorization, body });
      const send = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const parts = body.messages[0].content;
      const url = parts.find((p) => p.type === "image_url").image_url.url;
      const png = Buffer.from(url.split(",")[1], "base64");
      const name = (rgb) => Object.entries(probe.PROBE_COLOURS).find(([, v]) => v.every((c, i) => c === rgb[i]))?.[0];
      const colours = `${name(pixel(png, 1, 1))} ${name(pixel(png, 62, 1))}`;
      if (body.model === "reasoner" && body.max_tokens !== undefined) return send(400, { error: { message: "Use max_completion_tokens instead of max_tokens." } });
      const budget = body.max_tokens ?? body.max_completion_tokens;
      if (body.model === "thinker" && budget < 5_000) return send(200, { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }] });
      if (body.model === "deep-thinker") return send(200, { choices: [{ message: { role: "assistant", content: null }, finish_reason: "length" }] });
      if (body.model === "seer" || body.model === "reasoner" || body.model === "thinker") return send(200, { choices: [{ message: { role: "assistant", content: colours } }] });
      if (body.model === "text") return send(400, { error: { message: "This model does not support image input." } });
      if (body.model === "dropper") return send(200, { choices: [{ message: { role: "assistant", content: "NO_IMAGE" } }] });
      return send(503, { error: { message: "overloaded" } });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: KEY, model: "configured" };
  try {
    assert.deepEqual(await probe.probeVision(config, OPEN_NET, "seer"), { vision: true, reason: "saw", status: 200 });
    assert.equal((await probe.probeVision(config, OPEN_NET, "reasoner")).vision, true);
    assert.equal(seen.at(-1).body.max_completion_tokens, probe.PROBE_MAX_TOKENS, "retried with max_completion_tokens");
    // A reasoning model out of tokens before answering: retried once larger; still empty = unknown, never text-only.
    assert.deepEqual(await probe.probeVision(config, OPEN_NET, "thinker"), { vision: true, reason: "saw", status: 200 });
    assert.equal(seen.at(-1).body.max_tokens, probe.PROBE_RETRY_MAX_TOKENS);
    const before = seen.length;
    assert.deepEqual(await probe.probeVision(config, OPEN_NET, "deep-thinker"), { vision: null, reason: "unclear", status: 200 });
    assert.equal(seen.length - before, 2, "one retry only");
    assert.deepEqual(await probe.probeVision(config, OPEN_NET, "text"), { vision: false, reason: "rejected", status: 400 });
    assert.deepEqual(await probe.probeVision(config, OPEN_NET, "dropper"), { vision: false, reason: "no_image", status: 200 });
    assert.deepEqual(await probe.probeVision(config, OPEN_NET, "down"), { vision: null, reason: "error", status: 503 });
    assert.equal(seen[0].auth, `Bearer ${KEY}`, "the account's key is sent to its own provider");
    assert.equal(seen[0].body.model, "seer", "the probed model, not the configured one");
    assert.equal(seen[0].body.stream, false);
  } finally {
    server.close();
  }
  // Nothing listening: a transport failure, unknown.
  assert.deepEqual(await probe.probeVision({ ...config, baseUrl: "http://127.0.0.1:9/v1" }, OPEN_NET, "seer", { timeoutMs: 2_000 }), { vision: null, reason: "error", status: null });
});

test("probe slots: at most 3 of one account at once, others are not held up", async () => {
  let running = 0;
  let peak = 0;
  const job = () => probe.withProbeSlot("acct", async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running -= 1;
  });
  let other = false;
  await Promise.all([...Array.from({ length: 8 }, job), probe.withProbeSlot("someone-else", async () => { other = true; })]);
  assert.equal(peak, probe.PROBE_CONCURRENCY);
  assert.ok(other);
});

/* ------------------------------------------------------------------------------------------------ the learned cache */

test("cache key: host + path + model; never a credential, query or fragment", () => {
  assert.equal(caps.capabilityKey("https://OpenCode.ai/zen/go/v1/", "deepseek-v4.1-flash"), "opencode.ai/zen/go/v1|deepseek-v4.1-flash");
  assert.equal(caps.capabilityKey("http://127.0.0.1:1234/v1", "m"), "127.0.0.1:1234/v1|m");
  assert.equal(caps.capabilityKey("https://user:pw@api.example.test/v1", "m"), null);
  assert.equal(caps.capabilityKey("https://api.example.test/v1?key=abc", "m"), null);
  assert.equal(caps.capabilityKey("ftp://api.example.test/v1", "m"), null);
  assert.equal(caps.capabilityKey("https://api.example.test/v1", "bad\nid"), null);
  assert.equal(caps.capabilityKey("https://api.example.test/v1", ""), null);
});

test("cache: remembers yes/no for 30 days, shared file without any account data", () => {
  const base = "https://api.example.test/v1";
  const now = Date.parse("2026-10-29T10:00:00Z");
  assert.equal(caps.learnedVision(base, "m-vision", now), null);
  caps.rememberVision(base, "m-vision", true, now);
  caps.rememberVision(`${base}/`, "m-text", false, now);
  assert.equal(caps.learnedVision(base, "m-vision", now + 1000).vision, true);
  assert.equal(caps.learnedVision(base, "m-text", now).vision, false, "trailing slash: the same endpoint");
  assert.equal(caps.learnedVision("https://other.example.test/v1", "m-vision", now), null, "another endpoint learns nothing");
  assert.equal(caps.learnedVision(base, "m-vision", now + caps.CAPABILITY_TTL_MS + 1), null, "expired after 30 days");
  const file = join(dataDir, "model-capabilities.json");
  const raw = readFileSync(file, "utf8");
  assert.ok(!raw.includes(KEY) && !raw.includes("sk-") && !raw.includes("apiKey") && !raw.includes("Bearer"), "no secrets in the file");
  assert.deepEqual(Object.keys(JSON.parse(raw).entries).sort(), ["api.example.test/v1|m-text", "api.example.test/v1|m-vision"]);
  // A later write prunes what has expired.
  caps.rememberVision(base, "m-late", true, now + caps.CAPABILITY_TTL_MS + 10);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).entries), ["api.example.test/v1|m-late"]);
  // A broken file reads as empty and is rewritten by the next answer.
  writeFileSync(file, "{broken");
  caps.resetCapabilityCache();
  assert.equal(caps.learnedVision(base, "m-late", now), null);
  caps.rememberVision(base, "m-again", false, now);
  assert.equal(caps.learnedVision(base, "m-again", now).vision, false);
  assert.ok(existsSync(file));
});

test("model list merge: advertised first, else detected, else unknown", () => {
  const base = "https://merge.example.test/v1";
  const now = Date.now();
  caps.rememberVision(base, "probed-yes", true, now);
  caps.rememberVision(base, "advertised-no", true, now); // the provider's own word wins over a learned answer
  const merged = caps.mergeLearnedVision(base, [
    { id: "advertised-no", contextLength: 1, vision: false, visionSource: "advertised", features: [] },
    { id: "probed-yes", contextLength: null, vision: null, visionSource: null, features: [] },
    { id: "never", contextLength: null, vision: null, visionSource: null, features: [] },
  ], now);
  assert.deepEqual(merged.map((m) => [m.id, m.vision, m.visionSource]), [["advertised-no", false, "advertised"], ["probed-yes", true, "detected"], ["never", null, null]]);
  assert.ok(merged[1].visionCheckedAt);
  const result = caps.withLearnedVision(base, { ok: true, status: 200, modelDetails: merged.slice(1) });
  assert.equal(result.modelDetails[0].visionSource, "detected");
  assert.deepEqual(caps.withLearnedVision(base, { ok: false, status: null }), { ok: false, status: null });
});

/* ----------------------------------------------------------------------------------------------------- turn limits */

test("turn limits: bounds, defaults, invalid values fall back", () => {
  assert.deepEqual(limits.DEFAULT_TURN_LIMITS, { maxRounds: 24, maxToolCalls: 40 });
  assert.deepEqual(limits.resolveTurnLimits(null), limits.DEFAULT_TURN_LIMITS);
  assert.deepEqual(limits.resolveTurnLimits({ maxRounds: 4, maxToolCalls: 200 }), { maxRounds: 4, maxToolCalls: 200 });
  for (const bad of [{ maxRounds: 3, maxToolCalls: 40 }, { maxRounds: 101, maxToolCalls: 40 }, { maxRounds: 24, maxToolCalls: 201 }, { maxRounds: 24.5, maxToolCalls: 40 }, { maxRounds: 24 }, "24"]) {
    assert.equal(limits.turnLimitsSchema.safeParse(bad).success, false, JSON.stringify(bad));
    assert.deepEqual(limits.resolveTurnLimits(bad), limits.DEFAULT_TURN_LIMITS);
  }
  // The route is strict about extra fields; the loop reads the public view, whose `custom` flag is ignored.
  assert.equal(limits.turnLimitsSchema.safeParse({ maxRounds: 6, maxToolCalls: 9, custom: true }).success, false);
  assert.deepEqual(limits.resolveTurnLimits({ maxRounds: 6, maxToolCalls: 9, custom: true }), { maxRounds: 6, maxToolCalls: 9 });
});

test("turn limits: stored per account, public view fills defaults, a hand-edited value never breaks the file", () => {
  store.mutateStore((s) => {
    s.accounts.push(store.newAccountRecord({ id: "limits", displayName: "Limits" }));
  });
  assert.deepEqual(store.toPublicAccount(store.getAccount("limits")).assistant, { maxRounds: 24, maxToolCalls: 40, custom: false });
  store.setAssistantLimits("limits", { maxRounds: 6, maxToolCalls: 9 });
  assert.deepEqual(store.toPublicAccount(store.getAccount("limits")).assistant, { maxRounds: 6, maxToolCalls: 9, custom: true });
  store.setAssistantLimits("limits", null);
  assert.equal(store.getAccount("limits").assistant, null);
  // A hand edit out of bounds reads as the defaults; the other accounts in the file still load.
  const path = join(dataDir, "accounts.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  raw.accounts.find((a) => a.id === "limits").assistant = { maxRounds: 999, maxToolCalls: 40 };
  writeFileSync(path, JSON.stringify(raw));
  store.invalidateStoreCache();
  assert.equal(store.getAccount("limits").assistant, null);
  assert.deepEqual(store.toPublicAccount(store.getAccount("limits")).assistant, { maxRounds: 24, maxToolCalls: 40, custom: false });
});
