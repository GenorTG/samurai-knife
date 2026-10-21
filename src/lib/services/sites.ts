import { createHash } from "node:crypto";
import { createWriteStream, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { readZip } from "@/lib/office/zip";
import { ASSETS_DIR } from "./compose";
import type { SidecarDefinition, SidecarSite } from "./definitions";
import { serviceDir } from "./state";
import { appOrigins, craftProxyUrl } from "./urls";

/**
 * A definition's `sites` (the ArtCraft apps): pinned release zips -> `<serviceDir>/assets/<app>-<version>-<sha12>/<app>/`,
 * served by the sidecar's nginx under `/<app>/` with the config this module renders into `assets/conf-<hash>/nginx.conf`.
 * Downloads are checked against the pinned size and sha256 before anything is unpacked, unpacked into a temp folder and
 * renamed into place (the server never sees half an app), and the text-like files get a `.gz` twin for gzip_static.
 * Folder names carry the version and hash, so an update is a new folder + a new config (the compose command names it,
 * so the container is recreated); `pruneSites` removes the old folders once the new container is up. docs/SIDECARS.md.
 */

export class SiteError extends Error {}

const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
/** Files worth a precompressed twin (the photocraft parts are gzip already and keep their unknown extension). */
const COMPRESSIBLE = /\.(?:wasm|js|mjs|html|css|svg|json|webmanifest|txt|md|ttf|otf)$/i;
const MAX_APP_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 5000;

export function siteFolder(app: SidecarSite): string {
  return `${app.id}-${app.version}-${app.sha256.slice(0, 12)}`;
}

function assetsDir(def: SidecarDefinition): string {
  const dir = join(serviceDir(def.id), ASSETS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  return dir;
}

/** An app's `immutable` regex as an nginx location regex anchored at `/<id>` (`^/...` there, anything else matches anywhere below). */
export function immutableLocation(app: SidecarSite, pattern: string): string {
  return pattern.startsWith("^/") ? `^/${app.id}${pattern.slice(1)}` : `^/${app.id}/.*${pattern}`;
}

/**
 * The craft origin's Content-Security-Policy: what the apps need (inline bootstrap modules, WebAssembly compilation,
 * workers and fetches of their own files, blob:/data: images and media, an audio worklet) and nothing from elsewhere.
 * frame-ancestors = the app's own page origins only.
 */
export function siteCsp(ancestors: readonly string[]): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestors.length ? ancestors.join(" ") : "'none'"}`,
  ].join("; ");
}

/** A header value as an nginx string (no quotes, backslashes or variables). */
const quote = (value: string) => `"${value.replace(/["\\$]/g, "")}"`;

/** A location regex as an nginx string: braces need the quotes; nginx keeps `\.` as is and never expands `$` there. */
function quoteRegex(pattern: string): string {
  if (/["\s]|\\\\/.test(pattern)) throw new SiteError(`regex not allowed in nginx.conf: ${pattern}`);
  return `"${pattern}"`;
}

/**
 * nginx.conf for a `sites` definition (`https`: the craft origin is https, KNIFE_CRAFT_PUBLIC_URL). Own `types` table (application/wasm, text/javascript…), gzip_static for the
 * precompressed twins and no on-the-fly compression, no cookies, GET/HEAD only, dotfiles and unknown paths 404, the
 * README caching rules (hash-named files immutable for a year, everything else `no-cache` = revalidate with ETag), strict
 * headers on every answer. `absolute_redirect off` keeps `/<app>` -> `/<app>/` relative (the browser may reach the
 * container through a port mapping or the app's proxy).
 */
export function renderNginxConf(def: SidecarDefinition, ancestors: readonly string[], options: { https?: boolean } = {}): string {
  if (!def.sites) throw new SiteError(`${def.id} has no sites`);
  const target = def.sites.target;
  const headers = (cache: string) =>
    [
      `add_header Cache-Control ${quote(cache)} always;`,
      `add_header Content-Security-Policy ${quote(siteCsp(ancestors))} always;`,
      `add_header X-Content-Type-Options "nosniff" always;`,
      `add_header Referrer-Policy "no-referrer" always;`,
      // Browsers ignore COOP on plain http and Chromium logs a console error for it: https craft origins only.
      ...(options.https ? [`add_header Cross-Origin-Opener-Policy "same-origin" always;`] : []),
      `add_header Cross-Origin-Resource-Policy "same-origin" always;`,
      `add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;`,
    ].map((line) => `      ${line}`).join("\n");
  const apps = def.sites.apps.map((app) => {
    const immutable = app.immutable
      .map((pattern) => `    location ~ ${quoteRegex(immutableLocation(app, pattern))} {\n${headers("public, max-age=31536000, immutable")}\n    }`)
      .join("\n");
    return [
      `    location = /${app.id} { return 301 /${app.id}/; }`,
      `    location /${app.id}/ {`,
      `      root ${target}/${siteFolder(app)};`,
      `      index index.html;`,
      headers("no-cache"),
      immutable ? immutable.replace(/^/gm, "  ") : "",
      `    }`,
    ].filter(Boolean).join("\n");
  });
  return `# Generated by Smart Knife (src/lib/services/sites.ts) for the ${def.id} sidecar. Rewritten on every start.
worker_processes 2;
daemon off;
pid /tmp/nginx.pid;
error_log stderr warn;
events { worker_connections 512; }
http {
  types {
    text/html html;
    text/javascript js mjs;
    text/css css;
    text/plain txt md;
    application/wasm wasm;
    application/json json;
    application/manifest+json webmanifest;
    image/svg+xml svg;
    image/png png;
    image/x-icon ico;
    font/ttf ttf;
    font/otf otf;
    font/woff2 woff2;
  }
  default_type application/octet-stream;
  charset_types text/plain text/css text/javascript application/json application/manifest+json image/svg+xml;
  charset utf-8;
  client_body_temp_path /tmp/client_body;
  proxy_temp_path /tmp/proxy;
  fastcgi_temp_path /tmp/fastcgi;
  uwsgi_temp_path /tmp/uwsgi;
  scgi_temp_path /tmp/scgi;
  access_log off;
  sendfile on;
  tcp_nopush on;
  server_tokens off;
  absolute_redirect off;
  gzip off;
  gzip_static on;
  gzip_vary on;
  client_max_body_size 1k;
  keepalive_timeout 30s;
  server {
    listen 8080;
    server_name _;
    if ($request_method !~ ^(GET|HEAD)$) { return 405; }
    location = /healthz { default_type text/plain; add_header Cache-Control "no-store" always; return 200 "ok\\n"; }
    location ~ /\\. { return 404; }
${apps.join("\n")}
    location / {
${headers("no-store")}
      return 404;
    }
  }
}
`;
}

export function confFolder(conf: string): string {
  return `conf-${createHash("sha256").update(conf).digest("hex").slice(0, 12)}`;
}

/** The current config (env decides frame-ancestors) and the container command that names it. Pure: no I/O. */
export function sitesConfig(def: SidecarDefinition, env: NodeJS.ProcessEnv = process.env): { conf: string; folder: string; command: string[] } | null {
  if (!def.sites) return null;
  const conf = renderNginxConf(def, appOrigins(env), { https: craftProxyUrl(env)?.startsWith("https:") ?? false });
  const folder = confFolder(conf);
  return { conf, folder, command: ["-c", `${def.sites.target}/${folder}/nginx.conf`] };
}

/** Writes `assets/conf-<hash>/nginx.conf` when missing (cheap; every compose write calls it). */
export function writeSitesConf(def: SidecarDefinition): void {
  const config = sitesConfig(def);
  if (!config) return;
  const dir = join(assetsDir(def), config.folder);
  if (existsSync(join(dir, "nginx.conf"))) return;
  const temp = join(assetsDir(def), `.tmp-${config.folder}-${process.pid}`);
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { mode: 0o755 });
  writeFileSync(join(temp, "nginx.conf"), config.conf, { mode: 0o644 });
  chmodSync(temp, 0o755);
  try {
    renameSync(temp, dir);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    if (!existsSync(dir)) throw error;
  }
}

/** Apps whose pinned folder is not in place yet. */
export function missingSites(def: SidecarDefinition): SidecarSite[] {
  if (!def.sites) return [];
  const dir = join(serviceDir(def.id), ASSETS_DIR);
  return def.sites.apps.filter((app) => !existsSync(join(dir, siteFolder(app), app.id, "index.html")));
}

export interface SiteProgress {
  phase(text: string, percent?: number): void;
  log(line: string): void;
}

/** Downloads, verifies and unpacks every missing app. Progress = bytes of all missing zips. */
export async function installSites(def: SidecarDefinition, reporter: SiteProgress, fetcher: typeof fetch = fetch): Promise<string[]> {
  const missing = missingSites(def);
  if (!missing.length) return [];
  const total = missing.reduce((sum, app) => sum + app.bytes, 0);
  let done = 0;
  const downloads = join(serviceDir(def.id), "downloads");
  mkdirSync(downloads, { recursive: true, mode: 0o700 });
  const installed: string[] = [];
  try {
    for (const app of missing) {
      const label = `${app.name} ${app.version}`;
      const zip = join(downloads, `${siteFolder(app)}.zip`);
      let last = 0;
      await downloadVerified(app, zip, fetcher, (bytes) => {
        if (Date.now() - last < 400) return;
        last = Date.now();
        reporter.phase(`Downloading ${label} (${Math.round(bytes / 1048576)} of ${Math.round(app.bytes / 1048576)} MB)`, Math.round(((done + bytes) / total) * 100));
      });
      done += app.bytes;
      reporter.phase(`Unpacking ${label}`, Math.round((done / total) * 100));
      const files = await unpackSite(def, app, readFileSync(zip));
      rmSync(zip, { force: true });
      reporter.log(`${label}: sha256 ${app.sha256.slice(0, 16)}… verified, ${files} files unpacked`);
      installed.push(app.id);
    }
  } finally {
    rmSync(downloads, { recursive: true, force: true });
  }
  return installed;
}

async function downloadVerified(app: SidecarSite, file: string, fetcher: typeof fetch, progress: (bytes: number) => void): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(app.url, { redirect: "follow", signal: AbortSignal.timeout(15 * 60_000) });
  } catch (error) {
    throw new SiteError(`downloading ${app.url} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok || !response.body) throw new SiteError(`downloading ${app.url} failed: HTTP ${response.status}`);
  const hash = createHash("sha256");
  let seen = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > app.bytes) return callback(new SiteError(`${app.url} is larger than the pinned ${app.bytes} bytes`));
      hash.update(chunk);
      progress(seen);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), meter, createWriteStream(file, { mode: 0o600 }));
  const digest = hash.digest("hex");
  if (seen !== app.bytes || digest !== app.sha256) {
    rmSync(file, { force: true });
    throw new SiteError(`${app.name} ${app.version}: the download does not match the pinned release (${seen} bytes, sha256 ${digest}; expected ${app.bytes}, ${app.sha256})`);
  }
}

/** The path of a zip entry below the release's top folder, or null for the folder itself; throws on anything unexpected. */
export function siteEntryPath(app: SidecarSite, name: string): string | null {
  const top = `${app.id}-web-${app.version}/`;
  if (!name.startsWith(top)) throw new SiteError(`${app.name}: unexpected entry ${JSON.stringify(name.slice(0, 120))}`);
  const rel = name.slice(top.length);
  if (!rel || rel.endsWith("/")) return null;
  const parts = rel.split("/");
  if (parts.length > 8 || parts.some((part) => !SEGMENT.test(part) || part === "." || part === "..")) {
    throw new SiteError(`${app.name}: entry name not allowed ${JSON.stringify(name.slice(0, 120))}`);
  }
  return rel;
}

const gzipAsync = promisify(gzip);

async function unpackSite(def: SidecarDefinition, app: SidecarSite, buffer: Buffer): Promise<number> {
  const zip = readZip(buffer, MAX_APP_BYTES, MAX_ENTRY_BYTES);
  const names = zip.names();
  if (names.length > MAX_ENTRIES) throw new SiteError(`${app.name}: too many entries`);
  const dir = assetsDir(def);
  const folder = siteFolder(app);
  const temp = join(dir, `.tmp-${folder}-${process.pid}`);
  rmSync(temp, { recursive: true, force: true });
  const root = join(temp, app.id);
  const files = new Set<string>();
  try {
    for (const name of names) {
      const rel = siteEntryPath(app, name);
      // Dotfiles (.htaccess) are never served.
      if (!rel || rel.split("/").some((part) => part.startsWith("."))) continue;
      const data = zip.read(name);
      if (!data) continue;
      const out = join(root, ...rel.split("/"));
      mkdirSync(join(out, ".."), { recursive: true, mode: 0o755 });
      writeFileSync(out, data, { mode: 0o644 });
      files.add(rel);
    }
    if (!files.has("index.html")) throw new SiteError(`${app.name}: the release has no index.html`);
    for (const rel of files) {
      if (!COMPRESSIBLE.test(rel) || files.has(`${rel}.gz`)) continue;
      const path = join(root, ...rel.split("/"));
      if (statSync(path).size < 1024) continue;
      writeFileSync(`${path}.gz`, await gzipAsync(readFileSync(path), { level: 9 }), { mode: 0o644 });
    }
    for (const sub of [temp, ...listDirs(temp)]) chmodSync(sub, 0o755);
    rmSync(join(dir, folder), { recursive: true, force: true });
    renameSync(temp, join(dir, folder));
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  return files.size;
}

function listDirs(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(root, entry.name);
    out.push(full, ...listDirs(full));
  }
  return out;
}

/** Removes app and config folders that the current pins and config no longer name (after the new container is up). */
export function pruneSites(def: SidecarDefinition): string[] {
  const config = sitesConfig(def);
  if (!config || !def.sites) return [];
  const dir = join(serviceDir(def.id), ASSETS_DIR);
  if (!existsSync(dir)) return [];
  const wanted = new Set([config.folder, ...def.sites.apps.map(siteFolder)]);
  const removed: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (wanted.has(entry)) continue;
    const full = join(dir, entry);
    // Another process may be unpacking right now.
    if (entry.startsWith(".tmp-") && Date.now() - statSync(full).mtimeMs < 10 * 60_000) continue;
    rmSync(full, { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}
