import { readFileSync } from "node:fs";
import path from "node:path";
import { fontFiles, type CvFonts, type CvPaper } from "./layout";

/**
 * Server only: a CV sheet as a whole HTML document, for the PDF export (WeasyPrint, server/py/scripts/cv_pdf.py) and
 * the standalone HTML export. The sheet is the markup the CV studio preview rendered (`CvDocument`), sent by the
 * browser, so the file is what the user saw; the stylesheet is the app's own `cv-document.css`, read here (never sent
 * by the browser). The markup is reduced to what a CV sheet holds: no scripts, frames, external resources or event
 * handlers survive, every image source is replaced by the account's own photo (or dropped).
 */

export const MAX_SHEET_BYTES = 2 * 1024 * 1024;
const FONT_DIR = () => path.join(/*turbopackIgnore: true*/ process.cwd(), "public", "cv-fonts");
const CSS_FILE = () => path.join(/*turbopackIgnore: true*/ process.cwd(), "src", "tools", "cv", "cv-document.css");

export class SheetError extends Error {}

/** Keeps only the sheet (`<article class="cvdoc" …>…</article>`) and strips anything active or external from it. */
export function cleanSheet(html: string, photoDataUrl: string | null): string {
  const start = html.search(/<article\b[^>]*\bclass="cvdoc"/);
  const end = html.lastIndexOf("</article>");
  if (start < 0 || end < start) throw new SheetError("not a CV sheet");
  let sheet = html.slice(start, end + "</article>".length);
  // Elements that run code, embed other documents or pull resources.
  sheet = sheet.replace(/<(script|iframe|object|embed|link|meta|base|form|input|button|textarea|select|video|audio|source|template)\b[\s\S]*?(<\/\1\s*>|\/?>)/gi, "");
  // Event handlers and inline styles that load URLs (style attributes keep only custom properties, e.g. --cv-accent).
  sheet = sheet.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  sheet = sheet.replace(/\sstyle="([^"]*)"/gi, (_m, value: string) => {
    const kept = value.split(";").map((d) => d.trim()).filter((d) => /^--cv-[a-z-]+\s*:\s*[#a-z0-9.() ,-]+$/i.test(d));
    return kept.length ? ` style="${kept.join(";")}"` : "";
  });
  // The <style> the sheet itself carries is only the paper size: keep exactly that, nothing else.
  sheet = sheet.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m, css: string) => (/^@page \{ size: (letter|A4); \}$/.test(css.trim()) ? `<style>${css.trim()}</style>` : ""));
  // Links: http(s), mailto and tel only.
  sheet = sheet.replace(/\shref="([^"]*)"/gi, (_m, href: string) => (/^(https?:|mailto:|tel:)/i.test(href.trim()) ? ` href="${href}"` : ""));
  // Images: the account's own photo, never a URL from the markup.
  sheet = sheet.replace(/<img\b[^>]*>/gi, (tag) => {
    if (!photoDataUrl) return "";
    const cls = /\bclass="([^"]*)"/.exec(tag)?.[1] ?? "cv-photo";
    const alt = /\balt="([^"]*)"/.exec(tag)?.[1] ?? "";
    return `<img class="${cls}" src="${photoDataUrl}" alt="${alt}">`;
  });
  return sheet;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** cv-document.css with its font URLs pointed at `fontUrl(file)`, and only the @font-face rules of `keep`. */
function sheetCss(fontUrl: (file: string) => string, keep: Set<string>): string {
  const css = readFileSync(CSS_FILE(), "utf8");
  return css.replace(/@font-face \{[^}]*url\("\/cv-fonts\/([^"]+)"\)[^}]*\}\n?/g, (rule, file: string) => (keep.has(file) ? rule.replace(`/cv-fonts/${file}`, fontUrl(file)) : ""));
}

export interface SheetDocument {
  sheetHtml: string;
  lang: string;
  title: string;
  paper: CvPaper;
  fonts: Exclude<CvFonts, "auto">;
  photoDataUrl: string | null;
}

/** For the PDF: fonts by URL from the renderer's own allow-listed base (cv_pdf.py maps them to the files). */
export function pdfHtml(doc: SheetDocument): string {
  const keep = new Set(fontFiles(doc.fonts));
  return wrap(doc, sheetCss((file) => `https://cv.invalid/cv-fonts/${file}`, keep));
}

/** For the standalone HTML file: the fonts it uses embedded as data URLs, so it opens anywhere, offline, the same. */
export function standaloneHtml(doc: SheetDocument): string {
  const keep = new Set(fontFiles(doc.fonts));
  const css = sheetCss((file) => `data:font/woff2;base64,${readFileSync(path.join(FONT_DIR(), file)).toString("base64")}`, keep);
  return wrap(doc, `${css}\n@media screen { body { padding: 24px 0; background: #e9ebee; } }`);
}

function wrap(doc: SheetDocument, css: string): string {
  const sheet = cleanSheet(doc.sheetHtml, doc.photoDataUrl);
  const size = doc.paper === "letter" ? "letter" : "A4";
  return `<!doctype html>
<html lang="${escapeHtml(doc.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(doc.title)}</title>
<style>
${css}
@page { size: ${size}; margin: 15mm 17mm; }
@media print { body { margin: 0; } }
</style>
</head>
<body>
${sheet}
</body>
</html>
`;
}

/** The font files the PDF needs (copied into the job's scratch dir: the sandboxed renderer sees nothing else). */
export function pdfFontFiles(fonts: Exclude<CvFonts, "auto">): { name: string; path: string }[] {
  return fontFiles(fonts).map((name) => ({ name, path: path.join(FONT_DIR(), name) }));
}
