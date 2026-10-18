// A fake world for the website studio tests: an in-memory GitHub REST API (repo, branches, commits via the Git Data
// API, contents, compare, pull requests, merge, statuses, deployments with a preview URL), a small website (pages,
// robots.txt, sitemap.xml, a real 404) and a PageSpeed Insights endpoint. Loopback only.
//
//   node tests/mock_site_world.mjs <github-port> <site-port> <psi-port>     (prints READY when listening)
//
// GitHub token accepted: TOKEN below (Bearer). Repo: genor/website, default branch main.
import { createHash } from "node:crypto";
import http from "node:http";

export const TOKEN = "ghp_mockTokenForSiteStudioTests000000";
export const REPO = "genor/website";

function sha(text) {
  return createHash("sha1").update(text).digest("hex");
}

export function createGithub(initialFiles) {
  const commits = new Map(); // sha -> { files: Map(path->content), parents: [], message, date }
  const trees = new Map(); // tree sha -> Map
  const branches = new Map();
  const pulls = [];
  const deployments = []; // { id, sha, statuses: [] }
  const calls = [];
  // Repository "Website" and GitHub Pages domain (site ownership proof, src/lib/site/ownership.ts); tests may change them.
  const meta = { homepage: process.env.MOCK_REPO_HOMEPAGE ?? "", pagesCname: process.env.MOCK_PAGES_CNAME ?? "" };
  let seq = 0;
  const mkCommit = (files, parents, message) => {
    const treeSha = sha(`tree${seq++}${JSON.stringify([...files])}`);
    trees.set(treeSha, files);
    const s = sha(`commit${seq++}${message}${treeSha}`);
    commits.set(s, { files, parents, message, date: new Date().toISOString(), tree: treeSha });
    return s;
  };
  branches.set("main", mkCommit(new Map(Object.entries(initialFiles)), [], "initial"));
  const ancestors = (s) => {
    const out = [];
    const walk = (x) => {
      if (!x || out.includes(x)) return;
      out.push(x);
      for (const p of commits.get(x)?.parents ?? []) walk(p);
    };
    walk(s);
    return out;
  };
  const resolveRef = (ref) => branches.get(ref) ?? (commits.has(ref) ? ref : null);
  const deploy = (s) => {
    // Like Vercel: every pushed commit gets a deployment whose success status carries the preview URL.
    const id = deployments.length + 1;
    // MOCK_PREVIEW_URL (e2e): point previews at the mock site so they can be audited.
    deployments.push({ id, sha: s, environment: "Preview", statuses: [{ state: "success", environment_url: process.env.MOCK_PREVIEW_URL || `https://preview-${s.slice(0, 7)}.example.test` }] });
  };
  const pullJson = (p) => ({
    number: p.number, html_url: `https://github.com/${REPO}/pull/${p.number}`, title: p.title, body: p.body, state: p.state,
    merged: p.merged, merged_at: p.merged ? p.mergedAt : null, draft: false, head: { ref: p.head, sha: branches.get(p.head) ?? p.headSha }, base: { ref: p.base },
    mergeable: true, mergeable_state: "clean",
  });

  function handle(method, url, body, auth) {
    calls.push(`${method} ${url.pathname}`);
    if (auth !== `Bearer ${TOKEN}`) return [401, { message: "Bad credentials" }];
    const p = url.pathname;
    const base = `/repos/${REPO}`;
    if (p === "/user") return [200, { login: "genor" }];
    if (p === "/search/code") {
      const q = (url.searchParams.get("q") ?? "").replace(/repo:\S+/, "").trim().toLowerCase();
      const files = commits.get(branches.get("main")).files;
      return [200, { items: [...files].filter(([, c]) => c.toLowerCase().includes(q)).map(([path, c]) => ({ path, text_matches: [{ fragment: c.slice(Math.max(0, c.toLowerCase().indexOf(q) - 20), c.toLowerCase().indexOf(q) + 40) }] })) }];
    }
    if (!p.startsWith(base)) return [404, { message: "Not Found" }];
    const rest = p.slice(base.length);
    if (rest === "") return [200, { full_name: REPO, default_branch: "main", private: true, permissions: { push: true }, html_url: `https://github.com/${REPO}`, homepage: meta.homepage, description: "my site", pushed_at: new Date().toISOString() }];
    if (rest === "/pages" && method === "GET") return meta.pagesCname ? [200, { cname: meta.pagesCname, html_url: `https://${meta.pagesCname}/` }] : [404, { message: "Not Found" }];
    let m;
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && method === "GET") {
      const s = branches.get(decodeURIComponent(m[1]));
      return s ? [200, { object: { sha: s } }] : [404, { message: "Not Found" }];
    }
    if ((m = /^\/git\/trees\/(.+)$/.exec(rest)) && method === "GET") {
      const s = resolveRef(decodeURIComponent(m[1]));
      if (!s) return [404, { message: "Not Found" }];
      const files = commits.get(s).files;
      const dirs = new Set();
      for (const path of files.keys()) path.split("/").slice(0, -1).forEach((_, i, parts) => dirs.add(parts.slice(0, i + 1).join("/")));
      return [200, { truncated: false, tree: [...[...dirs].map((d) => ({ path: d, type: "tree" })), ...[...files].map(([path, c]) => ({ path, type: "blob", size: Buffer.byteLength(c) }))] }];
    }
    if ((m = /^\/contents\/(.+)$/.exec(rest)) && method === "GET") {
      const s = resolveRef(url.searchParams.get("ref") ?? "main");
      const path = m[1].split("/").map(decodeURIComponent).join("/");
      const c = s ? commits.get(s).files.get(path) : undefined;
      if (c === undefined) return [404, { message: "Not Found" }];
      return [200, { type: "file", path, size: Buffer.byteLength(c), sha: sha(c), encoding: "base64", content: Buffer.from(c).toString("base64") }];
    }
    if (rest === "/git/refs" && method === "POST") {
      const name = body.ref.replace(/^refs\/heads\//, "");
      if (branches.has(name)) return [422, { message: "Reference already exists" }];
      branches.set(name, body.sha);
      return [201, { ref: body.ref, object: { sha: body.sha } }];
    }
    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      const name = decodeURIComponent(m[1]);
      if (method === "DELETE") return branches.delete(name) ? [204, null] : [422, { message: "Reference does not exist" }];
      if (method === "PATCH") {
        const current = branches.get(name);
        if (!current) return [422, { message: "Reference does not exist" }];
        if (!body.force && !ancestors(body.sha).includes(current)) return [422, { message: "Update is not a fast forward" }];
        branches.set(name, body.sha);
        deploy(body.sha);
        return [200, { object: { sha: body.sha } }];
      }
    }
    if ((m = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest)) && method === "GET") {
      const c = commits.get(m[1]);
      return c ? [200, { sha: m[1], tree: { sha: c.tree }, message: c.message }] : [404, { message: "Not Found" }];
    }
    if (rest === "/git/trees" && method === "POST") {
      const files = new Map(trees.get(body.base_tree) ?? []);
      for (const e of body.tree) {
        if (e.sha === null) files.delete(e.path);
        else files.set(e.path, e.content);
      }
      const treeSha = sha(`tree${seq++}`);
      trees.set(treeSha, files);
      return [201, { sha: treeSha }];
    }
    if (rest === "/git/commits" && method === "POST") {
      const files = trees.get(body.tree);
      const s = sha(`commit${seq++}${body.message}`);
      commits.set(s, { files, parents: body.parents, message: body.message, date: new Date().toISOString(), tree: body.tree });
      return [201, { sha: s, html_url: `https://github.com/${REPO}/commit/${s}` }];
    }
    if ((m = /^\/compare\/(.+)\.\.\.(.+)$/.exec(rest))) {
      const b = resolveRef(decodeURIComponent(m[1]));
      const h = resolveRef(decodeURIComponent(m[2]));
      if (!b || !h) return [404, { message: "Not Found" }];
      const baseAnc = ancestors(b);
      const ahead = ancestors(h).filter((x) => !baseAnc.includes(x)).reverse();
      const bf = commits.get(b).files;
      const hf = commits.get(h).files;
      const paths = new Set([...bf.keys(), ...hf.keys()]);
      const files = [...paths].filter((x) => bf.get(x) !== hf.get(x)).map((x) => ({
        filename: x, status: !bf.has(x) ? "added" : !hf.has(x) ? "removed" : "modified", additions: 1, deletions: bf.has(x) ? 1 : 0,
        patch: `@@ -1 +1 @@\n-${(bf.get(x) ?? "").slice(0, 80)}\n+${(hf.get(x) ?? "").slice(0, 80)}`,
      }));
      return [200, { ahead_by: ahead.length, behind_by: 0, html_url: "", commits: ahead.map((x) => ({ sha: x, html_url: "", commit: { message: commits.get(x).message, committer: { date: commits.get(x).date } } })), files }];
    }
    if (rest === "/pulls" && method === "GET") {
      const head = (url.searchParams.get("head") ?? "").split(":")[1];
      return [200, pulls.filter((x) => x.state === "open" && (!head || x.head === head)).map(pullJson)];
    }
    if (rest === "/pulls" && method === "POST") {
      const pr = { number: pulls.length + 1, title: body.title, body: body.body, head: body.head, base: body.base, state: "open", merged: false };
      pulls.push(pr);
      return [201, pullJson(pr)];
    }
    if ((m = /^\/pulls\/(\d+)(\/merge)?$/.exec(rest))) {
      const pr = pulls[Number(m[1]) - 1];
      if (!pr) return [404, { message: "Not Found" }];
      if (m[2] && method === "PUT") {
        const head = branches.get(pr.head);
        if (body.sha && body.sha !== head) return [409, { message: "Head branch was modified" }];
        const merged = mkCommit(new Map(commits.get(head).files), [branches.get(pr.base)], body.commit_title ?? pr.title);
        branches.set(pr.base, merged);
        Object.assign(pr, { state: "closed", merged: true, mergedAt: new Date().toISOString(), headSha: head });
        return [200, { sha: merged, merged: true }];
      }
      if (method === "PATCH") {
        Object.assign(pr, Object.fromEntries(Object.entries(body).filter(([k]) => ["title", "body", "state"].includes(k))));
        return [200, pullJson(pr)];
      }
      return [200, pullJson(pr)];
    }
    if ((m = /^\/commits\/([0-9a-f]+)\/status$/.exec(rest))) return [200, { state: "success", statuses: [{ context: "Vercel", state: "success", target_url: `https://vercel.example.test/${m[1].slice(0, 7)}`, description: "Deployment has completed" }] }];
    if ((m = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(rest))) return [200, { check_runs: [] }];
    if (rest === "/deployments") return [200, deployments.filter((d) => d.sha === url.searchParams.get("sha")).map((d) => ({ id: d.id, sha: d.sha, environment: d.environment }))];
    if ((m = /^\/deployments\/(\d+)\/statuses$/.exec(rest))) return [200, deployments[Number(m[1]) - 1]?.statuses ?? []];
    return [404, { message: `mock: no route ${method} ${rest}` }];
  }
  return { handle, branches, commits, pulls, calls, meta, fileAt: (ref, path) => commits.get(resolveRef(ref))?.files.get(path) };
}

export const SITE_PAGES = {
  "/": `<!doctype html><html lang="pl"><head><title>Jan Kowalski | Inżynier AI i automatyzacji</title>
<meta name="description" content="Buduję systemy AI, automatyzację i infrastrukturę dla małych firm. Lokalne modele, Docker, Tailscale. Napisz, a odpowiem w 24 h.">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="/"><link rel="icon" href="/favicon.ico">
<meta property="og:title" content="Jan Kowalski"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"Jan Kowalski"}</script></head>
<body><header><nav><a href="/projekty">Projekty</a> <a href="mailto:jan@example.test">Napisz do mnie</a></nav></header>
<main><h1>Systemy AI, które działają u Ciebie</h1><p>Pomagam firmom wdrożyć lokalne modele językowe i automatyzację. Zrealizowałem 12 projektów dla klientów z Polski.</p>
<h2>Projekty</h2><p>Samurai Knife to zestaw narzędzi w przeglądarce. Finetune Studio uczy modele na Twoich plikach. Używam Python, Docker i Next.js.</p>
<img src="/a.png"><p>Kompleksowe i innowacyjne rozwiązania to nie moja bajka. Wolę konkretne wyniki: 40% mniej pracy ręcznej w biurze klienta.</p>
<a href="https://github.com/janko">GitHub</a> <a href="https://www.linkedin.com/in/janko">LinkedIn</a></main>
<footer>© 2023 Jan Kowalski</footer></body></html>`,
  "/projekty": `<!doctype html><html lang="pl"><head><title>Projekty</title><meta name="viewport" content="width=device-width"></head><body><h2>Projekty</h2><p>Krótko.</p></body></html>`,
};

export function createSite() {
  const hits = [];
  function handle(method, url) {
    hits.push(url.pathname);
    if (url.pathname === "/robots.txt") return [200, "text/plain", "User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n"];
    if (url.pathname === "/sitemap.xml") return [200, "application/xml", "<urlset><url><loc>/</loc></url></urlset>"];
    if (SITE_PAGES[url.pathname] !== undefined) return [200, "text/html; charset=utf-8", SITE_PAGES[url.pathname]];
    return [404, "text/html", "<h1>404</h1>"];
  }
  return { handle, hits };
}

export function psiBody(score = 0.72) {
  return {
    lighthouseResult: {
      categories: {
        performance: { score, auditRefs: [{ id: "largest-contentful-paint", weight: 25 }, { id: "render-blocking-resources", weight: 0 }] },
        accessibility: { score: 0.91, auditRefs: [{ id: "image-alt", weight: 10 }] },
        "best-practices": { score: 1, auditRefs: [] },
        seo: { score: 0.85, auditRefs: [{ id: "meta-description", weight: 1 }] },
      },
      audits: {
        "first-contentful-paint": { score: 0.8, displayValue: "1.9 s" },
        "largest-contentful-paint": { score: 0.4, displayValue: "4.1 s", title: "Largest Contentful Paint", scoreDisplayMode: "numeric" },
        "total-blocking-time": { score: 0.6, displayValue: "420 ms" },
        "cumulative-layout-shift": { score: 1, displayValue: "0.01" },
        "speed-index": { score: 0.7, displayValue: "3.0 s" },
        "image-alt": { score: 0, title: "Image elements do not have [alt] attributes", scoreDisplayMode: "binary" },
        "meta-description": { score: 1, title: "Document has a meta description", scoreDisplayMode: "binary" },
      },
    },
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export function serveGithub(gh, port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const raw = await readBody(req);
    const [status, body] = gh.handle(req.method, url, raw ? JSON.parse(raw) : null, req.headers.authorization);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === null ? "" : JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

export function serveSite(site, port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const [status, type, body] = site.handle(req.method, url);
    res.writeHead(status, { "content-type": type, "x-content-type-options": "nosniff" });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

export function servePsi(port = 0, scoreRef = { value: 0.72 }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(psiBody(scoreRef.value)));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, requests })));
}

export const INITIAL_FILES = {
  "AGENTS.md": "# Website rules\nCopy lives in lib/site-data.ts. Keep Polish first.\n",
  "lib/site-data.ts": 'export const hero = "Systemy AI, które działają u Ciebie";\nexport const projects = ["Samurai Knife"];\n',
  "app/page.tsx": "export default function Page() { return null; }\n",
  ".github/workflows/ci.yml": "on: push\n",
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const [ghPort, sitePort, psiPort] = process.argv.slice(2).map(Number);
  const gh = createGithub(INITIAL_FILES);
  await serveGithub(gh, ghPort || 0);
  await serveSite(createSite(), sitePort || 0);
  await servePsi(psiPort || 0);
  console.log("READY");
}
