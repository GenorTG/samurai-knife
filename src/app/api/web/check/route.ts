import * as z from "zod/v4";
import { authenticate, json, parseBody } from "@/lib/accounts/http";
import { getAccount } from "@/lib/accounts/store";
import { admitOutbound, hostGate, outboundLimitMessage } from "@/lib/net/outbound";
import { analyzePage } from "@/lib/site/audit/page";
import { siteTargetProblem } from "@/lib/site/audit/run";
import { siteErrorResponse } from "@/lib/site/http";
import { fetchPage, sitePolicy, SiteError, type FetchedPage } from "@/lib/site/net";
import { loadSite } from "@/lib/site/store";
import { msg, msgf } from "@/lib/i18n/msg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ url: z.string().trim().min(1).max(500) }).strict();

/** What the browser gets back for the page itself: the HTML capped for the accessibility checks it runs locally. */
const HTML_CAP = 512 * 1024;
const TEXT_CAP = 64 * 1024;

function normalize(input: string): string {
  const value = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SiteError(msgf("'{input}' is not a valid address.", { input: input.slice(0, 200) }));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SiteError(msg("Only http and https addresses can be checked."));
  if (url.username || url.password) throw new SiteError(msg("Remove the user name and password from the address."));
  url.hash = "";
  return url.toString();
}

/** Set-Cookie values are the site's business: only names and attributes come back (the flags are what is checked). */
function cookieShapes(page: FetchedPage): string[] {
  const raw = page.headers["set-cookie"] ?? "";
  return raw
    .split(/\n|,(?=\s*[^;,=\s]+=)/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pair, ...attrs] = line.split(";");
      const name = pair.split("=")[0].trim();
      return [`${name}=…`, ...attrs.map((a) => a.trim())].join("; ");
    });
}

/**
 * POST /api/web/check {url} -> one live page: redirect chain, status, timing, response headers (cookie values removed),
 * the SEO facts and issues of the site audit, robots.txt and the sitemap it names (or /sitemap.xml), plus the HTML
 * (capped) for the browser's accessibility checks. Same reach and budget as the website studio's page reads
 * (src/lib/site/net.ts sitePolicy, outbound budget per hop; public mode: a non-admin checks their own verified site).
 */
export async function POST(request: Request): Promise<Response> {
  const auth = authenticate(request, true);
  if ("response" in auth) return auth.response;
  const parsed = await parseBody(request, bodySchema, "{ url }");
  if ("response" in parsed) return parsed.response;
  try {
    const account = getAccount(auth.account.id);
    if (!account) throw new SiteError("unknown account", 404);
    const url = normalize(parsed.data.url);
    const refused = siteTargetProblem(account, loadSite(account.id).connection, url, loadSite(account.id).siteUrl);
    if (refused) throw new SiteError(refused, 403);
    const budget = admitOutbound(account, "page", url);
    if (!budget.ok) throw new SiteError(outboundLimitMessage(budget.retryAfterSeconds), 429);
    const policy = sitePolicy(account);
    const page = await fetchPage(url, policy, { admitHop: hostGate(account, "page", url) });
    const { facts, issues } = analyzePage(page);

    // robots.txt and the sitemap: same origin as the final page, best effort (a failure is reported, not thrown).
    const origin = new URL(page.finalUrl).origin;
    const side = async (target: string) => {
      try {
        const got = await fetchPage(target, policy, { admitHop: hostGate(account, "page", target) }, 10_000);
        return { url: got.finalUrl, status: got.status, contentType: got.contentType, text: got.body.slice(0, TEXT_CAP), bytes: got.bytes };
      } catch (error) {
        return { url: target, status: 0, contentType: "", text: "", bytes: 0, error: error instanceof Error ? error.message.slice(0, 200) : "failed" };
      }
    };
    const robots = await side(`${origin}/robots.txt`);
    const named = robots.status === 200 ? /^\s*sitemap:\s*(\S+)/im.exec(robots.text)?.[1] : undefined;
    let sitemapUrl = `${origin}/sitemap.xml`;
    try {
      if (named && new URL(named).origin === origin) sitemapUrl = new URL(named).toString();
    } catch {
      // a malformed Sitemap: line falls back to /sitemap.xml
    }
    const sitemapPage = await side(sitemapUrl);
    const sitemap = {
      url: sitemapPage.url,
      status: sitemapPage.status,
      named: Boolean(named),
      urls: sitemapPage.status === 200 ? (sitemapPage.text.match(/<loc>/gi) ?? []).length : 0,
      index: /<sitemapindex/i.test(sitemapPage.text),
      ...(sitemapPage.error ? { error: sitemapPage.error } : {}),
    };
    const { cookie: _cookie, "set-cookie": _setCookie, ...headers } = page.headers;
    void _cookie;
    void _setCookie;
    const html = page.contentType.includes("html") || !page.contentType ? page.body.slice(0, HTML_CAP) : "";
    return json({
      url,
      finalUrl: page.finalUrl,
      hops: page.hops,
      status: page.status,
      contentType: page.contentType,
      bytes: page.bytes,
      ttfbMs: page.ttfbMs,
      totalMs: page.totalMs,
      headers,
      cookies: cookieShapes(page),
      facts: { ...facts, text: "" },
      issues,
      robots: { url: robots.url, status: robots.status, text: robots.text.slice(0, 8_000), ...(robots.error ? { error: robots.error } : {}) },
      sitemap,
      html,
      htmlTruncated: page.body.length > HTML_CAP,
    });
  } catch (error) {
    return siteErrorResponse(error);
  }
}
