import { msgf } from "@/lib/i18n/msg";
import type { Account } from "@/lib/accounts/store";
import { outboundBudgeted } from "@/lib/net/outbound";
import * as github from "./github";
import type { SiteConnection, SiteUrl } from "./store";

/**
 * Which site a public-mode non-admin may audit or read (`knife_site_audit`, `knife_site_page`): only the connected
 * repository's own production site, and only once that URL is VERIFIED. Threat: the production URL is typed by the user
 * (Connect), so without proof the audit is a free crawler/scanner aimed at any third party. Proof, checked at Connect
 * with the user's own GitHub token or the app installation: the URL's host is the repository's GitHub "Website"
 * (`homepage`, set only by repository admins) or its GitHub Pages domain (`GET /repos/{repo}/pages`: the custom CNAME or
 * `<owner>.github.io`). Otherwise an administrator approves the site for the account (`approvedSiteUrl`: CLI
 * `approve-site`, admin API `site-url`). Admins and private mode are not restricted. `www.` is ignored when comparing.
 */

const siteHost = (host: string): string => host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

function hostOf(url: string): string | null {
  try {
    return siteHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

/** Same site: equal hosts, ignoring case, a trailing dot and a leading `www.`. */
export function sameSiteHost(a: string, b: string): boolean {
  const ha = hostOf(a);
  return ha !== null && ha === hostOf(b);
}

/** The repository's GitHub Pages host (custom domain or `<owner>.github.io`), or null (no Pages site, no access). */
export async function pagesHost(token: string, repo: string, deps?: github.GitHubDeps): Promise<string | null> {
  try {
    const r = await github.gh<Record<string, unknown>>(token, "GET", `/repos/${github.checkRepo(repo)}/pages`, undefined, deps);
    const cname = typeof r.cname === "string" && r.cname.trim() ? r.cname.trim() : null;
    if (cname) return siteHost(cname.replace(/^https?:\/\//, "").split("/")[0]);
    const html = typeof r.html_url === "string" ? hostOf(r.html_url) : null;
    return html;
  } catch {
    return null; // 404 = no Pages site; any other refusal = not verified (never fails the connection)
  }
}

/**
 * At Connect: the production origin when its host is the repository's homepage or Pages host, else "". The Pages API
 * is asked only when the homepage does not already match.
 */
export async function verifyProductionUrl(token: string, repo: string, productionUrl: string, homepage: string, deps?: github.GitHubDeps): Promise<string> {
  if (!productionUrl) return "";
  const origin = new URL(productionUrl).origin;
  if (homepage && sameSiteHost(productionUrl, homepage)) return origin;
  const pages = await pagesHost(token, repo, deps);
  return pages && hostOf(productionUrl) === pages ? origin : "";
}

/** Is the connection's production URL verified, or approved by an admin for this account? */
export function productionTrusted(account: Pick<Account, "approvedSiteUrl">, connection: Pick<SiteConnection, "productionUrl" | "verifiedOrigin">): boolean {
  if (!connection.productionUrl) return false;
  const origin = new URL(connection.productionUrl).origin;
  if (connection.verifiedOrigin && connection.verifiedOrigin === origin) return true;
  return !!account.approvedSiteUrl && sameSiteHost(account.approvedSiteUrl, connection.productionUrl);
}

/**
 * Where a site fetch (an audit, `knife_site_page`) may go. Admins and private mode: anywhere the network policy allows.
 * Public mode, non-admins: only the connected site's verified (or admin-approved) production origin, even when
 * `target=preview` is requested. null = allowed.
 */
export function siteTargetProblem(
  account: Pick<Account, "role"> & { approvedSiteUrl?: string | null },
  connection: Pick<SiteConnection, "productionUrl"> & { verifiedOrigin?: string } | null,
  url: string,
  siteUrl?: Pick<SiteUrl, "url" | "verifiedOrigin"> | null,
): string | null {
  if (!outboundBudgeted(account)) return null;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return msgf("'{url}' is not a valid URL", { url: url.slice(0, 200) });
  }
  // A website without a repository: its own verified origin (or the admin-approved one), nothing else.
  if (!connection && siteUrl?.url) {
    const own = new URL(siteUrl.url);
    if (target.origin !== own.origin) return msgf("checks run on your own website only ({origin})", { origin: own.origin });
    if (siteUrl.verifiedOrigin === own.origin) return null;
    if (account.approvedSiteUrl && sameSiteHost(account.approvedSiteUrl, siteUrl.url)) return null;
    return msgf("{host} is not verified yet: add the verification tag or file shown in the Website tab to the site, then press Verify", { host: own.host });
  }
  const production = connection?.productionUrl ? new URL(connection.productionUrl) : null;
  if (!production || !connection) return "add your website first (Website tab of the CV studio: its address, or its GitHub repository): checks run on your own site only";
  if (target.origin !== production.origin) return msgf("audits and page reads run on your connected production site only ({origin})", { origin: production.origin });
  if (!productionTrusted({ approvedSiteUrl: account.approvedSiteUrl ?? null }, { productionUrl: connection.productionUrl, verifiedOrigin: connection.verifiedOrigin ?? "" })) {
    return msgf("{host} is not verified as this repository's site: set it as the repository's Website (GitHub, About) or serve it from its GitHub Pages, then Connect again; or ask an administrator to approve it for your account", { host: production.host });
  }
  return null;
}

/** The proof a website without a repository serves: `<meta name="smart-knife-verification" content="<token>">` on its home page, or the token as the whole of `/.well-known/smart-knife-verification.txt`. */
export const VERIFY_META = "smart-knife-verification";
export const VERIFY_FILE = "/.well-known/smart-knife-verification.txt";

/** True when `html` (the home page) carries the verification meta tag with `token`. Exported for tests. */
export function hasVerificationMeta(html: string, token: string): boolean {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  return tags.some((tag) => {
    const name = /\bname\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? /\bcontent\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
    return name === VERIFY_META && content?.trim() === token;
  });
}
