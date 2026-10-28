// SERVER ONLY. Screenshots of the user's website (docs/WEBSITE-STUDIO.md "Screenshots").
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { getAccount } from "@/lib/accounts/store";
import { msg, msgf } from "@/lib/i18n/msg";
import { admitOutbound, outboundLimitMessage } from "@/lib/net/outbound";
import type { OutboundPolicy } from "@/lib/net/safe-fetch";
import { disposeDir, makeScratchDir, readArtifact, runPythonScript } from "@/lib/python";
import { isQueueFull } from "@/lib/work-queue";
import { SiteError, sitePolicy } from "@/lib/site/net";
import { putImage, type StoredImage } from "./images";
import { DEFAULT_PROXY_LIMITS, startScreenshotProxy, type ProxyStats } from "./proxy";
import type { ScreenshotTarget } from "./targets";

/**
 * Engine: the system's Chromium (Debian package `chromium`, binary `/usr/lib/chromium/chromium`; `KNIFE_CHROMIUM`
 * overrides) driven by the Python `playwright` package (server/py/requirements.txt, installed into each release's venv
 * by knife-update; only its driver is used, no browser download) through the Python lane: heavy lane, the per-account
 * share of the work queue, and in public mode the bubblewrap sandbox with no network. The browser's only way out is the
 * SSRF-checked proxy (proxy.ts) on a unix socket in the job's scratch dir. PNG/JPEG output is held in that per-job OS
 * scratch directory until the job finishes, then removed; the result lives in the in-memory image store (images.ts),
 * never in account files.
 */

export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

/** Bounds of one screenshot. */
export const SHOT_LIMITS = {
  /** Full-page height cap (px): longer pages are cut (`truncated`). */
  maxHeight: 4_000,
  /** Encoded image cap: bigger PNGs are re-encoded as JPEG, then cut shorter, until they fit. */
  maxBytes: 3_500_000,
  /** Page load budget inside the browser (the page still gets its screenshot after it). */
  loadTimeoutMs: 30_000,
  /** The whole job, browser start to file (the queue wait is extra). */
  jobTimeoutMs: 75_000,
  /** Requests the page may make (subresources included). */
  maxRequests: 300,
};

const CHROMIUM_CANDIDATES = ["/usr/lib/chromium/chromium", "/usr/lib/chromium-browser/chromium-browser", "/opt/google/chrome/chrome"];

/** The browser binary, or null when none is installed. Must be visible in the sandbox (/usr or KNIFE_PY_SANDBOX_RO). */
export function chromiumPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.KNIFE_CHROMIUM?.trim();
  const candidates = configured ? [configured] : CHROMIUM_CANDIDATES;
  for (const candidate of candidates) {
    try {
      if (path.isAbsolute(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
}

export interface ScreenshotOptions {
  viewport: ViewportName;
  fullPage?: boolean;
  format?: "png" | "jpeg";
  /** Tests: lower limits. */
  limits?: Partial<typeof SHOT_LIMITS>;
  /** Tests: the proxy's address policy instead of the account's (sitePolicy). */
  policy?: OutboundPolicy;
}

export interface ScreenshotResult {
  image: StoredImage;
  viewport: ViewportName;
  title: string;
  finalUrl: string;
  status: number | null;
  truncated: boolean;
  requests: number;
  blockedRequests: number;
  refusedConnections: number;
}

interface ScriptData {
  file: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  finalUrl: string;
  title: string;
  status: number | null;
  truncated: boolean;
  requests: number;
  blocked: number;
}

/** PNG/JPEG by magic number: the file is what the script claims, or nothing is stored. Exported for tests. */
export function sniffImage(bytes: Uint8Array): "image/png" | "image/jpeg" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

export async function takeScreenshot(accountId: string, target: ScreenshotTarget, options: ScreenshotOptions, signal?: AbortSignal): Promise<ScreenshotResult> {
  const account = getAccount(accountId);
  if (!account) throw new SiteError("unknown account", 404);
  const chromium = chromiumPath();
  if (!chromium) throw new SiteError(msg("screenshots are not set up on this server: it needs Chromium (docs/DEPLOY.md \"Screenshots\")"), 503);
  const limits = { ...SHOT_LIMITS, ...options.limits };
  const budget = admitOutbound(account, "screenshot", target.url);
  if (!budget.ok) throw new SiteError(outboundLimitMessage(budget.retryAfterSeconds), 429);

  const dir = await makeScratchDir("knife-shot-");
  let stats: ProxyStats | null = null;
  const proxy = await startScreenshotProxy(path.join(dir, "proxy.sock"), { policy: options.policy ?? sitePolicy(account), limits: DEFAULT_PROXY_LIMITS });
  try {
    const viewport = VIEWPORTS[options.viewport];
    const request = {
      url: target.url,
      allowedOrigins: target.allowedOrigins,
      ...(target.allowedPaths ? { allowedPaths: target.allowedPaths } : {}),
      viewport,
      fullPage: options.fullPage === true,
      maxHeight: limits.maxHeight,
      format: options.format ?? "png",
      quality: 80,
      maxBytes: limits.maxBytes,
      timeoutMs: limits.loadTimeoutMs,
      maxRequests: limits.maxRequests,
      chromium,
      proxySocket: proxy.socketPath,
      outFile: path.join(dir, "shot.img"),
      ...(target.hostHeaders ? { bypass: { host: target.hostHeaders.host, headers: target.hostHeaders.headers } } : {}),
    };
    let run;
    try {
      run = await runPythonScript<ScriptData>("site_screenshot.py", request, {
        lane: "heavy",
        timeoutMs: limits.jobTimeoutMs,
        owner: accountId,
        label: "site screenshot",
        signal,
        binds: { writable: [dir] },
        addressSpaceMb: 0,
      });
    } catch (error) {
      if (isQueueFull(error)) throw new SiteError(msg("the server is busy with other work: try the screenshot again in a minute"), 503);
      throw error;
    }
    stats = proxy.stats();
    if (!run.ok || !run.data) {
      const reason = run.error || msg("the screenshot failed");
      throw new SiteError(stats.refused && /ERR_|did not load/.test(reason) ? msgf("{reason} (refused by the screenshot proxy: {why})", { reason, why: stats.reasons.slice(0, 2).join("; ") }) : reason, 502);
    }
    const bytes = await readArtifact(dir, "shot.img");
    const mime = sniffImage(bytes);
    if (!mime) throw new SiteError(msg("the screenshot is not a PNG or JPEG image"), 502);
    if (bytes.byteLength > limits.maxBytes) throw new SiteError(msg("the screenshot is larger than the size limit"), 502);
    const data = run.data;
    const image = putImage({ accountId, mime, bytes, width: data.width, height: data.height, source: data.finalUrl });
    return {
      image,
      viewport: options.viewport,
      title: data.title,
      finalUrl: data.finalUrl,
      status: data.status,
      truncated: data.truncated,
      requests: data.requests,
      blockedRequests: data.blocked,
      refusedConnections: stats.refused,
    };
  } finally {
    proxy.close();
    await disposeDir(dir);
  }
}
