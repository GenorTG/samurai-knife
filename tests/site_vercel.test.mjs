// Website studio + Vercel (src/lib/site/vercel*.ts, docs/WEBSITE-STUDIO.md "Vercel") against a fake Vercel API and the
// fake GitHub of tests/mock_site_world.mjs: connect with a token (sealed, never in the view), project match by repository,
// previews of the work branch head, build logs of the linked project only, preview deploy of the work branch (existing
// commit reused, production branch refused), bypass secret (adopted, generated, header only to the deployment's own host),
// audit options for a protected preview, the OAuth state (one-time, same browser) and the code exchange.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/site_vercel.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGithub, INITIAL_FILES, REPO, serveGithub, TOKEN } from "./mock_site_world.mjs";
import { BYPASS, createVercel, serve, VTOKEN } from "./mock_vercel.mjs";

const dataDir = mkdtempSync(join(tmpdir(), "knife-vercel-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_VERCEL_CLIENT_ID = "oac_test";
process.env.KNIFE_VERCEL_CLIENT_SECRET = "secret_test";
process.env.KNIFE_VERCEL_INTEGRATION_SLUG = "smart-knife-test";

const gh = createGithub(INITIAL_FILES);
const ghServer = await serveGithub(gh);
const vc = createVercel();
const vcServer = await serve((method, url, body, auth) => vc.handle(method, url, body, auth));
process.env.KNIFE_GITHUB_API_URL = `http://127.0.0.1:${ghServer.port}`;
process.env.KNIFE_VERCEL_API_URL = `http://127.0.0.1:${vcServer.port}`;
test.after(() => {
  ghServer.server.close();
  vcServer.server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const service = await import("../src/lib/site/service.ts");
const vercelService = await import("../src/lib/site/vercel-service.ts");
const oauth = await import("../src/lib/site/vercel-oauth.ts");
const store = await import("../src/lib/site/store.ts");
const { fetchPage } = await import("../src/lib/site/net.ts");
const { accountScope } = await import("../src/lib/storage/scope.ts");

const ACC = "genor";
let head = "";
let branch = "";

test("connect with a token: wrong token refused, project matched by repository, token sealed and never in the view", async () => {
  await service.connect(ACC, { repo: REPO, token: TOKEN, productionUrl: "https://jan.example.test" });
  await assert.rejects(vercelService.vercelConnect(ACC, { token: "wrongTokenWrongToken0000" }), /refused the token/);
  const r = await vercelService.vercelConnect(ACC, { token: VTOKEN });
  assert.equal(r.project.id, "prj_site", "the one project deploying genor/website is chosen");
  assert.equal(r.view.vercel.projectId, "prj_site");
  assert.equal(r.view.vercel.user, "genor");
  assert.equal(r.view.vercel.hasBypass, false);
  assert.equal(r.projects.length, 2);
  assert.ok(!JSON.stringify(r).includes(VTOKEN), "the token never comes back");
  assert.ok(!readFileSync(accountScope(ACC).siteFile).includes(Buffer.from(VTOKEN)), "sealed at rest");
  await assert.rejects(vercelService.vercelConnect(ACC, { projectId: "prj_other" }), /deploys genor\/other, not this site's repository/);
  await assert.rejects(vercelService.vercelConnect(ACC, { bypass: "short!" }), /bypass secret/);
});

test("previews before and after a push: head deployment state drives `next`", async () => {
  const before = await vercelService.previews(ACC);
  assert.equal(before.branch, null);
  assert.match(before.next, /No work branch yet/);
  const w = await service.writeFiles(ACC, "Copy change", [{ path: "lib/site-data.ts", content: "export const x = 1;\n" }]);
  branch = w.branch;
  head = (await service.workHead(ACC)).head;
  const none = await vercelService.previews(ACC);
  assert.equal(none.branch, branch);
  assert.equal(none.headDeployment, null);
  assert.match(none.next, /knife_site_deploy/);
  vc.deployments.push({ uid: "dpl_err", url: "website-err.vercel.app", state: "ERROR", errorMessage: "Command failed", projectId: "prj_site", createdAt: Date.now(), meta: { githubCommitRef: branch, githubCommitSha: head } });
  const failed = await vercelService.previews(ACC);
  assert.equal(failed.headDeployment.id, "dpl_err");
  assert.equal(failed.headDeployment.isHead, true);
  assert.equal(failed.headDeployment.error, "Command failed");
  assert.match(failed.next, /knife_site_deploy_logs/);
  assert.equal(failed.protectedPreviews, true);
  assert.equal(failed.canReadProtected, false);
});

test("build log of the linked project only", async () => {
  const log = await vercelService.deployLog(ACC, "dpl_err");
  assert.deepEqual(log.lines, ["npm run build", "Compiling", "! Error: boom in app/page.tsx:3"]);
  vc.deployments.push({ uid: "dpl_foreign", url: "other-x.vercel.app", state: "READY", projectId: "prj_other", createdAt: Date.now(), meta: {} });
  await assert.rejects(vercelService.deployLog(ACC, "dpl_foreign"), /another Vercel project/);
  await assert.rejects(vercelService.deployLog(ACC, "../v2/user"), /not a valid deployment id/);
});

test("deploy the work branch: failed commit rebuilt, existing build reused, production branch refused", async () => {
  const first = await vercelService.deployWorkBranch(ACC);
  assert.equal(first.created, true, "only an ERROR deployment of the head existed");
  assert.deepEqual(vc.created.at(-1), { name: "website", project: "prj_site", gitSource: { type: "github", repoId: "4242", ref: branch, sha: head } });
  assert.equal("target" in vc.created.at(-1), false, "never asks for production");
  const again = await vercelService.deployWorkBranch(ACC);
  assert.equal(again.created, false, "Vercel already builds this commit");
  assert.equal(vc.created.length, 1);
  const forced = await vercelService.deployWorkBranch(ACC, true);
  assert.equal(forced.created, true);
  vc.site.link.productionBranch = branch;
  await assert.rejects(vercelService.deployWorkBranch(ACC, true), /is the production branch/);
  vc.site.link.productionBranch = "main";
});

test("bypass: generated on the project, stored, never shown; audit of a protected preview uses it without Lighthouse", async () => {
  await assert.rejects(vercelService.withVercelAudit(ACC, { target: "preview" }), /still building|QUEUED|is QUEUED/);
  for (const d of vc.deployments) if (d.meta?.githubCommitSha === head) d.state = "READY";
  await assert.rejects(vercelService.withVercelAudit(ACC, { target: "preview" }), /no bypass secret is stored/);
  const view = await vercelService.vercelGenerateBypass(ACC);
  assert.equal(view.vercel.hasBypass, true);
  assert.ok(!JSON.stringify(view).includes(BYPASS));
  const { options, note } = await vercelService.withVercelAudit(ACC, { target: "preview", lighthouse: true });
  assert.match(options.url, /^https:\/\/website-.*\.vercel\.app$/);
  assert.equal(options.lighthouse, false, "PageSpeed cannot carry the bypass and must never get the secret");
  assert.deepEqual(options.deps.hostHeaders, { host: new URL(options.url).host, headers: { "x-vercel-protection-bypass": BYPASS } });
  assert.match(note, /bypass/);
  // A URL of another project, or not a deployment at all, gets no header.
  assert.equal(await vercelService.bypassFor(ACC, "https://other-x.vercel.app/"), undefined);
  assert.equal(await vercelService.bypassFor(ACC, "https://example.com/"), undefined);
  assert.ok(await vercelService.bypassFor(ACC, "https://website-err.vercel.app/about"));
});

test("a stored bypass secret is adopted on connect when the project already has one", async () => {
  vercelService.vercelDisconnect(ACC);
  const r = await vercelService.vercelConnect(ACC, { token: VTOKEN });
  assert.equal(r.view.vercel.hasBypass, true);
});

test("fetchPage sends the host header only to its own host, never across a redirect", async () => {
  const seen = [];
  const target = await serve((method, url, _b, _a, headers) => {
    seen.push({ path: url.pathname, bypass: headers["x-vercel-protection-bypass"] ?? null });
    return [200, "<html><head><title>ok</title></head></html>", { "content-type": "text/html" }];
  });
  const origin = await serve((method, url, _b, _a, headers) => {
    seen.push({ path: url.pathname, bypass: headers["x-vercel-protection-bypass"] ?? null });
    if (url.pathname === "/go") return [302, "", { location: `http://localhost:${target.port}/landed` }];
    return [200, "<html></html>", { "content-type": "text/html" }];
  });
  try {
    const policy = { allowPrivate: true, ports: null, httpsOnly: false };
    const hostHeaders = { host: `127.0.0.1:${origin.port}`, headers: { "x-vercel-protection-bypass": BYPASS } };
    await fetchPage(`http://127.0.0.1:${origin.port}/`, policy, { hostHeaders });
    await fetchPage(`http://127.0.0.1:${origin.port}/go`, policy, { hostHeaders });
    assert.deepEqual(seen, [
      { path: "/", bypass: BYPASS },
      { path: "/go", bypass: BYPASS },
      { path: "/landed", bypass: null },
    ]);
  } finally {
    target.server.close();
    origin.server.close();
  }
});

test("OAuth: state is one-time and sealed; the code is exchanged once; the token lands on the website", async () => {
  const { state, cookie } = oauth.beginVercelFlow({ accountId: ACC, projectId: "main", returnTo: "/tools/cv-studio?tab=website", redirectUri: "https://knife.example/api/vercel/callback" });
  assert.equal(oauth.takeVercelFlow("other-state", cookie), null);
  assert.equal(oauth.takeVercelFlow(state, cookie.slice(0, -4) + "AAAA"), null, "an edited cookie does not open");
  const flow = oauth.takeVercelFlow(state, cookie);
  assert.equal(flow.accountId, ACC);
  assert.equal(oauth.takeVercelFlow(state, cookie), null, "one-time");
  assert.equal(oauth.takeVercelFlow(state, cookie, Date.now() + 11 * 60_000), null);
  assert.match(oauth.installUrl(vercelService.vercelOAuthConfig(), state), /\/integrations\/smart-knife-test\/new\?state=/);
  await assert.rejects(oauth.exchangeVercelCode(vercelService.vercelOAuthConfig(), "badcode123", flow.redirectUri), /did not give a token/);
  const got = await oauth.exchangeVercelCode(vercelService.vercelOAuthConfig(), "goodcode123", flow.redirectUri);
  assert.equal(got.token, VTOKEN);
  vercelService.vercelDisconnect(ACC);
  const r = await vercelService.storeOAuthToken(ACC, got.token, got.configurationId, got.teamId);
  assert.equal(r.view.vercel.source, "oauth");
  assert.equal(r.view.vercel.projectId, "prj_site");
});

test("no Vercel link: the tools explain how to connect; the view has no secrets", async () => {
  vercelService.vercelDisconnect(ACC);
  await assert.rejects(vercelService.previews(ACC), /Vercel is not connected/);
  await assert.rejects(vercelService.deployWorkBranch(ACC), /Vercel is not connected/);
  const { options, note } = await vercelService.withVercelAudit(ACC, { target: "production" });
  assert.deepEqual(options, { target: "production" });
  assert.equal(note, "");
  assert.equal(store.siteView(store.loadSite(ACC)).vercel, null);
});
