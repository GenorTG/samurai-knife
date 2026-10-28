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

// What a CV sheet (CvDocument) is made of; everything else is dropped. Allowlists, not blocklists: anything the
// renderer or a browser could fetch, run or navigate to is either not on these lists or filtered below.
const KEEP_TAGS = new Set(["article", "header", "footer", "section", "aside", "div", "span", "p", "h1", "h2", "h3", "ul", "ol", "li", "a", "b", "strong", "em", "i", "small", "br", "img", "svg", "path", "style"]);
// Dropped together with everything inside them (their content is code, a document or a form, never sheet text).
const DROP_WITH_CONTENT = new Set(["script", "style", "template", "iframe", "object", "embed", "noscript", "textarea", "select", "title", "head", "foreignobject", "math", "video", "audio", "canvas", "frameset", "noembed", "xmp", "plaintext"]);
const KEEP_ATTRS = new Set(["class", "style", "href", "alt", "lang", "role", "viewbox", "width", "height", "d", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "focusable", "rel", "target", "src"]);
const SAFE_HREF = /^(https?:\/\/|mailto:|tel:)/i;
const SAFE_STYLE_DECL = /^--cv-[a-z-]+\s*:\s*[#a-z0-9.() ,-]+$/i;
const PAGE_STYLE = /^@page \{ size: (letter|A4); \}$/;

function escapeText(text: string): string {
  return text.replace(/&(?!(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(text: string): string {
  return text.replace(/&(?!(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);)/gi, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function decodeAttr(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** One kept tag's attributes, filtered (null = the attribute is dropped). */
function keepAttr(tag: string, name: string, value: string, photoDataUrl: string | null): string | null {
  if (name.startsWith("data-") || name.startsWith("aria-")) return /^[a-z0-9-]+$/.test(name) ? value : null;
  if (!KEEP_ATTRS.has(name)) return null;
  // Control and whitespace characters hide schemes from a naive check ("java\tscript:").
  const plain = value.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
  if (name === "href") return tag === "a" && SAFE_HREF.test(plain) ? value : null;
  if (name === "src") return tag === "img" && photoDataUrl ? photoDataUrl : null;
  if (name === "style") {
    const kept = value.split(";").map((d) => d.trim()).filter((d) => SAFE_STYLE_DECL.test(d) && !/url|expression|\\/i.test(d));
    return kept.length ? kept.join(";") : null;
  }
  if (name === "target") return value === "_blank" ? value : null;
  if (/[:(]|url/i.test(plain) && name !== "d" && name !== "viewbox") return null;
  return value;
}

/**
 * Keeps only the sheet (`<article class="cvdoc" …>…</article>`) and rebuilds it from allowlisted tags and attributes:
 * no scripts, frames, forms, event handlers, external resources or links other than http(s)/mailto/tel survive, the
 * only image is the account's own photo, the only <style> is the paper size. Text is re-escaped, so markup split
 * around a removed tag ("<scr<script>ipt>") cannot reassemble.
 */
export function cleanSheet(html: string, photoDataUrl: string | null): string {
  const start = html.search(/<article\b[^>]*\bclass="cvdoc[ "]/);
  const end = html.lastIndexOf("</article>");
  if (start < 0 || end < start) throw new SheetError("not a CV sheet");
  const source = html.slice(start, end + "</article>".length);
  const token = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<[!?][^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  const attrRe = /([^\s"'<>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
  let out = "";
  let last = 0;
  let skip: string | null = null; // inside a dropped element: the tag whose end closes it
  let styleOpen = false;
  let styleText = "";
  for (let m = token.exec(source); m; m = token.exec(source)) {
    const text = source.slice(last, m.index);
    last = token.lastIndex;
    if (skip === null) {
      if (styleOpen) styleText += text;
      else out += escapeText(text);
    }
    const [, slash, rawTag, rawAttrs] = m;
    if (!rawTag) continue; // comment, CDATA, doctype, processing instruction
    const tag = rawTag.toLowerCase();
    if (skip !== null) {
      if (slash && tag === skip) skip = null;
      continue;
    }
    if (tag === "style") {
      // The sheet's own <style> holds exactly the paper size; anything else is dropped with its content.
      if (!slash) {
        styleOpen = true;
        styleText = "";
      } else if (styleOpen) {
        styleOpen = false;
        if (PAGE_STYLE.test(styleText.trim())) out += `<style>${styleText.trim()}</style>`;
      }
      continue;
    }
    if (styleOpen) continue;
    if (DROP_WITH_CONTENT.has(tag)) {
      if (!slash && !/\/\s*$/.test(rawAttrs)) skip = tag;
      continue;
    }
    if (!KEEP_TAGS.has(tag)) continue;
    if (slash) {
      if (tag !== "img" && tag !== "br") out += `</${tag}>`;
      continue;
    }
    const attrs: string[] = [];
    for (const a of rawAttrs.matchAll(attrRe)) {
      const name = a[1].toLowerCase();
      const quoted = a[2] ?? "";
      const value = decodeAttr(quoted.startsWith('"') || quoted.startsWith("'") ? quoted.slice(1, -1) : quoted);
      const kept = keepAttr(tag, name, value, photoDataUrl);
      if (kept !== null) attrs.push(`${name}="${escapeAttr(kept)}"`);
    }
    if (tag === "img" && !attrs.some((a) => a.startsWith("src="))) continue; // no photo: no image at all
    if (tag === "img" && !attrs.some((a) => a.startsWith("class="))) attrs.unshift('class="cv-photo"');
    const selfClosing = tag === "img" || tag === "br" || (tag === "path" && /\/\s*$/.test(rawAttrs));
    out += `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}${selfClosing && tag === "path" ? "/" : ""}>`;
  }
  if (skip === null && !styleOpen) out += escapeText(source.slice(last));
  return out;
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
