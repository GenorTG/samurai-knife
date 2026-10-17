/**
 * The one rule for "where to go next" values that come from a URL (`?next=`, `?returnTo=`, the GitHub flow's return
 * path): only a path on this site, never another origin. Shared by the server (GitHub start/callback, `back()`) and the
 * browser (login, register). Threat: an open redirect turning a real login page into a phishing hop. Browsers and
 * `new URL` silently drop tabs/newlines and treat `\` like `/`, so `/\t/evil.com` or `/\evil.com` become `//evil.com`;
 * hence printable ASCII only, no backslash, a leading single `/`, a same-origin parse, and the re-serialized path must
 * still start with a single `/` (dot segments such as `/.//evil.com` normalize to `//evil.com`).
 * Pure (no Node or DOM imports): safe in server and client bundles.
 */

const MAX_LENGTH = 512;
/** A fixed parse base: inputs are relative, so the check never depends on which host served the request. */
const PARSE_BASE = "http://knife.invalid";

export function safeReturnPath(value: string | null | undefined, fallback = "/"): string {
  if (typeof value !== "string") return fallback;
  const v = value.trim();
  if (!v || v.length > MAX_LENGTH) return fallback;
  // Printable ASCII only (0x21-0x7e): no controls, no spaces, no unicode look-alikes or bidi tricks; real paths arrive
  // percent-encoded anyway.
  for (let i = 0; i < v.length; i += 1) {
    const code = v.charCodeAt(i);
    if (code < 0x21 || code > 0x7e || code === 0x5c) return fallback;
  }
  if (v[0] !== "/" || v[1] === "/") return fallback;
  let url: URL;
  try {
    url = new URL(v, PARSE_BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== PARSE_BASE) return fallback;
  const path = `${url.pathname}${url.search}${url.hash}`;
  return path.startsWith("/") && !path.startsWith("//") ? path : fallback;
}
