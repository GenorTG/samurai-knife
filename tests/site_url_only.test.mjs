// A website without a repository (docs/WEBSITE-STUDIO.md "Without a repository"): which addresses a public-mode
// non-admin may check, and the ownership proof (meta tag) parser.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/site_url_only.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

process.env.KNIFE_AUTH_MODE = "public";
const { siteTargetProblem, hasVerificationMeta } = await import("../src/lib/site/ownership.ts");

const user = { id: "u", role: "user", approvedSiteUrl: null };
const site = (verifiedOrigin = "") => ({ url: "https://me.example", verifiedOrigin });

test("no repository: only the saved address, and only once verified (or admin-approved)", () => {
  assert.match(siteTargetProblem(user, null, "https://me.example/", site()), /not verified yet/);
  assert.equal(siteTargetProblem(user, null, "https://me.example/about", site("https://me.example")), null);
  assert.match(siteTargetProblem(user, null, "https://other.example/", site("https://me.example")), /your own website only/);
  assert.equal(siteTargetProblem({ ...user, approvedSiteUrl: "https://www.me.example" }, null, "https://me.example/", site()), null);
  assert.match(siteTargetProblem(user, null, "https://me.example/", null), /add your website first/);
  assert.equal(siteTargetProblem({ ...user, role: "admin" }, null, "https://anything.example/", null), null, "admins are not limited");
});

test("the verification meta tag: exact token, any attribute order and quoting, nothing else counts", () => {
  const token = "sk-abc123";
  assert.ok(hasVerificationMeta(`<head><meta name="smart-knife-verification" content="${token}"></head>`, token));
  assert.ok(hasVerificationMeta(`<META content='${token}' NAME=smart-knife-verification />`, token));
  assert.ok(!hasVerificationMeta(`<meta name="smart-knife-verification" content="sk-other">`, token));
  assert.ok(!hasVerificationMeta(`<p>smart-knife-verification ${token}</p>`, token));
  assert.ok(!hasVerificationMeta(`<meta name="description" content="${token}">`, token));
});
