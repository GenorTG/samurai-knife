import { msg, msgf } from "@/lib/i18n/msg";
import type { FetchedPage } from "../net";
import type { Issue, ResourceCheck } from "./types";

/**
 * Which audited paths are web pages. Only an HTML answer gets the page, copy and accessibility checks (and counts toward
 * those scores); robots.txt, a sitemap and llms.txt are checked as what they are, any other file only for its status.
 * Well-known names win over the Content-Type, because a host often answers a missing file with its HTML 404 page.
 */

export type ResourceKind = ResourceCheck["kind"];

const HTML_TYPES = /^(?:text\/html|application\/xhtml\+xml)$/;
/** Extensions of files that are never a web page, for an answer without a Content-Type. */
const FILE_EXT = /\.(?:txt|md|markdown|xml|json|jsonld|webmanifest|csv|rss|atom|ya?ml|ico|png|jpe?g|gif|webp|avif|svg|pdf|zip|js|mjs|css|map|woff2?|ttf)$/i;

function lastSegment(path: string): string {
  let p = path;
  try {
    p = new URL(path, "http://x").pathname;
  } catch {
    /* keep the raw path */
  }
  return p.split("/").pop()?.toLowerCase() ?? "";
}

export function resourceKind(path: string, contentType: string): ResourceKind {
  const name = lastSegment(path);
  if (name === "robots.txt") return "robots";
  if (/^sitemap[\w-]*\.xml$/.test(name)) return "sitemap";
  if (name === "llms.txt" || name === "llms-full.txt") return "llms";
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type) return HTML_TYPES.test(type) ? "html" : "file";
  return FILE_EXT.test(name) ? "file" : "html";
}

function add(out: Issue[], id: string, severity: Issue["severity"], title: string, detail: string, page: string, fix: string): void {
  out.push({ id, severity, category: "seo", title, detail, page, fix });
}

/** A well-formed enough sitemap: one root element, closed, with <loc> entries inside <url> or <sitemap>. */
export function sitemapProblem(body: string): string {
  const text = body.replace(/^﻿/, "").trim();
  if (!text) return msg("The file is empty.");
  if (/^<!doctype html|<html[\s>]/i.test(text)) return msg("The address answers an HTML page, not XML.");
  const root = /^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<([a-z][\w:-]*)/i.exec(text)?.[1]?.replace(/^\w+:/, "").toLowerCase();
  if (root !== "urlset" && root !== "sitemapindex") return msg("The root element is neither <urlset> nor <sitemapindex>.");
  if (!new RegExp(`</(?:\\w+:)?${root}>\\s*$`, "i").test(text)) return msg("The XML is cut off: the root element is never closed.");
  const entry = root === "urlset" ? "url" : "sitemap";
  const locs = [...text.matchAll(new RegExp(`<(?:\\w+:)?${entry}[\\s>][\\s\\S]*?<(?:\\w+:)?loc>([^<]*)<`, "gi"))].map((m) => m[1].trim());
  if (!locs.length) return msgf("No <{entry}><loc> entries.", { entry });
  return "";
}

/** Sitemap <loc> values that are not absolute http(s) URLs (the protocol requires absolute ones). */
export function relativeLocs(body: string): string[] {
  return [...body.matchAll(/<(?:\w+:)?loc>([^<]*)</gi)].map((m) => m[1].trim()).filter((l) => !/^https?:\/\//i.test(l));
}

/** Checks one non-HTML resource. Pure. */
export function checkResource(path: string, page: FetchedPage): { check: ResourceCheck; issues: Issue[] } {
  const kind = resourceKind(path, page.contentType);
  const out: Issue[] = [];
  const at = page.finalUrl;
  const check: ResourceCheck = { path, url: at, kind, status: page.status, contentType: page.contentType };
  const servedHtml = HTML_TYPES.test(page.contentType) || /^\s*(?:<!doctype html|<html[\s>])/i.test(page.body);
  if (kind === "llms") {
    // llms.txt is an optional proposal (llmstxt.org): its absence is information, never a problem worth points.
    if (page.status === 404 || page.status === 410) {
      add(out, "resource.llms.missing", "low", msgf("No {path} (optional)", { path }), msg("llms.txt is an optional summary for AI assistants; nothing is broken without it."), at, msg("Add a /llms.txt (Markdown: an H1 with the site name, a one-line summary, links to key pages) if you want AI assistants to find your main pages."));
    } else if (page.status >= 400) {
      add(out, "resource.status", "low", msgf("{path} answers HTTP {status}", { path, status: page.status }), "", at, msg("Serve the file or stop linking to it."));
    } else if (servedHtml) {
      add(out, "resource.llms.html", "low", msgf("{path} answers an HTML page", { path }), msgf("Content-Type {type}.", { type: page.contentType || "none" }), at, msg("Serve llms.txt as plain text (text/plain or text/markdown), Markdown that starts with an H1."));
    } else if (!/^\s*#\s+\S/.test(page.body.replace(/^﻿/, ""))) {
      add(out, "resource.llms.h1", "low", msgf("{path} does not start with an H1", { path }), msg("The llms.txt format starts with \"# Site name\"."), at, msg("Start the file with \"# <site name>\" and a one-line summary in a > quote."));
    }
    return { check, issues: out };
  }
  if (page.status >= 400) {
    // robots.txt and the sitemap are also checked site-wide (seo.robots.missing, seo.sitemap): no second penalty here.
    if (kind === "file") add(out, "resource.status", "medium", msgf("{path} answers HTTP {status}", { path, status: page.status }), "", at, msg("Serve the file or remove it from the audited pages."));
    return { check, issues: out };
  }
  if (kind === "robots") {
    if (servedHtml) add(out, "resource.robots.html", "medium", msgf("{path} answers an HTML page", { path }), msg("Crawlers expect plain-text rules and ignore this file."), at, msg("Serve robots.txt as text/plain with User-agent / Allow / Sitemap lines."));
    else if (!/^\s*(?:user-agent|allow|disallow|sitemap|crawl-delay|host)\s*:/im.test(page.body)) add(out, "resource.robots.invalid", "low", msgf("{path} has no robots rules", { path }), msg("No User-agent, Allow, Disallow or Sitemap line was found."), at, msg("Write at least \"User-agent: *\", \"Allow: /\" and \"Sitemap: <absolute URL>\"."));
  } else if (kind === "sitemap") {
    const problem = sitemapProblem(page.body);
    if (problem) add(out, "resource.sitemap.invalid", "medium", msgf("{path} is not a valid sitemap", { path }), problem, at, msg("Serve XML with <urlset> and one <url><loc>absolute URL</loc></url> per public page."));
    else {
      const relative = relativeLocs(page.body);
      if (relative.length) add(out, "resource.sitemap.relative", "low", msgf("{count} sitemap URL(s) are relative", { count: relative.length }), relative.slice(0, 5).join(", "), at, msg("Write every <loc> as an absolute URL (https://...): the sitemap protocol requires it."));
    }
  }
  return { check, issues: out };
}
