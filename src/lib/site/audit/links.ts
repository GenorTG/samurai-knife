/**
 * Link comparison for the CV fit (pure). A CV link and a site link are the same when they point at the same place:
 * scheme, a leading "www.", the host's case, a trailing slash, the fragment and tracking parameters do not matter.
 */

const TRACKING = /^(?:utm_[a-z]+|fbclid|gclid|ref|trk|originalSubdomain)$/i;

/** "https://WWW.LinkedIn.com/in/jan/?utm_source=x#top" -> "linkedin.com/in/jan". "" for anything that is not http(s). */
export function normalizeUrl(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  let url: URL;
  try {
    url = new URL(/^[a-z][\w+.-]*:/i.test(text) ? text : `https://${text.replace(/^\/\//, "")}`);
  } catch {
    return "";
  }
  if (!/^https?:$/.test(url.protocol)) return "";
  const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const params = [...url.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  let path = url.pathname.replace(/\/+$/, "");
  if (path === "/index.html" || path === "/index.htm") path = "";
  return `${host}${url.port ? `:${url.port}` : ""}${path}${query}`;
}

export function hostOf(normalized: string): string {
  return normalized.split(/[/?]/)[0];
}

/** Hosts whose pages are a person's or company's profile (one account each). github.io / gitlab.io are project pages. */
const PROFILE_HOST = /^(?:[\w-]+\.)?(?:linkedin\.com|github\.com|gitlab\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|youtube\.com|behance\.net|dribbble\.com|bsky\.app|mastodon\.social)$/;

export function isProfileUrl(raw: string): boolean {
  const n = normalizeUrl(raw);
  if (!n || !PROFILE_HOST.test(hostOf(n))) return false;
  // github.com/<user> is a profile; github.com/<user>/<repo> is a project.
  if (/^github\.com\/[^/]+\/[^/?]+/.test(n) || /^gitlab\.com\/[^/]+\/[^/?]+/.test(n)) return false;
  return true;
}

/**
 * Does the site carry this link? Exact match after normalising, or the site links a deeper page of it (a profile link
 * with a locale suffix: linkedin.com/in/jan/?locale=pl, github.com/jan?tab=repositories).
 */
export function linkPresent(cvUrl: string, siteLinks: Iterable<string>): boolean {
  const want = normalizeUrl(cvUrl);
  if (!want) return false;
  const bare = want.split("?")[0];
  for (const link of siteLinks) {
    const have = normalizeUrl(link);
    if (!have) continue;
    if (have === want || have.split("?")[0] === bare) return true;
    if (have.startsWith(`${bare}/`)) return true;
  }
  return false;
}

/** Every http(s) URL in a JSON-LD value: url, sameAs, @id, image..., in objects, arrays and @graph. */
export function jsonLdUrls(value: unknown, out: Set<string> = new Set(), limit = 100): Set<string> {
  const walk = (v: unknown): void => {
    if (out.size >= limit) return;
    if (typeof v === "string") {
      if (/^https?:\/\/\S+$/i.test(v.trim())) out.add(v.trim());
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(value);
  return out;
}
