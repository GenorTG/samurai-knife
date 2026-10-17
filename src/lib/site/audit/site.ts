import type { OutboundPolicy } from "@/lib/net/safe-fetch";
import { fetchPage, type FetchedPage, type NetDeps } from "../net";
import type { Issue, SiteFacts } from "./types";

/** Site-wide checks: robots.txt, sitemap, http -> https, a real 404, security headers of the home page. */

export const SECURITY_HEADERS = ["strict-transport-security", "content-security-policy", "x-content-type-options", "referrer-policy", "permissions-policy", "x-frame-options"] as const;

async function tryFetch(url: string, policy: OutboundPolicy, deps: NetDeps): Promise<FetchedPage | null> {
  try {
    return await fetchPage(url, policy, deps, 12_000);
  } catch {
    return null;
  }
}

export async function checkSite(home: FetchedPage, policy: OutboundPolicy, deps: NetDeps = {}): Promise<SiteFacts> {
  const origin = new URL(home.finalUrl).origin;
  const robotsPage = await tryFetch(`${origin}/robots.txt`, policy, deps);
  const robotsText = robotsPage && robotsPage.status === 200 ? robotsPage.body : "";
  // The standard wants absolute URLs; relative ones occur in the wild and are resolved against the site.
  const sitemaps = [...robotsText.matchAll(/^\s*sitemap:\s*(\S+)/gim)].flatMap((m) => {
    try {
      return [new URL(m[1], origin).href];
    } catch {
      return [];
    }
  }).slice(0, 5);
  // "Disallow: /" in the block for every crawler.
  let blocksAll = false;
  let star = false;
  for (const line of robotsText.split(/\r?\n/)) {
    const ua = /^\s*user-agent:\s*(.+)$/i.exec(line);
    if (ua) star = ua[1].trim() === "*";
    else if (star && /^\s*disallow:\s*\/\s*$/i.test(line)) blocksAll = true;
  }
  const sitemapUrl = sitemaps[0] ?? `${origin}/sitemap.xml`;
  const sitemapPage = await tryFetch(sitemapUrl, policy, deps);
  const urls = sitemapPage && sitemapPage.status === 200 ? (sitemapPage.body.match(/<loc>/gi) ?? []).length : 0;
  let httpsRedirect: boolean | null = null;
  if (origin.startsWith("https://")) {
    const plain = await tryFetch(origin.replace(/^https:/, "http:") + "/", policy, deps);
    httpsRedirect = plain ? plain.finalUrl.startsWith("https://") : null;
  }
  const missing = await tryFetch(`${origin}/knife-audit-${Date.now().toString(36)}-not-a-page`, policy, deps);
  const securityHeaders = Object.fromEntries(SECURITY_HEADERS.map((h) => [h, h in home.headers || (h === "x-frame-options" && /frame-ancestors/i.test(home.headers["content-security-policy"] ?? ""))]));
  return {
    origin,
    httpsRedirect,
    robots: { status: robotsPage?.status ?? 0, sitemaps, blocksAll },
    sitemap: { url: sitemapUrl, status: sitemapPage?.status ?? 0, urls },
    notFoundStatus: missing?.status ?? 0,
    securityHeaders,
  };
}

export function siteIssues(s: SiteFacts, auditedPaths: string[]): Issue[] {
  const out: Issue[] = [];
  const add = (id: string, severity: Issue["severity"], category: Issue["category"], title: string, detail: string, fix: string) => out.push({ id, severity, category, title, detail, page: "", fix });
  if (s.robots.status !== 200) add("seo.robots.missing", "low", "seo", "No robots.txt", `${s.origin}/robots.txt answered ${s.robots.status || "nothing"}.`, "Serve a robots.txt that allows crawling and names the sitemap.");
  if (s.robots.blocksAll) add("seo.robots.blocks", "high", "seo", "robots.txt blocks every crawler", "Disallow: / for User-agent: *", "Remove the blanket Disallow unless the site must stay out of search.");
  if (s.sitemap.status !== 200 || !s.sitemap.urls) add("seo.sitemap", "medium", "seo", "No usable sitemap", `${s.sitemap.url} answered ${s.sitemap.status || "nothing"}${s.sitemap.status === 200 ? " without <loc> entries" : ""}.`, "Generate sitemap.xml with every public page and reference it from robots.txt.");
  else if (s.sitemap.urls < auditedPaths.length) add("seo.sitemap.short", "low", "seo", `The sitemap lists ${s.sitemap.urls} URL(s) for ${auditedPaths.length} audited page(s)`, "", "List every public page in the sitemap.");
  if (s.httpsRedirect === false) add("security.https-redirect", "high", "security", "http:// does not redirect to https://", "", "Redirect all plain-HTTP requests to HTTPS (permanent 308/301).");
  if (s.notFoundStatus === 200) add("seo.soft-404", "medium", "seo", "Unknown URLs answer 200 (soft 404)", "Search engines index error pages as content.", "Return HTTP 404 for unknown paths.");
  const lacking = Object.entries(s.securityHeaders).filter(([, ok]) => !ok).map(([h]) => h);
  if (lacking.includes("strict-transport-security") && s.origin.startsWith("https://")) add("security.hsts", "medium", "security", "No HSTS header", "", "Send Strict-Transport-Security: max-age=31536000; includeSubDomains.");
  const others = lacking.filter((h) => h !== "strict-transport-security");
  if (others.length) add("security.headers", others.includes("content-security-policy") ? "medium" : "low", "security", `Missing security headers: ${others.join(", ")}`, "", "Set them in the host config (vercel.json `headers`, next.config `headers()`, or the proxy).");
  return out;
}
