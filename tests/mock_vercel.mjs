// A fake Vercel REST API for the website studio's Vercel link (docs/WEBSITE-STUDIO.md "Vercel"): two projects (one
// deploys genor/website, previews protected), deployments (a created one goes QUEUED -> BUILDING -> READY on the next
// reads), build events, Protection Bypass secrets, the OAuth code exchange; plus a protected preview site that answers
// 401 without the bypass header. Used by tests/site_vercel.test.mjs (createVercel) and, as a process, by
// tests/functional/site_studio_e2e.py: `node tests/mock_vercel.mjs <apiPort> <previewPort>` prints READY.
import http from "node:http";
import { SITE_PAGES } from "./mock_site_world.mjs";

export const VTOKEN = "vercelMockToken0123456789abcdef";
export const BYPASS = "Bypass0123456789abcdefABCDEF0123";

export function createVercel(options = {}) {
  const previewBase = options.previewBase ?? null;
  const site = { id: "prj_site", name: "website", link: { type: "github", org: "genor", repo: "website", repoId: 4242, productionBranch: "main" }, ssoProtection: { deploymentType: "preview" }, protectionBypass: {} };
  const other = { id: "prj_other", name: "other", link: { type: "github", org: "genor", repo: "other", repoId: 7, productionBranch: "main" }, ssoProtection: null, protectionBypass: {} };
  const projects = [site, other];
  const deployments = [];
  const created = [];
  const calls = [];
  const advance = (d) => {
    if (!d.autoAdvance) return;
    d.state = d.state === "QUEUED" ? "BUILDING" : d.state === "BUILDING" ? "READY" : d.state;
  };
  function handle(method, url, body, auth) {
    calls.push(`${method} ${url.pathname}${url.search}`);
    if (url.pathname === "/v2/oauth/access_token") {
      const form = new URLSearchParams(body);
      if (form.get("code") === "goodcode123" && form.get("client_secret") === "secret_test") return [200, { token_type: "Bearer", access_token: VTOKEN, installation_id: "icfg_1", team_id: null }];
      return [400, { error: "invalid_grant", error_description: "bad code" }];
    }
    if (auth !== `Bearer ${VTOKEN}`) return [401, { error: { code: "forbidden", message: "Not authorized" } }];
    let m;
    if (url.pathname === "/v2/user") return [200, { user: { username: "genor" } }];
    if (url.pathname === "/v10/projects") return [200, { projects }];
    if ((m = /^\/v9\/projects\/([^/]+)$/.exec(url.pathname))) {
      const p = projects.find((x) => x.id === m[1] || x.name === m[1]);
      return p ? [200, p] : [404, { error: { message: "Project not found" } }];
    }
    if ((m = /^\/v1\/projects\/([^/]+)\/protection-bypass$/.exec(url.pathname)) && method === "PATCH") {
      const p = projects.find((x) => x.id === m[1]);
      p.protectionBypass[BYPASS] = { createdAt: 1, createdBy: "u", scope: "automation-bypass" };
      return [200, { protectionBypass: p.protectionBypass }];
    }
    if (url.pathname === "/v7/deployments") {
      const q = url.searchParams;
      const list = deployments.filter((d) => d.projectId === q.get("projectId") && (!q.get("branch") || d.meta.githubCommitRef === q.get("branch")) && (!q.get("sha") || d.meta.githubCommitSha === q.get("sha")));
      list.forEach(advance);
      return [200, { deployments: list.slice().reverse() }];
    }
    if ((m = /^\/v13\/deployments\/([^/]+)$/.exec(url.pathname)) && method === "GET") {
      const key = decodeURIComponent(m[1]);
      const d = deployments.find((x) => x.uid === key || x.url === key || x.url.replace(/^https?:\/\//, "") === key);
      return d ? [200, { ...d, id: d.uid, readyState: d.state }] : [404, { error: { message: "Deployment not found" } }];
    }
    if ((m = /^\/v3\/deployments\/([^/]+)\/events$/.exec(url.pathname))) return [200, [{ type: "command", text: "npm run build" }, { type: "stdout", text: "Compiling" }, { type: "stderr", text: "Error: boom in app/page.tsx:3" }]];
    if (url.pathname === "/v13/deployments" && method === "POST") {
      const b = JSON.parse(body);
      created.push(b);
      const n = created.length;
      const d = { uid: `dpl_new${n}`, url: previewBase ?? `website-new${n}.vercel.app`, state: "QUEUED", autoAdvance: !!previewBase, target: null, projectId: b.project, createdAt: Date.now(), meta: { githubCommitRef: b.gitSource.ref, githubCommitSha: b.gitSource.sha }, inspectorUrl: "https://vercel.com/i" };
      deployments.push(d);
      return [200, d];
    }
    return [404, { error: { message: `no mock for ${method} ${url.pathname}` } }];
  }
  return { site, other, projects, deployments, created, calls, handle };
}

export function serve(handler, port = 0) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const [status, body, headers = { "content-type": "application/json" }] = handler(req.method, new URL(req.url, "http://localhost"), Buffer.concat(chunks).toString("utf8"), req.headers.authorization, req.headers);
      res.writeHead(status, headers);
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const [apiPort, previewPort] = process.argv.slice(2).map(Number);
  const seen = [];
  // The protected preview: the site's pages only with the bypass header (Vercel's login page otherwise). GET /__seen
  // lists what reached it, for the test's oracle.
  await serve((method, url, _b, _a, headers) => {
    if (url.pathname === "/__seen") return [200, seen];
    const ok = headers["x-vercel-protection-bypass"] === BYPASS;
    seen.push({ path: url.pathname, bypass: ok });
    if (!ok) return [401, "<html><head><title>Login – Vercel</title></head><body>Vercel Authentication</body></html>", { "content-type": "text/html" }];
    const page = SITE_PAGES[url.pathname];
    return page ? [200, page, { "content-type": "text/html; charset=utf-8" }] : [404, "<html><body>not found</body></html>", { "content-type": "text/html" }];
  }, previewPort);
  const vc = createVercel({ previewBase: `http://127.0.0.1:${previewPort}` });
  await serve((method, url, body, auth) => vc.handle(method, url, body, auth), apiPort);
  console.log("READY");
}
