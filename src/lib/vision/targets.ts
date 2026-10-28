// SERVER ONLY. Where a screenshot may point (docs/WEBSITE-STUDIO.md "Screenshots").
import { getAccount } from "@/lib/accounts/store";
import { msg, msgf } from "@/lib/i18n/msg";
import { outboundBudgeted } from "@/lib/net/outbound";
import { SiteError, type NetDeps } from "@/lib/site/net";
import { sameSiteHost, siteTargetProblem } from "@/lib/site/ownership";
import * as service from "@/lib/site/service";
import { loadSite } from "@/lib/site/store";
import * as vercelService from "@/lib/site/vercel-service";

/**
 * A screenshot loads the page in a real browser, so it is held to the same "your own site only" rule as an audit or a
 * page read (src/lib/site/ownership.ts), never an arbitrary host:
 * - `production`: the connected repository's production URL, or the website saved by address; for public-mode
 *   non-admins only once verified (siteTargetProblem).
 * - `preview`: the READY preview of the work branch's head commit on the linked Vercel project (read through
 *   Deployment Protection with the stored bypass, sent to that preview's host only). Without Vercel, admins and private
 *   mode may use the preview URL the repository's deployments report; others are refused (nothing vouches for it).
 * - `url`: a page on one of the above, on a deployment Vercel confirms belongs to the linked project (the user's own
 *   Vercel token is the proof), on the repository's GitHub Pages host, or inside the connected GitHub repository's path.
 *   For the GitHub web page Chromium receives no GitHub token; private repo contents stay on the GitHub API tools.
 *   Admins and private mode: any address the network policy allows, like audits.
 * The network rules (no loopback/LAN/metadata in public mode, every connection checked) are the proxy's (proxy.ts).
 */

export type ScreenshotTargetKind = "production" | "preview" | "pages" | "github" | "site" | "url";

export interface ScreenshotTarget {
  url: string;
  kind: ScreenshotTargetKind;
  /** Origins the main frame may navigate to (the target and its www/http twins). */
  allowedOrigins: string[];
  /** The Vercel protection bypass, sent to this host only. */
  hostHeaders?: NetDeps["hostHeaders"];
}

export interface TargetInput {
  target: "production" | "preview" | "url";
  path?: string;
  url?: string;
}

/** Same site in the ownership sense: the origin plus its `www.` twin and its http/https twin (redirects between them). */
export function twinOrigins(url: string): string[] {
  const base = new URL(url);
  const hosts = new Set([base.hostname]);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(base.hostname) && !base.hostname.includes(":")) {
    hosts.add(base.hostname.startsWith("www.") ? base.hostname.slice(4) : `www.${base.hostname}`);
  }
  const out = new Set<string>();
  for (const host of hosts) {
    for (const scheme of ["https:", "http:"]) {
      const twin = new URL(base.href);
      twin.protocol = scheme;
      twin.hostname = host;
      // A non-default port stays; the default of one scheme is not carried to the other.
      if (twin.port === "443" || twin.port === "80") twin.port = "";
      out.add(twin.origin);
    }
  }
  return [base.origin, ...[...out].filter((origin) => origin !== base.origin)];
}

/** `path` on `base`: a path only (no scheme, host or `//`), staying on the base's origin. */
export function pathOn(base: string, path: string | undefined): string {
  const clean = (path ?? "/").trim() || "/";
  if (!clean.startsWith("/") || clean.startsWith("//") || /[\s\\]/.test(clean) || clean.length > 300) {
    throw new SiteError(msg("path must be a site path starting with / (for example /about)"));
  }
  const origin = new URL(base).origin;
  const target = new URL(clean, origin);
  if (target.origin !== origin) throw new SiteError(msg("path must stay on the site"));
  return target.href;
}

function parse(url: string): URL {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error("scheme or credentials");
    return parsed;
  } catch {
    throw new SiteError(msgf("'{url}' is not a valid URL", { url: url.slice(0, 200) }));
  }
}

function done(url: string, kind: ScreenshotTargetKind, hostHeaders?: NetDeps["hostHeaders"]): ScreenshotTarget {
  return { url, kind, allowedOrigins: twinOrigins(url), ...(hostHeaders ? { hostHeaders } : {}) };
}

export async function resolveScreenshotTarget(accountId: string, input: TargetInput, deps?: NetDeps): Promise<ScreenshotTarget> {
  const account = getAccount(accountId);
  if (!account) throw new SiteError("unknown account", 404);
  const site = loadSite(accountId);

  if (input.target === "production") {
    const base = site.connection?.productionUrl || site.siteUrl?.url;
    if (!base) throw new SiteError(msg("add your website first (Website tab of the CV studio: its address, or its GitHub repository): screenshots run on your own site only"), 409);
    const refused = siteTargetProblem(account, site.connection, base, site.siteUrl);
    if (refused) throw new SiteError(refused, 403);
    return done(pathOn(base, input.path), "production");
  }

  if (input.target === "preview") {
    if (site.vercel?.projectId) {
      const preview = await vercelService.previewTarget(accountId, deps);
      if (preview.protectedWithoutBypass) {
        throw new SiteError(msg("The preview is behind Vercel Deployment Protection and no bypass secret is stored: create one in the Website tab (Vercel), then try again."), 409);
      }
      return done(pathOn(preview.url, input.path), "preview", preview.hostHeaders);
    }
    if (outboundBudgeted(account)) {
      throw new SiteError(msg("screenshots of previews need Vercel connected in the Website tab (it confirms the preview belongs to your project); take one of production instead"), 403);
    }
    const previewUrl = (await service.changes(accountId)).checks?.previewUrl;
    if (!previewUrl) throw new SiteError(msg("there is no preview deployment yet (no pull request, or the host has not built it): try again in a minute or use production"), 409);
    return done(pathOn(previewUrl, input.path), "preview");
  }

  if (!input.url) throw new SiteError(msg("url is required with target \"url\""));
  const url = parse(input.url).href;
  // Admins and private mode: like audits, any address the network policy allows (the proxy still checks every hop).
  const ownSite = siteTargetProblem(account, site.connection, url, site.siteUrl);
  if (!ownSite) return done(url, outboundBudgeted(account) ? "site" : "url", (await vercelService.linkedDeployment(accountId, url, deps))?.hostHeaders);
  const deployment = await vercelService.linkedDeployment(accountId, url, deps);
  if (deployment) return done(url, "preview", deployment.hostHeaders);

  // The connected repository is a bounded, project-related browser target. Do not pass GitHub credentials to Chromium:
  // public repository pages work directly; private repository contents remain available through the GitHub API tools.
  const repo = site.connection?.repo.toLowerCase().split("/");
  const githubUrl = new URL(url);
  if (repo?.length === 2 && githubUrl.hostname.toLowerCase() === "github.com") {
    const parts = githubUrl.pathname.split("/").filter(Boolean).slice(0, 2).map((part) => {
      try { return decodeURIComponent(part).toLowerCase(); } catch { return ""; }
    });
    if (parts[0] === repo[0] && parts[1] === repo[1]) return { url, kind: "github", allowedOrigins: ["https://github.com"] };
  }

  const pages = await service.repoPagesHost(accountId);
  if (pages && sameSiteHost(url, `https://${pages}/`)) return done(url, "pages");
  throw new SiteError(msgf("{problem}; screenshots also accept a deployment of your linked Vercel project or your repository's GitHub Pages site", { problem: ownSite }), 403);
}
