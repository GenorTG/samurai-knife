"use client";

/**
 * Website check (Web workbench's first tab): enter an address, the server fetches the live page (POST /api/web/check:
 * the website studio's safe fetch and budget), and this page shows the redirect chain, security headers with fixes,
 * cookie flags, SEO facts and issues, robots.txt and the sitemap, plus accessibility checks run here on the fetched HTML
 * (src/lib/html-audit.ts: parsed in an inert <template>, nothing of the page runs). Replaces four paste-a-snippet checks.
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { Badge, Button, Field, Notice, Panel, Stat, StatGrid, TextInput } from "@/components/ui";
import { cx } from "@/lib/format";
import { auditFormLabels, auditHeadings, auditLandmarks, auditLinks } from "@/lib/html-audit";

interface Issue {
  id: string;
  severity: "error" | "warning" | "info" | string;
  category: string;
  title: string;
  detail: string;
}

interface CheckResult {
  url: string;
  finalUrl: string;
  hops: { url: string; status: number }[];
  status: number;
  contentType: string;
  bytes: number;
  ttfbMs: number;
  totalMs: number;
  headers: Record<string, string>;
  cookies: string[];
  facts: {
    lang: string;
    title: string;
    metaDescription: string;
    canonical: string;
    robotsMeta: string;
    viewport: boolean;
    og: Record<string, string>;
    favicon: boolean;
    headings: { level: number; text: string }[];
    images: { count: number; missingAlt: number };
    wordCount: number;
  };
  issues: Issue[];
  robots: { url: string; status: number; text: string; error?: string };
  sitemap: { url: string; status: number; named: boolean; urls: number; index: boolean; error?: string };
  html: string;
  htmlTruncated: boolean;
}

type Verdict = "good" | "warn" | "bad" | "info";

interface HeaderCheck {
  name: string;
  verdict: Verdict;
  value: string;
  advice: string;
}

/** The security headers worth having on an HTML page, judged by what is set (not by what the site needs). */
function securityChecks(result: CheckResult): HeaderCheck[] {
  const h = result.headers;
  const https = result.finalUrl.startsWith("https:");
  const csp = h["content-security-policy"] ?? "";
  const hsts = h["strict-transport-security"] ?? "";
  const maxAge = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0);
  const framing = h["x-frame-options"] || /frame-ancestors/i.test(csp);
  const checks: HeaderCheck[] = [
    {
      name: "Strict-Transport-Security",
      verdict: !https ? "info" : !hsts ? "bad" : maxAge >= 15_552_000 ? "good" : "warn",
      value: hsts || "not set",
      advice: !https ? "Only sent over https; serve the site over https first." : !hsts ? "Add `max-age=31536000` so browsers always use https." : maxAge < 15_552_000 ? "Raise max-age to at least six months (15552000)." : "",
    },
    {
      name: "Content-Security-Policy",
      verdict: !csp ? "bad" : /script-src[^;]*'unsafe-inline'/i.test(csp) || (!/script-src/i.test(csp) && /default-src[^;]*'unsafe-inline'/i.test(csp)) ? "warn" : "good",
      value: csp || "not set",
      advice: !csp ? "Start with `default-src 'self'` and allow what the page loads (the CSP tab builds one)." : /'unsafe-inline'/i.test(csp) ? "'unsafe-inline' scripts weaken the policy; prefer nonces or hashes." : "",
    },
    {
      name: "X-Content-Type-Options",
      verdict: (h["x-content-type-options"] ?? "").toLowerCase() === "nosniff" ? "good" : "bad",
      value: h["x-content-type-options"] || "not set",
      advice: (h["x-content-type-options"] ?? "").toLowerCase() === "nosniff" ? "" : "Set `nosniff`.",
    },
    {
      name: "Frame protection",
      verdict: framing ? "good" : "warn",
      value: h["x-frame-options"] || (/frame-ancestors[^;]*/i.exec(csp)?.[0] ?? "not set"),
      advice: framing ? "" : "Add `frame-ancestors 'self'` to the CSP (or X-Frame-Options: SAMEORIGIN) against clickjacking.",
    },
    {
      name: "Referrer-Policy",
      verdict: h["referrer-policy"] ? "good" : "warn",
      value: h["referrer-policy"] || "not set",
      advice: h["referrer-policy"] ? "" : "Set `strict-origin-when-cross-origin` (or stricter).",
    },
    {
      name: "Permissions-Policy",
      verdict: h["permissions-policy"] ? "good" : "info",
      value: h["permissions-policy"] || "not set",
      advice: h["permissions-policy"] ? "" : "Optional: turn off features the site never uses, e.g. `camera=(), microphone=(), geolocation=()`.",
    },
  ];
  const disclosed = ["server", "x-powered-by", "x-aspnet-version"].filter((name) => h[name] && /\d/.test(h[name]));
  if (disclosed.length) {
    checks.push({ name: "Version disclosure", verdict: "info", value: disclosed.map((name) => `${name}: ${h[name]}`).join(" · "), advice: "Hide software versions; they help attackers pick exploits." });
  }
  return checks;
}

function cookieChecks(cookies: string[], https: boolean): { cookie: string; missing: string[] }[] {
  return cookies.map((cookie) => {
    const lower = cookie.toLowerCase();
    const missing = [
      ...(https && !/;\s*secure/.test(lower) ? ["Secure"] : []),
      ...(!/;\s*httponly/.test(lower) ? ["HttpOnly (unless scripts must read it)"] : []),
      ...(!/;\s*samesite=/.test(lower) ? ["SameSite"] : []),
    ];
    return { cookie, missing };
  });
}

const TONE: Record<Verdict, "good" | "warn" | "danger" | "neutral"> = { good: "good", warn: "warn", bad: "danger", info: "neutral" };
const LABEL: Record<Verdict, string> = { good: "OK", warn: "Improve", bad: "Missing", info: "Info" };

function Row({ label, verdict, children }: { label: string; verdict: Verdict; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[4.75rem_1fr] items-start gap-x-3 gap-y-1 px-3 py-2 sm:grid-cols-[4.75rem_minmax(9rem,13rem)_1fr]">
      <span>
        <Badge tone={TONE[verdict]}>{LABEL[verdict]}</Badge>
      </span>
      <span className="font-medium text-ink">{label}</span>
      <span className="col-span-2 min-w-0 text-[13px] break-words text-muted sm:col-span-1">{children}</span>
    </li>
  );
}

function seoChecks(result: CheckResult): { label: string; verdict: Verdict; detail: string }[] {
  const f = result.facts;
  const h1 = f.headings.filter((heading) => heading.level === 1).length;
  const titleLen = f.title.length;
  const descLen = f.metaDescription.length;
  return [
    { label: "Title", verdict: !titleLen ? "bad" : titleLen < 10 || titleLen > 65 ? "warn" : "good", detail: titleLen ? `${f.title} (${titleLen} characters; 10–65 reads well in results)` : "No <title>." },
    { label: "Meta description", verdict: !descLen ? "bad" : descLen < 50 || descLen > 165 ? "warn" : "good", detail: descLen ? `${f.metaDescription} (${descLen} characters; 50–165)` : "No meta description: search engines pick a snippet themselves." },
    { label: "One H1", verdict: h1 === 1 ? "good" : h1 === 0 ? "bad" : "warn", detail: h1 === 1 ? f.headings.find((heading) => heading.level === 1)?.text ?? "" : `${h1} H1 headings.` },
    { label: "Language", verdict: f.lang ? "good" : "warn", detail: f.lang ? `lang="${f.lang}"` : "No lang on <html>: screen readers and translators guess." },
    { label: "Mobile viewport", verdict: f.viewport ? "good" : "bad", detail: f.viewport ? "meta viewport set" : "No meta viewport: phones show a zoomed-out desktop page." },
    { label: "Canonical URL", verdict: f.canonical ? "good" : "info", detail: f.canonical || "No canonical link (fine for a single URL; set it when the page has several addresses)." },
    { label: "Indexing", verdict: /noindex/i.test(f.robotsMeta) ? "warn" : "good", detail: f.robotsMeta ? `robots meta: ${f.robotsMeta}` : "No robots meta (indexable)." },
    { label: "Social preview", verdict: f.og["og:title"] && f.og["og:image"] ? "good" : "info", detail: f.og["og:title"] ? `og:title ${f.og["og:image"] ? "and og:image" : "without og:image"}` : "No Open Graph tags: shared links show a plain preview." },
    { label: "Image alt text", verdict: f.images.missingAlt ? "warn" : "good", detail: `${f.images.count} images, ${f.images.missingAlt} without alt.` },
    { label: "Favicon", verdict: f.favicon ? "good" : "info", detail: f.favicon ? "linked" : "No icon link." },
  ];
}

export default function WebsiteCheck() {
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);

  async function check(event?: FormEvent) {
    event?.preventDefault();
    if (!address.trim() || busy) return;
    const typed = address.trim();
    try {
      const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
      if (!/^https?:$/.test(url.protocol) || !url.hostname) throw new Error("bad");
    } catch {
      setResult(null);
      setError(`'${typed.slice(0, 200)}' is not a valid address.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/web/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: address.trim() }) });
      const body = (await response.json().catch(() => ({}))) as CheckResult & { error?: string };
      if (!response.ok) {
        setResult(null);
        setError(body.error ?? `The check failed (HTTP ${response.status}).`);
      } else setResult(body);
    } catch {
      setError("The check did not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const https = result?.finalUrl.startsWith("https:") ?? false;
  const a11y = result?.html
    ? (() => {
        const headings = auditHeadings(result.html);
        const links = auditLinks(result.html).filter((link) => link.issue);
        const forms = auditFormLabels(result.html).filter((control) => control.issue);
        const landmarks = auditLandmarks(result.html);
        return { headings, links, forms, landmarks };
      })()
    : null;

  return (
    <div className="space-y-4" data-website-check>
      <Panel title="Website check">
        <form onSubmit={check} className="flex flex-wrap items-end gap-2">
          <Field label="Address" className="min-w-64 flex-1">
            <TextInput value={address} onChange={(e) => setAddress(e.target.value)} placeholder="example.com or https://example.com/page" inputMode="url" autoComplete="off" spellCheck={false} />
          </Field>
          <Button type="submit" variant="primary" disabled={busy || !address.trim()}>
            {busy ? "Checking…" : "Check"}
          </Button>
        </form>
        <p className="mt-2 text-xs text-faint">
          The server fetches the page, its robots.txt and sitemap, like a visitor would (no JavaScript runs). Third-party content: nothing from it is trusted.
        </p>
        {busy ? (
          <p role="status" className="mt-3 text-sm text-muted">
            Checking {address.trim()}…
          </p>
        ) : null}
        {error ? (
          <div role="status" className="mt-3">
            <Notice tone="error">{error}</Notice>
          </div>
        ) : null}
      </Panel>

      {result ? (
        <>
          <StatGrid aria-label="Response">
            <Stat label="Status" value={result.status} />
            <Stat label="Redirects" value={Math.max(0, result.hops.length - 1)} />
            <Stat label="First byte" value={`${result.ttfbMs} ms`} />
            <Stat label="Page size" value={result.bytes < 1024 ? `${result.bytes} B` : `${Math.round(result.bytes / 1024)} KB`} />
          </StatGrid>
          {result.hops.length > 1 ? (
            <Panel title="Redirect chain">
              <ol className="space-y-1 font-mono text-xs break-all">
                {result.hops.map((hop, index) => (
                  <li key={index} className="flex gap-2">
                    <span className={cx("shrink-0", hop.status >= 300 && hop.status < 400 ? "text-warn" : "text-good")}>{hop.status}</span>
                    <span className="text-muted">{hop.url}</span>
                  </li>
                ))}
              </ol>
            </Panel>
          ) : null}

          <Panel title="Security headers">
            <ul aria-label="Security headers" className="divide-y divide-line rounded-lg border border-line">
              {securityChecks(result).map((item) => (
                <Row key={item.name} label={item.name} verdict={item.verdict}>
                  <code className="font-mono text-xs">{item.value.slice(0, 300)}</code>
                  {item.advice ? <span className="block text-xs text-faint">{item.advice}</span> : null}
                </Row>
              ))}
              {cookieChecks(result.cookies, https).map((item) => (
                <Row key={item.cookie} label="Cookie" verdict={item.missing.length ? "warn" : "good"}>
                  <code className="font-mono text-xs">{item.cookie}</code>
                  {item.missing.length ? <span className="block text-xs text-faint">Add: {item.missing.join(", ")}</span> : null}
                </Row>
              ))}
            </ul>
          </Panel>

          <Panel title="SEO">
            <ul aria-label="SEO checks" className="divide-y divide-line rounded-lg border border-line">
              {seoChecks(result).map((item) => (
                <Row key={item.label} label={item.label} verdict={item.verdict}>
                  {item.detail}
                </Row>
              ))}
            </ul>
            {result.issues.length ? (
              <details className="mt-3 rounded-lg border border-line px-3 py-2">
                <summary className="cursor-pointer text-xs text-muted select-none">All findings of the site audit ({result.issues.length})</summary>
                <ul className="mt-2 space-y-1.5 text-[13px]">
                  {result.issues.map((issue) => (
                    <li key={issue.id + issue.title}>
                      <span className={cx("font-medium", issue.severity === "error" ? "text-danger" : issue.severity === "warning" ? "text-warn" : "text-ink")}>{issue.title}</span>
                      <span className="block text-xs text-muted">{issue.detail}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </Panel>

          {a11y ? (
            <Panel title="Accessibility (from the HTML)">
              <ul aria-label="Accessibility checks" className="divide-y divide-line rounded-lg border border-line">
                <Row label="Heading order" verdict={a11y.headings.issues.length ? "warn" : "good"}>
                  {a11y.headings.issues.length ? a11y.headings.issues.slice(0, 5).join(" ") : `${a11y.headings.headings.length} headings, in order.`}
                </Row>
                <Row label="Link text" verdict={a11y.links.length ? "warn" : "good"}>
                  {a11y.links.length ? `${a11y.links.length} links without a clear name: ${a11y.links.slice(0, 5).map((link) => `${link.name} (${link.issue.toLowerCase()})`).join("; ")}` : "Every link has a meaningful name."}
                </Row>
                <Row label="Form labels" verdict={a11y.forms.length ? "bad" : "good"}>
                  {a11y.forms.length ? `${a11y.forms.length} fields without a label: ${a11y.forms.slice(0, 5).map((control) => `${control.control}${control.type ? `[type=${control.type}]` : ""}${control.id ? `#${control.id}` : ""}`).join(", ")}` : "Every field has a label (or none on this page)."}
                </Row>
                <Row label="Landmarks" verdict={a11y.landmarks.issues.length ? "warn" : "good"}>
                  {a11y.landmarks.issues.length ? a11y.landmarks.issues.join(" ") : a11y.landmarks.counts.filter((item) => item.count).map((item) => `${item.role} ${item.count}`).join(" · ")}
                </Row>
              </ul>
              <p className="mt-2 text-xs text-faint">
                Checked on the HTML the server received{result.htmlTruncated ? " (first 512 KB)" : ""}; content added by scripts is not seen. For a full audit with contrast and scores, use the Website studio (Lighthouse).
              </p>
            </Panel>
          ) : null}

          <Panel title="robots.txt and sitemap">
            <ul className="divide-y divide-line rounded-lg border border-line">
              <Row label="robots.txt" verdict={result.robots.status === 200 ? "good" : result.robots.status === 404 ? "info" : "warn"}>
                {result.robots.status === 200 ? `found at ${result.robots.url}` : result.robots.error ?? `HTTP ${result.robots.status}`}
                {result.robots.status === 200 && /disallow:\s*\/\s*$/im.test(result.robots.text) ? <span className="block text-xs text-warn">Contains &ldquo;Disallow: /&rdquo;: check that this is meant for every crawler.</span> : null}
              </Row>
              <Row label="Sitemap" verdict={result.sitemap.status === 200 ? "good" : "info"}>
                {result.sitemap.status === 200
                  ? `${result.sitemap.index ? "sitemap index" : `${result.sitemap.urls} URLs`} at ${result.sitemap.url}${result.sitemap.named ? " (named in robots.txt)" : ""}`
                  : result.sitemap.error ?? `none at ${result.sitemap.url} (HTTP ${result.sitemap.status}); the Sitemap tab writes one.`}
              </Row>
            </ul>
            {result.robots.status === 200 && result.robots.text ? (
              <details className="mt-3 rounded-lg border border-line px-3 py-2">
                <summary className="cursor-pointer text-xs text-muted select-none">robots.txt</summary>
                <pre className="mt-2 max-h-64 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted">{result.robots.text}</pre>
              </details>
            ) : null}
          </Panel>

          <details className="rounded-lg border border-line bg-surface px-3 py-2">
            <summary className="cursor-pointer text-xs text-muted select-none">All response headers ({Object.keys(result.headers).length})</summary>
            <table className="mt-2 w-full text-left text-xs">
              <tbody>
                {Object.entries(result.headers).map(([name, value]) => (
                  <tr key={name} className="border-t border-line first:border-0">
                    <th className="py-1 pr-3 align-top font-mono font-normal whitespace-nowrap text-faint">{name}</th>
                    <td className="py-1 font-mono break-all text-muted">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      ) : null}
    </div>
  );
}
