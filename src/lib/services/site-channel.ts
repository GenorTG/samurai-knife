import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serviceDir } from "./state";

/**
 * Which release of each app a `sites` sidecar serves (src/lib/services/sites.ts), and what the update channel knows
 * (src/lib/craft/updates.ts). `services/<id>/channel.json` (0600), outside the helper bundle: changing it never needs
 * `knife-sidecar sync`. The definition's pins are the floor: an `active` older than the pin is ignored.
 */

export interface SiteRelease {
  version: string;
  sha256: string;
  bytes: number;
  url: string;
  publishedAt?: string;
}

export type UpdateMode = "auto" | "notify" | "off";
export const UPDATE_MODES: readonly UpdateMode[] = ["auto", "notify", "off"];

export interface AppChannel {
  /** The release served now (absent: the pin). */
  active?: SiteRelease;
  /** The release served before the last update or rollback (one-click rollback target). */
  previous?: SiteRelease;
  /** The newest acceptable upstream release the last check found (may equal active). */
  available?: SiteRelease;
  /** Held: never updated automatically (an admin can still update or roll back by hand). */
  hold?: boolean;
  /** ETag of the last releases listing (If-None-Match). */
  etag?: string;
  checkedAt?: string;
  /** Last check/update failure for this app. */
  error?: string;
  /** When `active` was switched, and how ("update" | "rollback" | "manual"). */
  changedAt?: string;
  change?: string;
}

export interface SitesChannel {
  mode: UpdateMode;
  checkedAt?: string;
  /** Last whole-check failure (rate limit, network). */
  error?: string;
  /** Retry no earlier than this (GitHub rate limit). */
  retryAfter?: string;
  apps: Record<string, AppChannel>;
}

const FILE = "channel.json";
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function isRelease(value: unknown): value is SiteRelease {
  const r = value as SiteRelease;
  return Boolean(r) && typeof r === "object" && VERSION.test(String(r.version)) && /^[0-9a-f]{64}$/.test(String(r.sha256)) &&
    Number.isInteger(r.bytes) && r.bytes > 0 && typeof r.url === "string" &&
    // https, or a loopback fake in tests (KNIFE_CRAFT_DOWNLOAD_BASE).
    (r.url.startsWith("https://") || /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(r.url));
}

function clean(raw: unknown): SitesChannel {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<SitesChannel>;
  const apps: Record<string, AppChannel> = {};
  for (const [id, entry] of Object.entries(value.apps && typeof value.apps === "object" ? value.apps : {})) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id) || !entry || typeof entry !== "object") continue;
    const e = entry as AppChannel;
    apps[id] = {
      ...(isRelease(e.active) ? { active: e.active } : {}),
      ...(isRelease(e.previous) ? { previous: e.previous } : {}),
      ...(isRelease(e.available) ? { available: e.available } : {}),
      ...(e.hold === true ? { hold: true } : {}),
      ...(typeof e.etag === "string" ? { etag: e.etag.slice(0, 200) } : {}),
      ...(typeof e.checkedAt === "string" ? { checkedAt: e.checkedAt } : {}),
      ...(typeof e.error === "string" ? { error: e.error.slice(0, 500) } : {}),
      ...(typeof e.changedAt === "string" ? { changedAt: e.changedAt } : {}),
      ...(typeof e.change === "string" ? { change: e.change } : {}),
    };
  }
  return {
    mode: UPDATE_MODES.includes(value.mode as UpdateMode) ? (value.mode as UpdateMode) : "auto",
    ...(typeof value.checkedAt === "string" ? { checkedAt: value.checkedAt } : {}),
    ...(typeof value.error === "string" ? { error: value.error.slice(0, 500) } : {}),
    ...(typeof value.retryAfter === "string" ? { retryAfter: value.retryAfter } : {}),
    apps,
  };
}

export function readChannel(id: string): SitesChannel {
  const file = join(serviceDir(id), FILE);
  if (!existsSync(file)) return clean({});
  try {
    return clean(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return clean({});
  }
}

export function writeChannel(id: string, channel: SitesChannel): SitesChannel {
  const file = join(serviceDir(id), FILE);
  const temp = `${file}.${process.pid}.tmp`;
  const value = clean(channel);
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return value;
}

export function patchChannel(id: string, patch: (channel: SitesChannel) => void): SitesChannel {
  const channel = readChannel(id);
  patch(channel);
  return writeChannel(id, channel);
}
