// A fake GitHub App world for tests (docs/GITHUB.md), on top of tests/mock_site_world.mjs:
// - API: POST /app-manifests/<code>/conversions (a fresh RSA key), /app/installations/<id>/access_tokens (verifies the
//   app JWT: RS256 with the app's key, iss = client id, not expired), /installation/repositories, /user, /user/emails,
//   /user/installations; repository routes accept installation tokens only for the repositories they were minted for.
// - Web (github.com): POST /settings/apps/new (the manifest form) -> redirect_url?code&state; GET /apps/<slug>/
//   installations/new -> setup_url?installation_id&setup_action; GET /login/oauth/authorize -> redirect_uri?code&state;
//   POST /login/oauth/access_token (checks client secret and the PKCE verifier). POST /__mock/user {login} switches who
//   is "signed in on github.com".
// - Per-user access (audit H1): installation 7 holds two repositories; alice administers both, carol (a member who sees the
//   installation) may only read genor/website and cannot see genor/private-notes. GET /user/installations/<id>/repositories
//   (user token) lists only what that user can access, with `permissions`; GET /repos/<repo>/collaborators/<login>/permission
//   (installation token) answers the current right. POST /__mock/access {repo, login, permission|null} changes it.
//
//   node tests/mock_github_app.mjs <api-port> <web-port> <site-port> <psi-port>    (prints READY)
import { createHash, createPublicKey, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import http from "node:http";
import { createGithub, createSite, INITIAL_FILES, REPO, servePsi, serveSite, TOKEN } from "./mock_site_world.mjs";

export const USERS = {
  alice: { id: 1001, login: "alice", name: "Alice Nowak", email: "alice@example.org", installations: [7] },
  mallory: { id: 2002, login: "mallory", name: "Mallory", email: "mallory@example.org", installations: [] },
  bob: { id: 3003, login: "bobgh", name: "Bob", email: "bob@example.org", installations: [] },
  noemail: { id: 4004, login: "ghost", name: "", email: null, installations: [] },
  carol: { id: 5005, login: "carol", name: "Carol", email: "carol@example.org", installations: [7] },
};
export const PRIVATE_REPO = "genor/private-notes";
export const INSTALLATIONS = { 7: { id: 7, account: "genor", repos: [REPO, PRIVATE_REPO] } };
/** Who may do what where: repo -> login -> admin | write | read. */
export const INITIAL_ACCESS = { [REPO]: { alice: "admin", carol: "read" }, [PRIVATE_REPO]: { alice: "admin" } };

const PERMS = {
  admin: { admin: true, maintain: true, push: true, triage: true, pull: true },
  write: { admin: false, maintain: false, push: true, triage: true, pull: true },
  read: { admin: false, maintain: false, push: false, triage: false, pull: true },
};

const b64 = (s) => Buffer.from(s, "base64url").toString("utf8");

export function createAppWorld() {
  const gh = createGithub(INITIAL_FILES);
  const state = {
    app: null, // { id, slug, client_id, client_secret, publicKey, manifest }
    webUser: "alice",
    codes: new Map(), // oauth code -> { user, challenge, redirect_uri }
    manifestCodes: new Map(),
    userTokens: new Map(), // ghu_ -> user key
    installTokens: new Map(), // ghs_ -> { installation, repos }
    minted: [], // { installation, repositories } requests seen
    access: JSON.parse(JSON.stringify(INITIAL_ACCESS)),
  };

  function verifyJwt(auth) {
    if (!state.app || !auth?.startsWith("Bearer ")) return false;
    const [h, p, sig] = auth.slice(7).split(".");
    if (!sig) return false;
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    if (!verifier.verify(state.app.publicKey, Buffer.from(sig, "base64url"))) return false;
    const payload = JSON.parse(b64(p));
    const now = Math.floor(Date.now() / 1000);
    return payload.iss === state.app.client_id && payload.exp > now && payload.exp - payload.iat <= 660;
  }

  function api(method, url, body, auth) {
    const p = url.pathname;
    let m;
    if ((m = /^\/app-manifests\/([^/]+)\/conversions$/.exec(p)) && method === "POST") {
      const manifest = state.manifestCodes.get(m[1]);
      if (!manifest) return [404, { message: "Not Found" }];
      state.manifestCodes.delete(m[1]);
      const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const slug = manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      state.app = { id: 99, slug, client_id: "Iv1.mockclient", client_secret: "mock-client-secret", publicKey: createPublicKey(publicKey.export({ type: "spki", format: "pem" })), manifest };
      return [201, { id: 99, slug, name: manifest.name, client_id: "Iv1.mockclient", client_secret: "mock-client-secret", webhook_secret: "whsec", pem: privateKey.export({ type: "pkcs8", format: "pem" }), owner: { login: "genor" }, html_url: `https://github.example.test/apps/${slug}` }];
    }
    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p)) && method === "POST") {
      if (!verifyJwt(auth)) return [401, { message: "A JSON web token could not be decoded" }];
      const inst = INSTALLATIONS[m[1]];
      if (!inst) return [404, { message: "Not Found" }];
      const wanted = body?.repositories ?? null;
      state.minted.push({ installation: inst.id, repositories: wanted });
      const repos = wanted ? inst.repos.filter((r) => wanted.includes(r.split("/")[1])) : inst.repos;
      if (wanted && repos.length !== wanted.length) return [422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." }];
      const token = `ghs_${randomBytes(12).toString("hex")}`;
      state.installTokens.set(token, { installation: inst.id, repos });
      return [201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString() }];
    }
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    if (p === "/installation/repositories") {
      const t = state.installTokens.get(bearer);
      if (!t) return [401, { message: "Bad credentials" }];
      return [200, { total_count: t.repos.length, repositories: t.repos.map((r) => ({ full_name: r, private: true, default_branch: "main", html_url: `https://github.com/${r}` })) }];
    }
    if ((m = /^\/user\/installations\/(\d+)\/repositories$/.exec(p))) {
      const key = state.userTokens.get(bearer);
      if (!key) return [401, { message: "Bad credentials" }];
      const u = USERS[key];
      const inst = INSTALLATIONS[m[1]];
      if (!inst || !u.installations.includes(inst.id)) return [404, { message: "Not Found" }];
      const visible = inst.repos.filter((r) => state.access[r]?.[u.login]);
      return [200, { total_count: visible.length, repositories: visible.map((r) => ({ full_name: r, private: true, default_branch: "main", html_url: `https://github.com/${r}`, permissions: PERMS[state.access[r][u.login]] })) }];
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)\/permission$/.exec(p))) {
      const t = state.installTokens.get(bearer);
      if (!t || !t.repos.includes(m[1])) return [404, { message: "Not Found" }];
      const login = decodeURIComponent(m[2]);
      const u = Object.values(USERS).find((x) => x.login === login);
      if (!u) return [404, { message: "Not Found" }];
      const level = state.access[m[1]]?.[login] ?? null;
      return [200, { permission: level ?? "none", role_name: level ?? "none", user: { login, id: u.id, permissions: level ? PERMS[level] : { admin: false, maintain: false, push: false, triage: false, pull: false } } }];
    }
    if (p === "/user" || p === "/user/emails" || p === "/user/installations") {
      const key = state.userTokens.get(bearer);
      if (!key) return [bearer.startsWith("ghs_") ? 403 : 401, { message: "Resource not accessible by integration" }];
      const u = USERS[key];
      if (p === "/user") return [200, { id: u.id, login: u.login, name: u.name }];
      if (p === "/user/emails") return [200, u.email ? [{ email: u.email, primary: true, verified: true }] : []];
      return [200, { total_count: u.installations.length, installations: u.installations.map((id) => ({ id, account: { login: INSTALLATIONS[id].account, type: "User" } })) }];
    }
    // Repository routes: an installation token works only for its own repositories (like GitHub).
    const t = state.installTokens.get(bearer);
    if (t) {
      const repoInPath = /^\/repos\/([^/]+\/[^/]+)/.exec(p)?.[1];
      if (repoInPath && !t.repos.includes(repoInPath)) return [404, { message: "Not Found" }];
      return gh.handle(method, url, body, `Bearer ${TOKEN}`);
    }
    return gh.handle(method, url, body, auth);
  }

  function web(method, url, form) {
    const p = url.pathname;
    let m;
    if (p === "/settings/apps/new" && method === "POST") {
      const manifest = JSON.parse(new URLSearchParams(form).get("manifest") ?? "{}");
      const code = `mcode${randomBytes(8).toString("hex")}`;
      state.manifestCodes.set(code, manifest);
      const back = new URL(manifest.redirect_url);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return [302, back.href];
    }
    if ((m = /^\/apps\/([^/]+)\/installations\/new$/.exec(p))) {
      if (!state.app || m[1] !== state.app.slug) return [404, "no such app"];
      const back = new URL(state.app.manifest.setup_url);
      back.searchParams.set("installation_id", "7");
      back.searchParams.set("setup_action", "install");
      return [302, back.href];
    }
    if (p === "/login/oauth/authorize") {
      if (!state.app || url.searchParams.get("client_id") !== state.app.client_id) return [400, "bad client"];
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      if (!state.app.manifest.callback_urls.includes(redirect)) return [400, "redirect_uri not registered"];
      if (url.searchParams.get("code_challenge_method") !== "S256") return [400, "PKCE required in this mock"];
      const code = `ucode${randomBytes(8).toString("hex")}`;
      state.codes.set(code, { user: state.webUser, challenge: url.searchParams.get("code_challenge"), redirect });
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return [302, back.href];
    }
    if (p === "/login/oauth/access_token" && method === "POST") {
      const body = JSON.parse(form || "{}");
      const entry = state.codes.get(body.code);
      state.codes.delete(body.code);
      if (!entry || body.client_secret !== state.app?.client_secret) return [200, JSON.stringify({ error: "bad_verification_code" })];
      if (createHash("sha256").update(body.code_verifier ?? "").digest("base64url") !== entry.challenge) return [200, JSON.stringify({ error: "invalid_grant", error_description: "PKCE verification failed" })];
      if (body.redirect_uri !== entry.redirect) return [200, JSON.stringify({ error: "redirect_uri_mismatch" })];
      const token = `ghu_${randomBytes(12).toString("hex")}`;
      state.userTokens.set(token, entry.user);
      return [200, JSON.stringify({ access_token: token, token_type: "bearer", scope: "" })];
    }
    if (p === "/__mock/access" && method === "POST") {
      const { repo, login, permission } = JSON.parse(form);
      state.access[repo] ??= {};
      if (permission) state.access[repo][login] = permission;
      else delete state.access[repo][login];
      return [200, "ok"];
    }
    if (p === "/__mock/user" && method === "POST") {
      state.webUser = JSON.parse(form).login;
      return [200, "ok"];
    }
    return [404, "mock web: not found"];
  }
  return { gh, state, api, web };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export function serveApi(world, port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const raw = await readBody(req);
    const [status, body] = world.api(req.method, url, raw ? JSON.parse(raw) : null, req.headers.authorization);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === null ? "" : JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

export function serveWeb(world, port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const raw = await readBody(req);
    const [status, body] = world.web(req.method, url, raw);
    if (status === 302) {
      res.writeHead(302, { location: body });
      res.end();
      return;
    }
    res.writeHead(status, { "content-type": body.startsWith("{") ? "application/json" : "text/plain" });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const [apiPort, webPort, sitePort, psiPort] = process.argv.slice(2).map(Number);
  const world = createAppWorld();
  await serveApi(world, apiPort || 0);
  await serveWeb(world, webPort || 0);
  await serveSite(createSite(), sitePort || 0);
  await servePsi(psiPort || 0);
  console.log("READY");
}
