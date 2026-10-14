/**
 * Minimal tolerant HTML reader for job postings (no HTML parser ships with the app and none is worth a dependency).
 * Pure. Builds a shallow tree, extracts readable text with block boundaries kept, and exposes script bodies raw.
 * Never executes or fetches anything; unknown or broken markup degrades to text.
 */

export interface HtmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlChild[];
}
export type HtmlChild = HtmlElement | string;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
const MAX_DEPTH = 200;

/** Elements whose text is never part of the posting. */
export const JUNK_TAGS = new Set(["script", "style", "noscript", "nav", "header", "footer", "aside", "form", "svg", "iframe", "button", "select", "template"]);
const BLOCK_TAGS = new Set(["p", "div", "section", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr"]);

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", bull: "•", middot: "·",
  copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„",
  euro: "€", pound: "£", times: "×", deg: "°", plusmn: "±", sect: "§", shy: "", zwnj: "", zwj: "", ensp: " ", emsp: " ", thinsp: " ",
  oacute: "ó", Oacute: "Ó", eacute: "é", Eacute: "É", aacute: "á", Aacute: "Á", iacute: "í", uacute: "ú", agrave: "à", egrave: "è",
  auml: "ä", Auml: "Ä", ouml: "ö", Ouml: "Ö", uuml: "ü", Uuml: "Ü", szlig: "ß", ccedil: "ç", ntilde: "ñ", aring: "å", oslash: "ø",
  aogon: "ą", Aogon: "Ą", eogon: "ę", Eogon: "Ę", cacute: "ć", Cacute: "Ć", lstrok: "ł", Lstrok: "Ł", nacute: "ń", Nacute: "Ń",
  sacute: "ś", Sacute: "Ś", zacute: "ź", Zacute: "Ź", zdot: "ż", Zdot: "Ż",
};

/** Decode numeric and common named character references. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,8}));/g, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED[name] ?? whole;
    const code = dec !== undefined ? Number(dec) : parseInt(hex ?? "", 16);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
    return String.fromCodePoint(code);
  });
}

/** Bounds the work per tag so unterminated quotes cannot make parsing quadratic. */
const MAX_TAG_CHARS = 65_536;
const OPEN_TAG = /^<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of source.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

export function parseHtml(source: string): HtmlElement {
  const root: HtmlElement = { tag: "#root", attrs: {}, children: [] };
  const stack: HtmlElement[] = [root];
  const top = (): HtmlElement => stack[stack.length - 1];
  const pushText = (raw: string, decode: boolean): void => {
    if (raw) top().children.push(decode ? decodeEntities(raw) : raw);
  };
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) {
      pushText(source.slice(i), true);
      break;
    }
    if (lt > i) pushText(source.slice(i, lt), true);
    i = lt;
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i);
      pushText(source.slice(i + 9, end < 0 ? source.length : end), false);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<!", i) || source.startsWith("<?", i)) {
      const end = source.indexOf(">", i);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source[i + 1] === "/") {
      const end = source.indexOf(">", i);
      const name = source.slice(i + 2, end < 0 ? source.length : end).trim().split(/\s/)[0].toLowerCase();
      i = end < 0 ? source.length : end + 1;
      for (let d = stack.length - 1; d > 0; d -= 1) {
        if (stack[d].tag === name) {
          stack.length = d;
          break;
        }
      }
      continue;
    }
    const open = OPEN_TAG.exec(source.slice(i, i + MAX_TAG_CHARS));
    if (!open) {
      pushText("<", false);
      i += 1;
      continue;
    }
    i += open[0].length;
    const tag = open[1].toLowerCase();
    const element: HtmlElement = { tag, attrs: parseAttrs(open[2]), children: [] };
    top().children.push(element);
    if (RAW_TEXT.has(tag) && !open[2].trimEnd().endsWith("/")) {
      const close = new RegExp(`</${tag}\\s*>`, "gi");
      close.lastIndex = i;
      const hit = close.exec(source);
      const body = source.slice(i, hit ? hit.index : source.length);
      if (body) element.children.push(tag === "title" || tag === "textarea" ? decodeEntities(body) : body);
      i = hit ? hit.index + hit[0].length : source.length;
      continue;
    }
    if (!VOID.has(tag) && !open[2].trimEnd().endsWith("/") && stack.length < MAX_DEPTH) stack.push(element);
  }
  return root;
}

export function findFirst(node: HtmlElement, test: (el: HtmlElement) => boolean): HtmlElement | null {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (test(child)) return child;
    const deeper = findFirst(child, test);
    if (deeper) return deeper;
  }
  return null;
}

export function findAll(node: HtmlElement, test: (el: HtmlElement) => boolean, out: HtmlElement[] = []): HtmlElement[] {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (test(child)) out.push(child);
    findAll(child, test, out);
  }
  return out;
}

/** Text of the element's own subtree with pieces trimmed and joined by single spaces (titles, headings). */
export function plainText(node: HtmlElement): string {
  const pieces: string[] = [];
  const visit = (el: HtmlElement): void => {
    for (const child of el.children) {
      if (typeof child === "string") {
        const t = child.replace(/\s+/g, " ").trim();
        if (t) pieces.push(t);
      } else if (!JUNK_TAGS.has(child.tag)) visit(child);
    }
  };
  visit(node);
  return pieces.join(" ");
}

/** Raw (undecoded) text of a raw-text element such as `<script>`. */
export function rawText(node: HtmlElement): string {
  return node.children.filter((c): c is string => typeof c === "string").join("");
}

/** Readable text: block boundaries become newlines, `<li>` become "- " bullets, junk subtrees are skipped. */
export function readableText(node: HtmlElement): string {
  const out: string[] = [];
  const visit = (el: HtmlElement): void => {
    for (const child of el.children) {
      if (typeof child === "string") {
        out.push(child);
        continue;
      }
      if (JUNK_TAGS.has(child.tag) || child.tag === "head" || child.tag === "title") continue;
      if (child.tag === "br") {
        out.push("\n");
        continue;
      }
      const block = BLOCK_TAGS.has(child.tag);
      if (block) out.push("\n");
      if (child.tag === "li") out.push("- ");
      visit(child);
      if (block) out.push("\n");
    }
  };
  visit(node);
  // `<li><p>text</p></li>` leaves the bullet alone on its line: join it with the text it introduces.
  return tidyText(out.join("")).replace(/^-\n+(?=[^\n-])/gm, "- ");
}

/** Collapse spaces per line, drop repeated blank lines. */
export function tidyText(text: string): string {
  const lines = text.split(/\r\n|\r|\n/).map((ln) => ln.replace(/[ \t ​]+/g, " ").trim());
  const out: string[] = [];
  for (const ln of lines) if (ln || (out.length && out[out.length - 1])) out.push(ln);
  return out.join("\n").trim();
}
