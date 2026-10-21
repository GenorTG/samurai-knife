import { createHash } from "node:crypto";
import { createWriteStream, chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { readZip } from "@/lib/office/zip";
import { ASSETS_DIR } from "./compose";
import type { SidecarDefinition, SidecarSite } from "./definitions";
import { compareVersions, readChannel, type SiteRelease } from "./site-channel";
import { serviceDir } from "./state";
import { appOrigins, craftProxyUrl } from "./urls";

/**
 * A definition's `sites` (the Craft apps): release zips -> `<serviceDir>/releases/<app>-<version>-<sha12>/<app>/`
 * (several versions side by side, for rollback), the ACTIVE release of each app materialized as hard links into the
 * content dir `<servicesRoot>/<id>-content/<app>/` (with a `.knife-version` marker), served by the sidecar's nginx under
 * `/<app>/` with the config this module renders into `<serviceDir>/assets/conf-<hash>/nginx.conf`. The config names no
 * version, so switching a release only touches the content dir: no compose change, no container restart, and with the
 * root helper no `knife-sidecar sync` (the helper's `content` verb copies the content dir). Which release is active:
 * the update channel (site-channel.ts), never below the definition's pin. Downloads are checked against size and
 * sha256 before anything is unpacked, unpacked into a temp folder and renamed into place, and text-like files get a
 * `.gz` twin for gzip_static. docs/SIDECARS.md "ArtCraft".
 */

export class SiteError extends Error {}

const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
/** Files worth a precompressed twin (the photocraft parts are gzip already and keep their unknown extension). */
const COMPRESSIBLE = /\.(?:wasm|js|mjs|html|css|svg|json|webmanifest|txt|md|ttf|otf)$/i;
const MAX_APP_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 5000;

export const CONTENT_MARKER = ".knife-version";
/**
 * Smart Knife's own static files on the craft origin (`/knife-bridge/`, e.g. the account-sync bridge page): served from
 * the content dir like an app, so adding or changing them needs no `knife-sidecar sync` either.
 */
export const BRIDGE_FOLDER = "knife-bridge";
const RELEASES_DIR = "releases";
const LEGACY_FOLDER = /^([a-z][a-z0-9-]{0,31})-(\d{1,4}\.\d{1,4}\.\d{1,4})-([0-9a-f]{12})$/;

/** The definition's pinned release of an app (the floor of the update channel). */
export function pinRelease(app: SidecarSite): SiteRelease {
  return { version: app.version, sha256: app.sha256, bytes: app.bytes, url: app.url };
}

export function releaseFolder(app: Pick<SidecarSite, "id">, release: Pick<SiteRelease, "version" | "sha256">): string {
  return `${app.id}-${release.version}-${release.sha256.slice(0, 12)}`;
}

/** The pinned release's folder name. */
export function siteFolder(app: SidecarSite): string {
  return releaseFolder(app, pinRelease(app));
}

/** The release an app serves: the channel's `active` unless the pin is newer (a code release raised the floor). */
export function activeRelease(def: SidecarDefinition, app: SidecarSite): SiteRelease {
  const active = readChannel(def.id).apps[app.id]?.active;
  return active && compareVersions(active.version, app.version) >= 0 ? active : pinRelease(app);
}

function assetsDir(def: SidecarDefinition): string {
  const dir = join(serviceDir(def.id), ASSETS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  return dir;
}

export function releasesDir(def: SidecarDefinition): string {
  const dir = join(serviceDir(def.id), RELEASES_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  return dir;
}

/** `<servicesRoot>/<id>-content`: a sibling of the service dir, mounted read-only (compose: `../<id>-content`). */
export function contentDir(def: SidecarDefinition): string {
  const dir = join(dirname(serviceDir(def.id)), `${def.id}-content`);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  return dir;
}

/** `<releases>/<folder>/<app>`: an unpacked release. */
export function releaseRoot(def: SidecarDefinition, app: SidecarSite, release: SiteRelease): string {
  return join(serviceDir(def.id), RELEASES_DIR, releaseFolder(app, release), app.id);
}

export function releaseInstalled(def: SidecarDefinition, app: SidecarSite, release: SiteRelease): boolean {
  return existsSync(join(releaseRoot(def, app, release), "index.html"));
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
  const contentTarget = def.sites.contentTarget;
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
      `      root ${contentTarget};`,
      `      index index.html;`,
      headers("no-cache"),
      immutable ? immutable.replace(/^/gm, "  ") : "",
      `    }`,
    ].filter(Boolean).join("\n");
  });
  apps.push([
    `    location /${BRIDGE_FOLDER}/ {`,
    `      root ${contentTarget};`,
    `      index index.html;`,
    headers("no-cache"),
    `    }`,
  ].join("\n"));
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

/**
 * Moves release folders an older layout unpacked into `assets/` (`<app>-<version>-<sha12>/`) into `releases/`, so an
 * upgrade keeps the downloads instead of fetching every app again. Returns the moved folder names.
 */
export function migrateLegacyAssets(def: SidecarDefinition): string[] {
  if (!def.sites) return [];
  const assets = join(serviceDir(def.id), ASSETS_DIR);
  if (!existsSync(assets)) return [];
  const known = new Set(def.sites.apps.map((app) => app.id));
  const moved: string[] = [];
  for (const entry of readdirSync(assets, { withFileTypes: true })) {
    const match = LEGACY_FOLDER.exec(entry.name);
    if (!entry.isDirectory() || !match || !known.has(match[1]) || !existsSync(join(assets, entry.name, match[1], "index.html"))) continue;
    const target = join(releasesDir(def), entry.name);
    if (existsSync(target)) rmSync(join(assets, entry.name), { recursive: true, force: true });
    else renameSync(join(assets, entry.name), target);
    moved.push(entry.name);
  }
  return moved;
}

/** Apps whose active release is not unpacked yet. */
export function missingSites(def: SidecarDefinition): SidecarSite[] {
  if (!def.sites) return [];
  return def.sites.apps.filter((app) => !releaseInstalled(def, app, activeRelease(def, app)));
}

export interface SiteProgress {
  phase(text: string, percent?: number): void;
  log(line: string): void;
}

/** Downloads, verifies and unpacks the active release of every app that lacks it. Progress = bytes of all missing zips. */
export async function installSites(def: SidecarDefinition, reporter: SiteProgress, fetcher: typeof fetch = fetch): Promise<string[]> {
  migrateLegacyAssets(def);
  const missing = missingSites(def);
  if (!missing.length) return [];
  const releases = missing.map((app) => ({ app, release: activeRelease(def, app) }));
  const total = releases.reduce((sum, { release }) => sum + release.bytes, 0);
  let done = 0;
  const installed: string[] = [];
  for (const { app, release } of releases) {
    await installRelease(def, app, release, {
      phase: (text, percent) => reporter.phase(text, percent === undefined ? undefined : Math.round(((done + (percent / 100) * release.bytes) / total) * 100)),
      log: (line) => reporter.log(line),
    }, fetcher);
    done += release.bytes;
    installed.push(app.id);
  }
  return installed;
}

/** Downloads one release (size + sha256 checked while streaming), unpacks it into `releases/<folder>/`. Returns the file count. */
export async function installRelease(def: SidecarDefinition, app: SidecarSite, release: SiteRelease, reporter: SiteProgress, fetcher: typeof fetch = fetch): Promise<number> {
  const label = `${app.name} ${release.version}`;
  const downloads = join(serviceDir(def.id), "downloads");
  mkdirSync(downloads, { recursive: true, mode: 0o700 });
  const zip = join(downloads, `${releaseFolder(app, release)}.${process.pid}.zip`);
  try {
    let last = 0;
    await downloadVerified(app, release, zip, fetcher, (bytes) => {
      if (Date.now() - last < 400) return;
      last = Date.now();
      reporter.phase(`Downloading ${label} (${Math.round(bytes / 1048576)} of ${Math.round(release.bytes / 1048576)} MB)`, Math.round((bytes / release.bytes) * 100));
    });
    reporter.phase(`Unpacking ${label}`, 100);
    const files = await unpackSite(def, app, release, readFileSync(zip));
    reporter.log(`${label}: sha256 ${release.sha256.slice(0, 16)}… verified, ${files} files unpacked`);
    return files;
  } finally {
    rmSync(zip, { force: true });
    try {
      rmdirSync(downloads);
    } catch {
      // another download is still running
    }
  }
}

async function downloadVerified(app: SidecarSite, release: SiteRelease, file: string, fetcher: typeof fetch, progress: (bytes: number) => void): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(release.url, { redirect: "follow", signal: AbortSignal.timeout(15 * 60_000) });
  } catch (error) {
    throw new SiteError(`downloading ${release.url} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok || !response.body) throw new SiteError(`downloading ${release.url} failed: HTTP ${response.status}`);
  const hash = createHash("sha256");
  let seen = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > release.bytes) return callback(new SiteError(`${release.url} is larger than the expected ${release.bytes} bytes`));
      hash.update(chunk);
      progress(seen);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), meter, createWriteStream(file, { mode: 0o600 }));
  const digest = hash.digest("hex");
  if (seen !== release.bytes || digest !== release.sha256) {
    rmSync(file, { force: true });
    throw new SiteError(`${app.name} ${release.version}: the download does not match the release (${seen} bytes, sha256 ${digest}; expected ${release.bytes}, ${release.sha256})`);
  }
}

/** The path of a zip entry below the release's top folder, or null for the folder itself; throws on anything unexpected. */
export function siteEntryPath(app: SidecarSite, name: string, version: string = app.version): string | null {
  const top = `${app.id}-web-${version}/`;
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

async function unpackSite(def: SidecarDefinition, app: SidecarSite, release: SiteRelease, buffer: Buffer): Promise<number> {
  const zip = readZip(buffer, MAX_APP_BYTES, MAX_ENTRY_BYTES);
  const names = zip.names();
  if (names.length > MAX_ENTRIES) throw new SiteError(`${app.name}: too many entries`);
  const dir = releasesDir(def);
  const folder = releaseFolder(app, release);
  const temp = join(dir, `.tmp-${folder}-${process.pid}`);
  rmSync(temp, { recursive: true, force: true });
  const root = join(temp, app.id);
  const files = new Set<string>();
  try {
    for (const name of names) {
      const rel = siteEntryPath(app, name, release.version);
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

function listFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(root, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Checks an unpacked release before it is switched in (no browser on the server, so these are the static checks the
 * hosting notes allow): an index.html, WebAssembly to run (a `.wasm` or PhotoCraft's `app/parts.txt`), nothing larger
 * than the caps, and no file the nginx rules cache as `immutable` that kept its name but changed its bytes since the
 * previous release (a browser would keep the old one for a year). Returns the problems (empty = fine).
 */
export function checkRelease(def: SidecarDefinition, app: SidecarSite, release: SiteRelease, previous?: SiteRelease): string[] {
  const root = releaseRoot(def, app, release);
  if (!existsSync(join(root, "index.html"))) return [`${app.name} ${release.version}: no index.html`];
  const files = listFiles(root);
  const problems: string[] = [];
  if (!files.some((rel) => rel.endsWith(".wasm")) && !files.includes("app/parts.txt")) problems.push(`${app.name} ${release.version}: no WebAssembly found`);
  if (previous && previous.version !== release.version) {
    const before = releaseRoot(def, app, previous);
    // The same regexes nginx uses for its immutable locations, on the same `/<app>/<path>` request path.
    const immutable = app.immutable.map((pattern) => new RegExp(immutableLocation(app, pattern)));
    for (const rel of files) {
      if (rel.endsWith(".gz") || !immutable.some((re) => re.test(`/${app.id}/${rel}`))) continue;
      const old = join(before, ...rel.split("/"));
      if (existsSync(old) && lstatSync(old).isFile() && sha(old) !== sha(join(root, ...rel.split("/")))) {
        problems.push(`${app.name} ${release.version}: ${rel} changed but keeps its name, and browsers cache it as immutable`);
        if (problems.length > 5) break;
      }
    }
  }
  return problems;
}

/** Hard links `source` into `target` (a copy where links are impossible, e.g. another filesystem). */
function linkTree(source: string, target: string): void {
  mkdirSync(target, { mode: 0o755 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) linkTree(from, to);
    else if (entry.isFile()) {
      try {
        linkSync(from, to);
      } catch {
        copyFileSync(from, to);
        chmodSync(to, 0o644);
      }
    }
  }
}

export function markerText(release: SiteRelease): string {
  return `${release.version} ${release.sha256}\n`;
}

/** The release the content dir serves for an app now (its marker), or null. */
export function servedRelease(def: SidecarDefinition, app: SidecarSite): { version: string; sha256: string } | null {
  try {
    const [version, sha256] = readFileSync(join(contentDir(def), app.id, CONTENT_MARKER), "utf8").trim().split(" ");
    return version && sha256 ? { version, sha256 } : null;
  } catch {
    return null;
  }
}

/**
 * Makes the content dir serve each app's active release: apps whose marker differs get a fresh hard-linked copy built
 * next to the live folder and swapped in by rename (the container's read-only mount of the parent sees it at once).
 * Folders of apps the definition no longer has are removed. Returns the app ids that changed.
 */
export function activateSites(def: SidecarDefinition): string[] {
  if (!def.sites) return [];
  const dir = contentDir(def);
  const changed: string[] = [];
  for (const app of def.sites.apps) {
    const release = activeRelease(def, app);
    const source = releaseRoot(def, app, release);
    if (!existsSync(join(source, "index.html"))) continue;
    const served = servedRelease(def, app);
    if (served?.version === release.version && served.sha256 === release.sha256) continue;
    const fresh = join(dir, `.new-${app.id}-${process.pid}`);
    rmSync(fresh, { recursive: true, force: true });
    try {
      linkTree(source, fresh);
      writeFileSync(join(fresh, CONTENT_MARKER), markerText(release), { mode: 0o644 });
      const final = join(dir, app.id);
      if (existsSync(final)) {
        const retired = join(dir, `.old-${app.id}-${process.pid}`);
        rmSync(retired, { recursive: true, force: true });
        renameSync(final, retired);
        renameSync(fresh, final);
        rmSync(retired, { recursive: true, force: true });
      } else renameSync(fresh, final);
    } catch (error) {
      rmSync(fresh, { recursive: true, force: true });
      throw error;
    }
    changed.push(app.id);
  }
  const known = new Set([...def.sites.apps.map((app) => app.id), BRIDGE_FOLDER]);
  for (const entry of readdirSync(dir)) {
    if (known.has(entry)) continue;
    const full = join(dir, entry);
    if (entry.startsWith(".") && Date.now() - statSync(full).mtimeMs < 10 * 60_000) continue;
    rmSync(full, { recursive: true, force: true });
  }
  return changed;
}

/**
 * Removes what nothing names any more (after the new container is up): configs other than the current one and legacy
 * app folders in `assets/`, and releases other than each app's active, previous and pinned one.
 */
export function pruneSites(def: SidecarDefinition): string[] {
  const config = sitesConfig(def);
  if (!config || !def.sites) return [];
  const removed: string[] = [];
  const sweep = (dir: string, wanted: Set<string>) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (wanted.has(entry)) continue;
      const full = join(dir, entry);
      // Another process may be unpacking right now.
      if (entry.startsWith(".tmp-") && Date.now() - statSync(full).mtimeMs < 10 * 60_000) continue;
      rmSync(full, { recursive: true, force: true });
      removed.push(entry);
    }
  };
  migrateLegacyAssets(def);
  sweep(join(serviceDir(def.id), ASSETS_DIR), new Set([config.folder]));
  const channel = readChannel(def.id);
  const keep = new Set<string>();
  for (const app of def.sites.apps) {
    const entry = channel.apps[app.id];
    for (const release of [activeRelease(def, app), entry?.previous, pinRelease(app)]) if (release) keep.add(releaseFolder(app, release));
  }
  sweep(join(serviceDir(def.id), RELEASES_DIR), keep);
  return removed;
}
