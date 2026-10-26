import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARTCRAFT_APPS, findSidecar, type SidecarSite } from "@/lib/services/definitions";
import { activeRelease, releaseRoot } from "@/lib/services/sites";
import { serviceDir } from "@/lib/services/state";
import { msg, msgf } from "@/lib/i18n/msg";

/**
 * Licence and notice texts of each Craft app version, for the suite's "Licences & notices" view. The release zips carry
 * LICENSE-MIT and LICENSE-APACHE (and sometimes OFL-*.txt or ATTRIBUTION.md) but not the repository's NOTICE, which lists
 * the third-party material bundled into the build (fonts, icons, word lists, model weights): that file and the licence
 * files it names are fetched once per version from the repository at the release's tag (`v<version>`) and cached next to
 * the sidecar's state, never in git. docs/LEGAL.md "Third-party components served to browsers".
 */

export interface NoticeFile {
  name: string;
  /** `release`: from the unpacked release zip; `repository`: fetched from the repo at the release tag. */
  source: "release" | "repository";
  text: string;
}

export interface AppNotices {
  app: string;
  name: string;
  version: string;
  copyright: string;
  license: string;
  repo: string;
  tagUrl: string;
  files: NoticeFile[];
  /** Files that could not be fetched (the view still shows the rest, and links the repository). */
  missing: string[];
  /** Names the NOTICE mentions that are not in the repository at that tag (404): not retried. */
  absent: string[];
}

const MAX_FILE = 512 * 1024;
const MAX_FILES = 24;
const RELEASE_FILE = /^(?:LICENSE[A-Za-z0-9._-]*|NOTICE[A-Za-z0-9._-]*|ATTRIBUTION[A-Za-z0-9._-]*|COPYING[A-Za-z0-9._-]*|OFL-[A-Za-z0-9._-]+\.txt)$/;
/** Repository paths a NOTICE points to: `assets/fonts/OFL-Inter.txt`, `ATTRIBUTION.md`. */
// A sentence's full stop may follow the name, but not another extension (`en_US-scowl-50.txt.gz` is data, not a licence).
const NOTICE_PATH = /(?:^|[\s(`'"])((?:[A-Za-z0-9_-]+\/){0,5}[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:txt|md))(?=$|[\s),;:`'"]|\.(?:$|\s))/gm;
const SAFE_PATH = /^(?:[A-Za-z0-9_-]+\/){0,5}[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export class NoticeError extends Error {}

function appOf(id: string): SidecarSite {
  const app = ARTCRAFT_APPS.find((candidate) => candidate.id === id);
  if (!app) throw new NoticeError(msg("Unknown app."));
  return app;
}

/** `storytold/photocraft` from the definition's repo URL. */
function repoPath(app: SidecarSite): string {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(app.repo);
  if (!match) throw new NoticeError(msgf("{name}: unexpected repository URL", { name: app.name }));
  return match[1];
}

/** The repository paths a NOTICE text names (deduplicated, safe relative paths only). */
export function noticePaths(notice: string): string[] {
  const out = new Set<string>();
  for (const match of notice.matchAll(NOTICE_PATH)) {
    const path = match[1];
    if (SAFE_PATH.test(path) && !path.split("/").some((part) => part === "." || part === "..")) out.add(path);
    if (out.size >= MAX_FILES) break;
  }
  return [...out];
}

function readRegular(path: string): string | null {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > MAX_FILE) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Licence files inside the unpacked release (top level of the app folder). */
export function releaseNoticeFiles(siteDir: string): NoticeFile[] {
  if (!existsSync(siteDir)) return [];
  const files: NoticeFile[] = [];
  for (const entry of readdirSync(siteDir, { withFileTypes: true })) {
    if (!entry.isFile() || !RELEASE_FILE.test(entry.name) || entry.name.endsWith(".gz")) continue;
    const text = readRegular(join(siteDir, entry.name));
    if (text !== null) files.push({ name: entry.name, source: "release", text });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

type Fetched = { kind: "ok"; text: string } | { kind: "absent" } | { kind: "error" };

async function fetchText(url: string, fetcher: typeof fetch): Promise<Fetched> {
  try {
    const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (response.status === 404) return { kind: "absent" };
    if (!response.ok || !response.body) return { kind: "error" };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_FILE) {
        await reader.cancel();
        return { kind: "absent" };
      }
      chunks.push(value);
    }
    return { kind: "ok", text: Buffer.concat(chunks).toString("utf8") };
  } catch {
    return { kind: "error" };
  }
}

/**
 * NOTICE (unless the release has it) and the licence files a NOTICE names, from the repository at the release tag.
 * `missing` = failed for now (network, 5xx: retried later); `absent` = not in the repository (404: final).
 */
export async function repositoryNoticeFiles(app: SidecarSite, version: string, local: readonly NoticeFile[], fetcher: typeof fetch = fetch): Promise<{ files: NoticeFile[]; missing: string[]; absent: string[] }> {
  const base = `https://raw.githubusercontent.com/${repoPath(app)}/v${version}/`;
  const have = new Set(local.map((file) => file.name));
  const files: NoticeFile[] = [];
  const missing: string[] = [];
  const absent: string[] = [];
  let notice = local.find((file) => file.name === "NOTICE")?.text ?? null;
  if (notice === null) {
    const got = await fetchText(`${base}NOTICE`, fetcher);
    if (got.kind === "ok") {
      notice = got.text;
      files.push({ name: "NOTICE", source: "repository", text: got.text });
    } else (got.kind === "absent" ? absent : missing).push("NOTICE");
  }
  for (const path of notice === null ? [] : noticePaths(notice)) {
    const name = path.split("/").pop() as string;
    if (have.has(name) || have.has(path) || files.some((file) => file.name === path)) continue;
    const got = await fetchText(`${base}${path}`, fetcher);
    if (got.kind === "ok") files.push({ name: path, source: "repository", text: got.text });
    else (got.kind === "absent" ? absent : missing).push(path);
  }
  return { files, missing, absent };
}

function cacheFile(app: SidecarSite, version: string): string {
  const dir = join(serviceDir("craft"), "notices");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${app.id}-${version}.json`);
}

const inflight = new Map<string, Promise<AppNotices>>();

/**
 * The notices of one app at one version (default: the version this install serves). Cached per version once complete;
 * an incomplete fetch (GitHub unreachable) is retried on the next request.
 */
export function appNotices(id: string, version?: string, fetcher: typeof fetch = fetch): Promise<AppNotices> {
  let app: SidecarSite;
  try {
    app = appOf(id);
  } catch (error) {
    return Promise.reject(error);
  }
  const def = findSidecar("craft");
  if (!def) return Promise.reject(new NoticeError(msg("No Craft apps sidecar.")));
  const served = activeRelease(def, app);
  const wanted = version ?? served.version;
  if (!VERSION.test(wanted)) return Promise.reject(new NoticeError(msg("Invalid version.")));
  const key = `${app.id}@${wanted}`;
  const running = inflight.get(key);
  if (running) return running;
  const work = (async (): Promise<AppNotices> => {
    const cache = cacheFile(app, wanted);
    const cached = readRegular(cache);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as AppNotices;
        if (parsed.app === app.id && parsed.version === wanted && Array.isArray(parsed.absent) && parsed.missing.length === 0) return parsed;
      } catch {
        /* refetch */
      }
    }
    const local = wanted === served.version ? releaseNoticeFiles(releaseRoot(def, app, served)) : [];
    const remote = await repositoryNoticeFiles(app, wanted, local, fetcher);
    const result: AppNotices = {
      app: app.id,
      name: app.name,
      version: wanted,
      // The licence's own line when the release carries it (the year moves with the project), else the repo's wording.
      copyright:
        /^Copyright \(c\).+$/im.exec(local.find((file) => file.name === "LICENSE-MIT")?.text ?? "")?.[0].trim() ??
        `Copyright (c) ArtCraft Team and the ${app.name} contributors`,
      license: app.license,
      repo: app.repo,
      tagUrl: `${app.repo}/tree/v${wanted}`,
      files: [...local, ...remote.files],
      missing: remote.missing,
      absent: remote.absent,
    };
    const temp = `${cache}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(result), { mode: 0o600 });
    renameSync(temp, cache);
    return result;
  })().finally(() => inflight.delete(key));
  inflight.set(key, work);
  return work;
}
