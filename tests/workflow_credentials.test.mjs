/** Sealed recipe persistence and reconnection semantics, on synthetic accounts only. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-wf-credentials-"));
process.env.KNIFE_DATA_DIR = dataDir;
delete process.env.KNIFE_AUTH_MODE;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));
const accounts = await import("../src/lib/accounts/store.ts");
const store = await import("../src/lib/workflows/server/store.ts");
const { CREDENTIAL_RECIPES, recipeValues } = await import("../src/lib/workflows/credential-recipes.ts");
accounts.mutateStore((s) => s.accounts.push(accounts.newAccountRecord({ id: "recipe-user", displayName: "Recipe test", status: "active" })));

test("service recipes save complete endpoints/auth defaults and never reveal supplied secrets", () => {
  for (const recipe of CREDENTIAL_RECIPES) {
    const data = { ...recipeValues(recipe), ...(recipe.type === "oAuth2Api" ? { clientId: "client", clientSecret: "synthetic-client-secret" } : { token: "synthetic-api-token" }) };
    const saved = store.saveCredential("recipe-user", { name: recipe.id, type: recipe.type, data });
    assert.ok(!JSON.stringify(saved).includes("synthetic-"), recipe.id);
    const stored = store.getCredential("recipe-user", saved.id);
    if (recipe.type === "oAuth2Api") {
      assert.equal(stored.data.tokenUrl, data.tokenUrl);
      assert.equal(stored.data.authentication, data.authentication);
    }
    assert.equal(store.getCredential("another-user", saved.id), null);
  }
});

test("OAuth permission/app changes invalidate previous grants, but a rename and blank saved secret preserve them", () => {
  const original = { preset: "slack", clientId: "client", clientSecret: "synthetic-secret", authUrl: "https://slack.com/oauth/v2/authorize", tokenUrl: "https://slack.com/api/oauth.v2.access", scope: "chat:write", authentication: "header" };
  for (const [field, changed] of Object.entries({ preset: "custom", clientId: "new-client", clientSecret: "new-secret", tokenUrl: "https://other.test/token", authUrl: "https://other.test/auth", scope: "chat:write,channels:read", authentication: "body" })) {
    const saved = store.saveCredential("recipe-user", { name: "connection " + field, type: "oAuth2Api", data: original });
    store.updateCredentialData("recipe-user", saved.id, { accessToken: "access", refreshToken: "refresh", connectedAt: "today", expiresAt: 9999, tokenType: "Bearer" });
    const renamed = store.saveCredential("recipe-user", { id: saved.id, name: "Renamed", type: "oAuth2Api", data: { ...original, clientSecret: "" } });
    assert.equal(renamed.connected, true);
    const updated = store.saveCredential("recipe-user", { id: saved.id, name: "Changed", type: "oAuth2Api", data: { ...original, [field]: changed } });
    assert.equal(updated.connected, false, field);
    assert.equal(store.getCredential("recipe-user", saved.id).data.refreshToken, undefined, field);
  }
});
