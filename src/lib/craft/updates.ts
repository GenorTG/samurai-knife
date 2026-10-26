import { rmSync } from "node:fs";
import { sidecarLog } from "@/lib/logs/server";
import { ARTCRAFT_APPS, findSidecar, type SidecarDefinition, type SidecarSite } from "@/lib/services/definitions";
import { pushSiteContent, requireBackend, SidecarError, withLock } from "@/lib/services/manager";
import { compareVersions, patchChannel, readChannel, UPDATE_MODES, type AppChannel, type SiteRelease, type SitesChannel, type UpdateMode } from "@/lib/services/site-channel";
import { activateSites, activeRelease, checkRelease, installRelease, pinRelease, pruneSites, releaseInstalled, releaseRoot, servedRelease } from "@/lib/services/sites";
import { readState } from "@/lib/services/state";
import { msg, msgf } from "@/lib/i18n/msg";

/**
 * Automatic updates of the Craft apps from their upstream GitHub releases (docs/SIDECARS.md "Updates").
 *
 * One releases listing per app per check (`GET /repos/<owner>/<repo>/releases`, ETag + If-None-Match; GitHub allows 60
 * unauthenticated requests an hour per address, a check costs 13, a 403/429 stops the check and sets `retryAfter`).
 * A release qualifies when it is not a draft or pre-release, its tag is `v<x.y.z>` above the active version, it is
 * not in the definition's `knownBad`, and it has exactly the asset `<app>-web-<version>.zip` at the expected
 * download URL with a `sha256:` digest and a sane size. The zip is checked against that digest while it streams
 * (sites.ts), unpacked next to the current release, statically checked (checkRelease) and only then switched in:
 * the content dir is relinked and, with the root helper, root copies it (`content` verb, no `knife-sidecar sync`).
 * The previous release stays for one-click rollback. Modes: auto (check daily and apply), notify (check daily, an
 * admin applies), off (no scheduled checks). Every step goes to the sidecar's ops log.
 */

const ID = "craft";
const DAY_MS = 24 * 3600_000;
const MAX_ZIP = 256 * 1024 * 1024;
const VERSION_TAG = /^v(\d{1,4}\.\d{1,4}\.\d{1,4})$/;

/** Base URL of the GitHub REST API; tests point it at a local fake. */
export function releasesApi(env: NodeJS.ProcessEnv = process.env): string {
  return (env.KNIFE_CRAFT_RELEASES_API?.trim() || "https://api.github.com").replace(/\/+$/, "");
}

/** Where release assets must live (`<base>/<owner>/<repo>/releases/download/...`); tests point it at the same fake. */
export function downloadBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.KNIFE_CRAFT_DOWNLOAD_BASE?.trim() || "https://github.com").replace(/\/+$/, "");
}

interface GithubAsset {
  name?: unknown;
  size?: unknown;
  digest?: unknown;
  browser_download_url?: unknown;
}
interface GithubRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

function repoPath(app: SidecarSite): string {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(app.repo);
  if (!match) throw new Error(msgf("{name}: unexpected repository URL", { name: app.name }));
  return match[1];
}

/** The release this listing offers for `app` above `current` (null: nothing newer that qualifies), and why others were skipped. */
export function pickRelease(app: SidecarSite, current: string, listing: unknown, base: string = downloadBase()): { release: SiteRelease | null; skipped: string[] } {
  const skipped: string[] = [];
  if (!Array.isArray(listing)) return { release: null, skipped: ["the releases listing is not a list"] };
  const candidates: SiteRelease[] = [];
  for (const raw of listing as GithubRelease[]) {
    if (!raw || typeof raw !== "object" || raw.draft === true || raw.prerelease === true) continue;
    const tag = VERSION_TAG.exec(String(raw.tag_name ?? ""));
    if (!tag) continue;
    const version = tag[1];
    if (compareVersions(version, current) <= 0) continue;
    if (app.knownBad?.includes(version)) {
      skipped.push(`${version}: known not to start`);
      continue;
    }
    const name = `${app.id}-web-${version}.zip`;
    const assets = Array.isArray(raw.assets) ? (raw.assets as GithubAsset[]) : [];
    const asset = assets.find((candidate) => candidate?.name === name);
    if (!asset) {
      skipped.push(`${version}: no ${name}`);
      continue;
    }
    const url = `${base}/${repoPath(app)}/releases/download/v${version}/${name}`;
    const digest = /^sha256:([0-9a-f]{64})$/.exec(String(asset.digest ?? ""));
    const size = Number(asset.size);
    if (asset.browser_download_url !== url) skipped.push(`${version}: unexpected download URL`);
    else if (!digest) skipped.push(`${version}: no sha256 digest published`);
    else if (!Number.isInteger(size) || size <= 0 || size > MAX_ZIP) skipped.push(`${version}: size ${String(asset.size)} out of bounds`);
    else candidates.push({ version, sha256: digest[1], bytes: size, url, ...(typeof raw.published_at === "string" ? { publishedAt: raw.published_at } : {}) });
  }
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  return { release: candidates[0] ?? null, skipped };
}

function log(line: string): void {
  sidecarLog(ID)?.line("out", `[updates] ${line}`);
}

function def(): SidecarDefinition {
  const found = findSidecar(ID);
  if (!found?.sites) throw new SidecarError(msg("No Craft apps sidecar in this release."), 500);
  return found;
}

function appById(id: string): SidecarSite {
  const app = ARTCRAFT_APPS.find((candidate) => candidate.id === id);
  if (!app) throw new SidecarError(msg("Unknown app."), 404);
  return app;
}

/** Switches the content dir to the channel's active releases and, when the sidecar is installed, hands it to the runtime. */
async function serveActive(definition: SidecarDefinition): Promise<string[]> {
  const changed = activateSites(definition);
  if (changed.length && readState(ID)) {
    try {
      await pushSiteContent(await requireBackend(), definition, { log });
    } catch (error) {
      // The channel already names the new release; the next start pushes it again.
      log(`content refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
  return changed;
}

/** Downloads (if needed), checks and switches one app to `release`; `previous` becomes the rollback target. */
async function switchTo(definition: SidecarDefinition, app: SidecarSite, release: SiteRelease, how: "update" | "rollback" | "manual", fetcher: typeof fetch): Promise<void> {
  const current = activeRelease(definition, app);
  if (current.version === release.version && current.sha256 === release.sha256) return;
  if (!releaseInstalled(definition, app, release)) {
    log(`${app.id}: downloading ${release.version} (${Math.round(release.bytes / 1048576)} MB)`);
    await installRelease(definition, app, release, { phase: () => {}, log }, fetcher);
  }
  const problems = checkRelease(definition, app, release, releaseInstalled(definition, app, current) ? current : undefined);
  if (problems.length) {
    rmSync(releaseRoot(definition, app, release), { recursive: true, force: true });
    throw new SidecarError(problems.join("; "), 422);
  }
  patchChannel(ID, (channel) => {
    const entry = (channel.apps[app.id] ??= {});
    entry.previous = current;
    entry.active = release;
    entry.changedAt = new Date().toISOString();
    entry.change = how;
    delete entry.error;
  });
  log(`${app.id}: ${how} ${current.version} -> ${release.version}`);
  await serveActive(definition);
}

export interface CheckResult {
  channel: SitesChannel;
  applied: string[];
  errors: string[];
}

/**
 * Checks every app's releases; with `apply` (auto mode, or "Update all now") switches the apps that are not held to
 * their newest qualifying release. Runs under the sidecar's op lock.
 */
export async function checkCraftUpdates(options: { apply: boolean; fetcher?: typeof fetch; now?: Date } = { apply: false }): Promise<CheckResult> {
  const definition = def();
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? new Date();
  return withLock(ID, "site-update", async () => {
    const before = readChannel(ID);
    if (before.retryAfter && Date.parse(before.retryAfter) > now.getTime()) {
      throw new SidecarError(msgf("GitHub asked to wait until {retryAfter} before the next check.", { retryAfter: before.retryAfter }), 429);
    }
    const applied: string[] = [];
    const errors: string[] = [];
    let stop: string | null = null;
    for (const app of ARTCRAFT_APPS) {
      if (stop) break;
      const entry: AppChannel = readChannel(ID).apps[app.id] ?? {};
      const current = activeRelease(definition, app);
      let available: SiteRelease | null = entry.available && compareVersions(entry.available.version, current.version) > 0 ? entry.available : null;
      let etag = entry.etag;
      let error: string | undefined;
      try {
        const response = await fetcher(`${releasesApi()}/repos/${repoPath(app)}/releases?per_page=20`, {
          headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "smart-knife-craft-updates", ...(etag ? { "If-None-Match": etag } : {}) },
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        });
        if (response.status === 403 || response.status === 429) {
          const reset = Number(response.headers.get("x-ratelimit-reset"));
          const retry = Number(response.headers.get("retry-after"));
          const until = new Date(Number.isFinite(reset) && reset > 0 ? reset * 1000 : now.getTime() + (Number.isFinite(retry) && retry > 0 ? retry : 3600) * 1000);
          stop = `GitHub rate limit (HTTP ${response.status}); next check after ${until.toISOString()}`;
          patchChannel(ID, (channel) => {
            channel.retryAfter = until.toISOString();
          });
          await response.body?.cancel();
          break;
        }
        if (response.status === 304) {
          await response.body?.cancel();
        } else if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`HTTP ${response.status}`);
        } else {
          const text = await response.text();
          if (text.length > 2_000_000) throw new Error("releases listing too large");
          const picked = pickRelease(app, current.version, JSON.parse(text));
          available = picked.release;
          etag = response.headers.get("etag") ?? undefined;
          for (const reason of picked.skipped) log(`${app.id}: skipped ${reason}`);
        }
      } catch (err) {
        error = `check failed: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(`${app.name}: ${error}`);
        log(`${app.id}: ${error}`);
      }
      patchChannel(ID, (channel) => {
        const e = (channel.apps[app.id] ??= {});
        e.checkedAt = now.toISOString();
        if (etag) e.etag = etag;
        if (available) e.available = available;
        else delete e.available;
        if (error) e.error = error;
        else delete e.error;
      });
      if (available && options.apply && !entry.hold && !error) {
        try {
          await switchTo(definition, app, available, "update", fetcher);
          applied.push(`${app.name} ${available.version}`);
        } catch (err) {
          const message = `update to ${available.version} failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(`${app.name}: ${message}`);
          log(`${app.id}: ${message}`);
          patchChannel(ID, (channel) => {
            (channel.apps[app.id] ??= {}).error = message;
          });
        }
      }
    }
    const channel = patchChannel(ID, (value) => {
      value.checkedAt = now.toISOString();
      if (stop) value.error = stop;
      else {
        delete value.error;
        delete value.retryAfter;
      }
    });
    if (stop) log(stop);
    log(`check done: ${applied.length ? `updated ${applied.join(", ")}` : "nothing applied"}${errors.length ? `, ${errors.length} error(s)` : ""}`);
    if (applied.length) pruneSites(definition);
    return { channel, applied, errors };
  });
}

/** Switches one app to the release the last check found. */
export function applyCraftUpdate(appId: string, fetcher: typeof fetch = fetch): Promise<SitesChannel> {
  const definition = def();
  const app = appById(appId);
  return withLock(ID, "site-update", async () => {
    const available = readChannel(ID).apps[app.id]?.available;
    if (!available) throw new SidecarError(msgf("No newer {name} release is known; check first.", { name: app.name }), 409);
    await switchTo(definition, app, available, "manual", fetcher);
    pruneSites(definition);
    return readChannel(ID);
  });
}

/** Back to the previous release (which stays unpacked); the newer one becomes the new `previous`. */
export function rollbackCraft(appId: string): Promise<SitesChannel> {
  const definition = def();
  const app = appById(appId);
  return withLock(ID, "site-update", async () => {
    const previous = readChannel(ID).apps[app.id]?.previous;
    if (!previous || !releaseInstalled(definition, app, previous)) throw new SidecarError(msgf("{name} has no previous release to go back to.", { name: app.name }), 409);
    if (compareVersions(previous.version, app.version) < 0) throw new SidecarError(msgf("{name} {version} is older than this release's minimum {version2}.", { name: app.name, version: previous.version, version2: app.version }), 409);
    await switchTo(definition, app, previous, "rollback", fetch);
    // A rolled-back app is held, or the next automatic check would install the same release again.
    patchChannel(ID, (channel) => {
      (channel.apps[app.id] ??= {}).hold = true;
    });
    log(`${app.id}: held after the rollback`);
    return readChannel(ID);
  });
}

export function holdCraft(appId: string, hold: boolean): SitesChannel {
  const app = appById(appId);
  log(`${app.id}: ${hold ? "held" : "released"}`);
  return patchChannel(ID, (channel) => {
    const entry = (channel.apps[app.id] ??= {});
    if (hold) entry.hold = true;
    else delete entry.hold;
  });
}

export function setCraftUpdateMode(mode: UpdateMode): SitesChannel {
  if (!UPDATE_MODES.includes(mode)) throw new SidecarError(msg("Unknown mode."), 422);
  log(`mode ${mode}`);
  return patchChannel(ID, (channel) => {
    channel.mode = mode;
  });
}

export interface CraftUpdatesView {
  mode: UpdateMode;
  checkedAt: string | null;
  error: string | null;
  retryAfter: string | null;
  running: boolean;
  apps: {
    id: string;
    name: string;
    minimum: string;
    active: string;
    served: string | null;
    previous: string | null;
    available: string | null;
    availablePublishedAt: string | null;
    hold: boolean;
    error: string | null;
    knownBad: string[];
    changedAt: string | null;
    change: string | null;
  }[];
}

const RUNNING = Symbol.for("samurai-knife.craft-updates.running.v1");
function runningFlag(): { value: boolean } {
  const holder = globalThis as unknown as Record<symbol, { value: boolean } | undefined>;
  return (holder[RUNNING] ??= { value: false });
}

/** Runs a check in the background (the admin page polls the view); false when one is already running. */
export function startCraftCheck(apply: boolean): boolean {
  const flag = runningFlag();
  if (flag.value) return false;
  flag.value = true;
  void checkCraftUpdates({ apply })
    .catch((error) => log(`check failed: ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => {
      flag.value = false;
    });
  return true;
}

export function craftUpdatesView(): CraftUpdatesView {
  const definition = def();
  const channel = readChannel(ID);
  return {
    mode: channel.mode,
    checkedAt: channel.checkedAt ?? null,
    error: channel.error ?? null,
    retryAfter: channel.retryAfter ?? null,
    running: runningFlag().value,
    apps: ARTCRAFT_APPS.map((app) => {
      const entry = channel.apps[app.id] ?? {};
      const active = activeRelease(definition, app);
      return {
        id: app.id,
        name: app.name,
        minimum: pinRelease(app).version,
        active: active.version,
        served: servedRelease(definition, app)?.version ?? null,
        previous: entry.previous?.version ?? null,
        available: entry.available && compareVersions(entry.available.version, active.version) > 0 ? entry.available.version : null,
        availablePublishedAt: entry.available?.publishedAt ?? null,
        hold: entry.hold === true,
        error: entry.error ?? null,
        knownBad: app.knownBad ?? [],
        changedAt: entry.changedAt ?? null,
        change: entry.change ?? null,
      };
    }),
  };
}

const TIMER = Symbol.for("samurai-knife.craft-updates.timer.v1");

/**
 * The daily check (Next instrumentation, once per server start): first run 10-40 min after boot, then every 24 h,
 * only while the sidecar is installed and the mode is not `off`; `auto` applies, `notify` only records.
 */
export function startCraftUpdater(): void {
  const holder = globalThis as unknown as Record<symbol, unknown>;
  if (holder[TIMER] || process.env.KNIFE_CRAFT_UPDATES === "off") return;
  const tick = () => {
    try {
      if (!readState(ID)) return;
      const channel = readChannel(ID);
      if (channel.mode === "off") return;
      if (channel.checkedAt && Date.now() - Date.parse(channel.checkedAt) < DAY_MS - 3600_000) return;
      startCraftCheck(channel.mode === "auto");
    } catch (error) {
      log(`scheduled check skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const first = setTimeout(tick, (10 + Math.random() * 30) * 60_000);
  first.unref();
  const every = setInterval(tick, 3600_000);
  every.unref();
  holder[TIMER] = { first, every };
}
