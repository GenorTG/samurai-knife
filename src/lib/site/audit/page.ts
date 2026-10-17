import { decodeEntities, findAll, findFirst, parseHtml, plainText, rawText, tidyText, type HtmlElement } from "@/lib/cv/jobs/html";
import type { FetchedPage } from "../net";
import type { Issue, PageFacts } from "./types";

/** Technical facts and SEO / accessibility issues of one fetched page. Pure (no network). */

export const TEXT_CHARS = 30_000;
const SKIP = new Set(["script", "style", "noscript", "svg", "template", "iframe", "head", "title", "select"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "br", "button", "a", "figcaption", "blockquote"]);
/** Verbs and phrases that ask the reader to act (PL + EN). */
export const CTA_PATTERN =
  /(?<![\p{L}])(kontakt\p{L}*|napisz|zadzwoń|zadzwon|umów|umow|zamów|zamow|wyślij|wyslij|porozmawiajmy|zapytaj|sprawdź|sprawdz|zobacz (?:projekt|portfolio|ofert)\p{L}*|wycen\p{L}*|contact|get in touch|hire|book|schedule|call|email me|write to|let'?s talk|start a project|request|get a quote|see (?:my )?(?:work|projects|portfolio)|download (?:cv|resume))(?![\p{L}])/iu;
const GENERIC_LINK = /^(?:click here|here|read more|learn more|more|link|kliknij|tutaj|tu|więcej|czytaj więcej|zobacz więcej)$/i;
const PROFILE_HOSTS = /(?:^|\.)(linkedin\.com|github\.com|gitlab\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|youtube\.com|behance\.net|dribbble\.com)$/i;

/** Visible text with block boundaries as newlines; header/nav/footer/buttons kept (unlike the job-posting reader). */
export function visibleText(root: HtmlElement): string {
  const out: string[] = [];
  const visit = (el: HtmlElement): void => {
    for (const child of el.children) {
      if (typeof child === "string") {
        out.push(child);
        continue;
      }
      if (SKIP.has(child.tag) || child.attrs.hidden !== undefined || child.attrs["aria-hidden"] === "true") continue;
      const block = BLOCK.has(child.tag);
      if (block) out.push("\n");
      if (child.tag === "img" && child.attrs.alt) out.push(` ${child.attrs.alt} `);
      visit(child);
      if (block) out.push("\n");
    }
  };
  visit(root);
  return tidyText(out.join(""));
}

function meta(root: HtmlElement, key: string): string {
  const el = findFirst(root, (e) => e.tag === "meta" && ((e.attrs.name ?? "").toLowerCase() === key || (e.attrs.property ?? "").toLowerCase() === key));
  return el ? decodeEntities(el.attrs.content ?? "").trim() : "";
}

function linkRel(root: HtmlElement, rel: string): HtmlElement[] {
  return findAll(root, (e) => e.tag === "link" && (e.attrs.rel ?? "").toLowerCase().split(/\s+/).includes(rel));
}

function jsonLdTypes(root: HtmlElement): string[] {
  const types = new Set<string>();
  for (const script of findAll(root, (e) => e.tag === "script" && (e.attrs.type ?? "").toLowerCase() === "application/ld+json")) {
    try {
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === "object") {
          const t = (value as Record<string, unknown>)["@type"];
          if (typeof t === "string") types.add(t);
          else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && types.add(x));
          const graph = (value as Record<string, unknown>)["@graph"];
          if (graph) walk(graph);
        }
      };
      walk(JSON.parse(rawText(script)));
    } catch {
      types.add("(invalid JSON-LD)");
    }
  }
  return [...types];
}

function issue(id: string, severity: Issue["severity"], category: Issue["category"], title: string, detail: string, page: string, fix: string): Issue {
  return { id, severity, category, title, detail, page, fix };
}

export function analyzePage(page: FetchedPage): { facts: PageFacts; issues: Issue[] } {
  const html = page.contentType.includes("html") || !page.contentType ? page.body : "";
  const root = parseHtml(html);
  const url = page.finalUrl;
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    /* fetched URLs are valid */
  }
  const htmlEl = findFirst(root, (e) => e.tag === "html");
  const titleEl = findFirst(root, (e) => e.tag === "title");
  const headings = findAll(root, (e) => /^h[1-6]$/.test(e.tag)).map((e) => ({ level: Number(e.tag[1]), text: plainText(e).slice(0, 200) }));
  const images = findAll(root, (e) => e.tag === "img");
  const anchors = findAll(root, (e) => e.tag === "a" && typeof e.attrs.href === "string");
  const contacts: string[] = [];
  const profiles = new Set<string>();
  let internal = 0;
  let external = 0;
  let emptyText = 0;
  let genericText = 0;
  const ctas = new Set<string>();
  for (const a of anchors) {
    const href = a.attrs.href.trim();
    const label = (plainText(a) || a.attrs["aria-label"] || a.attrs.title || "").trim();
    if (/^mailto:|^tel:/i.test(href)) {
      contacts.push(href.split("?")[0]);
      ctas.add(label || href);
    }
    if (!label && !findFirst(a, (e) => e.tag === "img" && !!e.attrs.alt)) emptyText += 1;
    else if (GENERIC_LINK.test(label)) genericText += 1;
    if (label && CTA_PATTERN.test(label)) ctas.add(label.slice(0, 80));
    try {
      const target = new URL(href, url);
      if (!/^https?:$/.test(target.protocol)) continue;
      if (target.origin === origin) internal += 1;
      else {
        external += 1;
        if (PROFILE_HOSTS.test(target.hostname)) profiles.add(target.href.replace(/\/$/, ""));
      }
    } catch {
      /* odd hrefs are not counted */
    }
  }
  for (const b of findAll(root, (e) => e.tag === "button" || (e.tag === "input" && (e.attrs.type === "submit" || e.attrs.type === "button")))) {
    const label = (plainText(b) || b.attrs.value || b.attrs["aria-label"] || "").trim();
    if (label && CTA_PATTERN.test(label)) ctas.add(label.slice(0, 80));
  }
  const scripts = findAll(root, (e) => e.tag === "script");
  const text = visibleText(findFirst(root, (e) => e.tag === "body") ?? root).slice(0, TEXT_CHARS);
  const facts: PageFacts = {
    url: page.url,
    finalUrl: url,
    status: page.status,
    bytes: page.bytes,
    ttfbMs: page.ttfbMs,
    redirects: Math.max(0, page.hops.length - 1),
    lang: (htmlEl?.attrs.lang ?? "").trim(),
    title: titleEl ? plainText(titleEl).trim() : "",
    metaDescription: meta(root, "description"),
    canonical: linkRel(root, "canonical")[0]?.attrs.href ?? "",
    robotsMeta: meta(root, "robots"),
    viewport: !!meta(root, "viewport"),
    og: Object.fromEntries(["og:title", "og:description", "og:image", "og:url", "og:type", "og:locale"].map((k) => [k.slice(3), meta(root, k)]).filter(([, v]) => v)),
    twitterCard: meta(root, "twitter:card"),
    jsonLdTypes: jsonLdTypes(root),
    hreflang: linkRel(root, "alternate").filter((l) => l.attrs.hreflang).map((l) => ({ lang: l.attrs.hreflang, href: l.attrs.href ?? "" })),
    favicon: linkRel(root, "icon").length + linkRel(root, "shortcut").length + linkRel(root, "apple-touch-icon").length > 0,
    headings,
    images: { count: images.length, missingAlt: images.filter((i) => i.attrs.alt === undefined).length },
    links: { internal, external, emptyText, genericText, contacts: [...new Set(contacts)], profiles: [...profiles] },
    scripts: { external: scripts.filter((s) => s.attrs.src).length, inlineBytes: scripts.filter((s) => !s.attrs.src).reduce((n, s) => n + rawText(s).length, 0) },
    stylesheets: linkRel(root, "stylesheet").length,
    text,
    wordCount: text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length,
    ctas: [...ctas].slice(0, 30),
  };
  return { facts, issues: pageIssues(facts, page) };
}

function pageIssues(f: PageFacts, page: FetchedPage): Issue[] {
  const out: Issue[] = [];
  const at = f.finalUrl;
  const add = (...args: Parameters<typeof issue>) => out.push(issue(...args));
  if (f.status >= 400) {
    add("page.status", "high", "seo", `The page answers HTTP ${f.status}`, `${f.url} returned ${f.status}.`, at, "Fix the route or remove links to it.");
    return out;
  }
  if (f.redirects > 1) add("page.redirect-chain", "low", "performance", `${f.redirects} redirects before the page`, page.hops.map((h) => `${h.status} ${h.url}`).join(" -> "), at, "Link to the final URL directly; keep at most one redirect.");
  if (!f.title) add("seo.title.missing", "high", "seo", "No <title>", "Search results and browser tabs show no page name.", at, "Add a unique title of 30-60 characters with your name/brand and what you do.");
  else if (f.title.length < 20 || f.title.length > 65) add("seo.title.length", "medium", "seo", `Title is ${f.title.length} characters`, `"${f.title}"`, at, "Keep titles between about 30 and 60 characters: search engines cut longer ones.");
  if (!f.metaDescription) add("seo.description.missing", "high", "seo", "No meta description", "Search engines invent a snippet from page text.", at, "Write a 70-160 character description that says who you are, what you offer and to whom.");
  else if (f.metaDescription.length < 70 || f.metaDescription.length > 165) add("seo.description.length", "low", "seo", `Meta description is ${f.metaDescription.length} characters`, `"${f.metaDescription.slice(0, 200)}"`, at, "Aim for 70-160 characters.");
  if (!f.lang) add("a11y.lang", "medium", "accessibility", "<html> has no lang attribute", "Screen readers and search engines guess the language.", at, 'Set lang="pl" (or "en") on <html>.');
  if (!f.viewport) add("seo.viewport", "high", "seo", "No viewport meta tag", "Phones render the desktop layout zoomed out.", at, 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.');
  if (!f.canonical) add("seo.canonical", "low", "seo", "No canonical link", "Duplicate URLs (www/apex, trailing slash, query strings) compete with each other.", at, 'Add <link rel="canonical" href="..."> with the preferred URL.');
  if (/noindex/i.test(f.robotsMeta)) add("seo.noindex", "high", "seo", "The page asks not to be indexed", `robots meta: "${f.robotsMeta}"`, at, "Remove noindex unless the page must stay out of search.");
  const h1 = f.headings.filter((h) => h.level === 1);
  if (!h1.length) add("seo.h1.missing", "high", "seo", "No H1 heading", "The main topic of the page is not marked up.", at, "Give the page exactly one H1 that states the offer or who you are.");
  else if (h1.length > 1) add("seo.h1.multiple", "low", "seo", `${h1.length} H1 headings`, h1.map((h) => h.text).join(" | ").slice(0, 300), at, "Keep one H1; use H2 for sections.");
  f.headings.forEach((h, i) => {
    const prev = f.headings[i - 1];
    if (prev && h.level > prev.level + 1 && !out.some((x) => x.id === "a11y.heading-skip" && x.page === at)) {
      add("a11y.heading-skip", "low", "accessibility", `Heading level jumps from H${prev.level} to H${h.level}`, `"${h.text}"`, at, "Do not skip heading levels (H2 then H3, not H2 then H4).");
    }
  });
  if (f.images.missingAlt) add("a11y.img-alt", "medium", "accessibility", `${f.images.missingAlt} of ${f.images.count} images have no alt text`, "Screen readers cannot describe them; search engines ignore them.", at, 'Add a short alt text to each meaningful image (alt="" for decorative ones).');
  if (f.links.emptyText) add("a11y.link-name", "medium", "accessibility", `${f.links.emptyText} links have no readable name`, "Icon-only links without aria-label are announced as just \"link\".", at, "Add visible text or aria-label to icon links.");
  if (f.links.genericText) add("copy.link-text", "low", "copy", `${f.links.genericText} links say "read more" / "kliknij tutaj"`, "Generic link text tells neither readers nor search engines where it goes.", at, "Name the destination in the link text.");
  if (!f.og.title || !f.og.image) add("seo.og", "medium", "seo", "Open Graph tags are incomplete", `Present: ${Object.keys(f.og).join(", ") || "none"}.`, at, "Add og:title, og:description, og:image (1200x630) and og:url so shared links look right on LinkedIn.");
  if (!f.jsonLdTypes.length) add("seo.structured-data", "low", "seo", "No structured data (JSON-LD)", "Search engines cannot tell this is a person/company page.", at, "Add JSON-LD Person (and Organization for the company) with name, jobTitle, url and sameAs profile links.");
  else if (f.jsonLdTypes.includes("(invalid JSON-LD)")) add("seo.structured-data.invalid", "medium", "seo", "A JSON-LD block does not parse", "", at, "Fix the JSON in the ld+json script.");
  if (!f.favicon) add("seo.favicon", "low", "seo", "No favicon link", "", at, "Link an icon (and an apple-touch-icon).");
  if (f.wordCount < 120) add("content.thin", "medium", "content", `Only ${f.wordCount} words of visible text in the HTML`, "Either the page says little, or its text appears only after JavaScript runs (search engines and link previews may see none of it).", at, "Render the key copy on the server (or statically) and give each page at least a few short paragraphs.");
  if (f.bytes > 1_500_000) add("perf.html-size", "medium", "performance", `HTML document is ${(f.bytes / 1_000_000).toFixed(1)} MB`, "Large inline payloads delay the first paint.", at, "Move inline data out of the HTML or load it lazily.");
  if (f.ttfbMs > 1500) add("perf.ttfb", "medium", "performance", `Server answered after ${f.ttfbMs} ms`, "Time to first byte from this server.", at, "Cache or statically render the page.");
  return out;
}
