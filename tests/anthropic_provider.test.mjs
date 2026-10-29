// Anthropic as a provider (docs/ACCOUNTS.md "Anthropic"): the mock provider's /anthropic/v1 plays api.anthropic.com
// (400 without anthropic-version, 401 without x-api-key on /models, native paged /models, 400 on temperature < 1).
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/anthropic_provider.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-anthropic-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_STORAGE_KEY_FILE = join(dataDir, "storage.key");
delete process.env.KNIFE_AUTH_MODE;
delete process.env.KNIFE_PUBLIC_URL;

const provider = await import("../src/lib/accounts/provider.ts");
const probe = await import("../src/lib/vision/probe.ts");
const { OPEN_NET } = provider;

let mock;
let port;
let base;
const cfg = (extra = {}) => ({ baseUrl: base, apiKey: "mock-key", model: "claude-opus-mock", ...extra });
const last = async () => (await fetch(`http://127.0.0.1:${port}/__last`)).json();

test.before(async () => {
  port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });
  base = `http://127.0.0.1:${port}/anthropic/v1`;
  process.env.KNIFE_ANTHROPIC_TEST_BASE = base;
  mock = spawn(process.execPath, ["tests/mock_provider.mjs", String(port)], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/__stats`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.after(() => {
  mock?.kill();
  delete process.env.KNIFE_ANTHROPIC_TEST_BASE;
  rmSync(dataDir, { recursive: true, force: true });
});

test("only api.anthropic.com is Anthropic (no look-alike hosts)", () => {
  assert.equal(provider.isAnthropicBaseUrl("https://api.anthropic.com/v1"), true);
  assert.equal(provider.isAnthropicBaseUrl("https://API.Anthropic.com/v1/"), true);
  for (const other of ["https://api.anthropic.com.evil.example/v1", "https://evil.example/api.anthropic.com/v1", "https://anthropic.com/v1", "not a url"]) {
    assert.equal(provider.isAnthropicBaseUrl(other), false, other);
  }
});

test("Test / Load models: anthropic-version + x-api-key sent, native /models read across pages", async () => {
  const result = await provider.testProvider(cfg(), OPEN_NET);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.models, ["claude-opus-mock", "claude-sonnet-mock", "claude-text-mock"], "both pages (has_more / last_id)");
  const opus = result.modelDetails.find((m) => m.id === "claude-opus-mock");
  assert.equal(opus.displayName, "Claude Opus Mock");
  assert.equal(opus.createdAt, "2026-09-21T00:00:00Z");
  assert.equal(opus.contextLength, 1_000_000);
  assert.equal(opus.vision, true);
  assert.equal(opus.visionSource, "advertised");
  assert.deepEqual(opus.features, ["JSON output", "pdf", "reasoning"]);
  assert.equal(result.modelDetails.find((m) => m.id === "claude-text-mock").vision, false);
});

test("Anthropic errors are readable and never carry the key", async () => {
  const wrong = await provider.testProvider(cfg({ apiKey: "wrong-key-123456" }), OPEN_NET);
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /HTTP 401: invalid x-api-key \(authentication_error\)/);
  assert.doesNotMatch(wrong.error, /wrong-key-123456/);
  // Without the Anthropic defaults (another host) the same endpoint answers what the owner saw.
  delete process.env.KNIFE_ANTHROPIC_TEST_BASE;
  try {
    const bare = await provider.testProvider(cfg(), OPEN_NET);
    assert.match(bare.error, /HTTP 400: anthropic-version: header is required \(invalid_request_error\)/);
  } finally {
    process.env.KNIFE_ANTHROPIC_TEST_BASE = base;
  }
});

test("a user's own anthropic-version header wins over the default", async () => {
  const outcome = await provider.forwardChat(cfg({ extraHeaders: { "Anthropic-Version": "2026-10-21" } }), { model: "claude-opus-mock", messages: [{ role: "user", content: "hi" }] }, OPEN_NET);
  assert.equal(outcome.ok, true, outcome.error);
  const seen = await last();
  assert.equal(seen.headers["anthropic-version"], "2026-10-21");
  assert.equal(seen.headers.authorization, "Bearer mock-key", "Bearer kept for the OpenAI-compatible endpoint");
  assert.equal(seen.headers["x-api-key"], "present");
});

test("chat rounds through the compatibility layer: temperature left out, tools, image parts, streaming", async () => {
  const plain = await provider.forwardChat(cfg(), { model: "x", messages: [{ role: "user", content: "hello" }], temperature: 0.2, maxTokens: 4_000 }, OPEN_NET);
  assert.equal(plain.ok, true, plain.error);
  assert.equal(plain.result.message.content, "ECHO: hello");
  const body = (await last()).body;
  assert.equal(body.temperature, undefined, "Claude 4.7+ rejects temperature < 1");
  assert.equal(body.max_tokens, 4_000);
  assert.equal(body.model, "claude-opus-mock");

  const tools = [{ type: "function", function: { name: "knife_hash", description: "hash", parameters: { type: "object", properties: {} } } }];
  const call = await provider.forwardChat(cfg(), { model: "x", messages: [{ role: "user", content: 'CALL:knife_hash:{"text":"a"}' }], tools, temperature: 0.2 }, OPEN_NET);
  assert.equal(call.ok, true);
  assert.equal(call.result.message.tool_calls[0].function.name, "knife_hash");

  const image = await provider.forwardChat(cfg(), { model: "x", messages: [{ role: "user", content: [{ type: "text", text: "what is it" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] }] }, OPEN_NET);
  assert.equal(image.ok, true);
  assert.match(image.result.message.content, /^VISION: saw 1 image/);

  const streamed = await provider.forwardChatStream(cfg(), { model: "x", messages: [{ role: "user", content: "STREAM:3 GAP:1" }], temperature: 0.2 }, new AbortController().signal, undefined, OPEN_NET);
  assert.equal(streamed.ok, true, streamed.error);
  const text = await streamed.response.text();
  assert.match(text, /"t":"done"/);
  assert.match(text, /word1 word2 word3/);
});

test("the vision probe leaves temperature out for Anthropic too", async () => {
  const verdict = await probe.probeVision(cfg(), OPEN_NET, "mock-vision", { colours: ["red", "blue"] });
  assert.deepEqual(verdict, { vision: true, reason: "saw", status: 200 });
  assert.equal((await last()).body.temperature, undefined);
});
