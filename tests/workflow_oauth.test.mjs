import assert from "node:assert/strict";
import test from "node:test";
import { oauthScope, oauthTokenRequest, oauthTokenUpdate } from "../src/lib/workflows/oauth-protocol.ts";
import { CREDENTIAL_RECIPES, credentialDefaults, recipeValues } from "../src/lib/workflows/credential-recipes.ts";
import { credentialType } from "../src/lib/workflows/credential-types.ts";
import { refreshOAuth2, sendAuthorized } from "../src/lib/workflows/nodes/auth.ts";

test("OAuth scopes follow provider separators instead of silently breaking Slack", () => {
  assert.equal(oauthScope({ preset: "slack", scope: "chat:write channels:read,users:read" }), "chat:write,channels:read,users:read");
  assert.equal(oauthScope({ preset: "google", scope: "a,b c" }), "a b c");
  assert.equal(oauthScope({ preset: "meta", scope: "pages_read_engagement email" }), "pages_read_engagement,email");
  assert.equal(oauthScope({ preset: "notion" }), "");
});

test("Notion exchanges and refreshes are JSON with client Basic auth; Slack is form data", () => {
  const notion = { preset: "notion", clientId: "id: with space", clientSecret: "secret+" };
  const req = oauthTokenRequest(notion, { grant_type: "authorization_code", code: "code", redirect_uri: "https://app.test/cb" });
  assert.equal(req.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(req.body), { grant_type: "authorization_code", code: "code", redirect_uri: "https://app.test/cb" });
  assert.equal(Buffer.from(req.headers.authorization.slice(6), "base64").toString(), "id%3A%20with%20space:secret%2B");
  assert.equal(new URLSearchParams(oauthTokenRequest({ preset: "slack", clientId: "id", clientSecret: "secret" }, { code: "abc" }).body).get("code"), "abc");
  const google = oauthTokenRequest({ preset: "google", clientId: "id", clientSecret: "secret" }, { grant_type: "refresh_token", refresh_token: "r" });
  assert.equal(google.headers.authorization, undefined);
  assert.equal(new URLSearchParams(google.body).get("client_secret"), "secret");
});

test("provider token envelopes: rotating tokens, numeric string lifetimes, expiry clearing and invalid replies", () => {
  assert.deepEqual(oauthTokenUpdate({ access_token: "token", refresh_token: "rotated", expires_in: "3600" }, 1000), { accessToken: "token", refreshToken: "rotated", tokenType: "Bearer", expiresAt: 3601000 });
  assert.equal(oauthTokenUpdate({ access_token: "non-expiring" }, 1000).expiresAt, "");
  assert.equal(oauthTokenUpdate({ ok: true, access_token: "xoxb-token", token_type: "bot" }, 1000, "slack").tokenType, "Bearer");
  for (const reply of [null, [], {}, { ok: false, error: "bad_client", access_token: "secret" }, { access_token: " " }, { access_token: "abc", token_type: "Bearer\r\nX-Injected: true" }]) {
    assert.throws(() => oauthTokenUpdate(reply, 0), /OAuth token/);
  }
});

test("Notion refresh goes through safe transport, rotates and persists once; failure never reflects token", async () => {
  const calls = [];
  const saved = [];
  const credential = { id: "c1", name: "Notion", type: "oAuth2Api", data: { preset: "notion", clientId: "id", clientSecret: "client", accessToken: "old", refreshToken: "r1", tokenUrl: "https://api.notion.com/v1/oauth/token" } };
  const ctx = { now: () => 1000, services: { http: async (request) => {
    calls.push(request);
    return { status: 200, body: Buffer.from(JSON.stringify({ access_token: "new", refresh_token: "r2", expires_in: "1800" })) };
  }, updateCredential: async (id, update) => saved.push([id, update]) } };
  assert.equal(await refreshOAuth2(ctx, credential), true);
  assert.equal(calls[0].followRedirects, false);
  assert.equal(calls[0].headers["content-type"], "application/json");
  assert.equal(JSON.parse(calls[0].body).refresh_token, "r1");
  assert.equal(credential.data.refreshToken, "r2");
  assert.equal(saved.length, 1);
  ctx.services.http = async () => ({ status: 200, body: Buffer.from('{"ok":false,"error":"private-token-value"}') });
  await assert.rejects(refreshOAuth2(ctx, credential), (error) => /Reconnect/.test(error.description) && !error.message.includes("private-token-value"));
});

test("missing expiry does not cause an eager refresh; a 401 refreshes once and retries with the new token", async () => {
  const calls = [];
  const credential = { id: "c1", name: "Slack", type: "oAuth2Api", data: { preset: "slack", accessToken: "old", refreshToken: "r1", tokenUrl: "https://slack.com/api/oauth.v2.access", clientId: "id", clientSecret: "client", expiresAt: "" } };
  const ctx = { now: () => 1000, services: { http: async (request) => {
    calls.push(request);
    if (request.url.includes("oauth.v2")) return { status: 200, body: Buffer.from('{"ok":true,"access_token":"new"}') };
    return { status: request.headers.authorization === "Bearer new" ? 200 : 401 };
  } } };
  const answer = await sendAuthorized(ctx, () => ({ url: "https://slack.com/api/auth.test", method: "GET", headers: {} }), credential);
  assert.equal(answer.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://slack.com/api/auth.test");
  assert.equal(calls[2].headers.authorization, "Bearer new");
});

test("every service recipe materialises accepted, non-secret defaults including its OAuth endpoints", () => {
  assert.equal(new Set(CREDENTIAL_RECIPES.map((r) => r.id)).size, CREDENTIAL_RECIPES.length);
  for (const recipe of CREDENTIAL_RECIPES) {
    const type = credentialType(recipe.type);
    assert.ok(type, recipe.id);
    assert.equal(new URL(recipe.docsUrl).protocol, "https:");
    const values = recipeValues(recipe);
    for (const key of Object.keys(values)) assert.ok(type.fields.some((f) => f.name === key && !f.secret && !f.managed), recipe.id + ":" + key);
    if (type.oauth2) {
      assert.ok(values.authUrl.startsWith("https:"));
      assert.ok(values.tokenUrl.startsWith("https:"));
      assert.ok(values.authentication);
    }
  }
  assert.equal(credentialDefaults("smtp").port, "587");
});
