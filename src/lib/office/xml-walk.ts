/**
 * A linear-time XML tag walker for text extraction from untrusted office files (no DOM on the server, no dependency).
 *
 * Threat model: a user uploads a tiny ZIP whose XML part is crafted to make a parser slow (unclosed tags, `<` without `>`,
 * deep nesting). Every character is visited a bounded number of times: one forward scan, no backtracking, no regex over
 * the document. Not a validating parser: malformed markup is skipped, never repaired. Entities are decoded per text chunk.
 */

export interface XmlVisitor {
  /** `attrs` is the raw attribute text after the name (may start with whitespace); `selfClosing` for `<x/>`. */
  open(name: string, attrs: string, selfClosing: boolean): void;
  close(name: string): void;
  /** Character data between tags, entities decoded (CDATA passed through verbatim). */
  text(value: string): void;
}

const LT = 60; // <
const GT = 62; // >

const NAMED: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

/** Decode the five XML entities and numeric references in one pass; an invalid reference is kept as written. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|lt|gt|quot|apos|amp);/g, (whole, ref: string) => {
    if (ref[0] !== "#") return NAMED[ref];
    const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

export function walkXml(xml: string, visitor: XmlVisitor): void {
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      visitor.text(decodeEntities(xml.slice(i)));
      return;
    }
    if (lt > i) visitor.text(decodeEntities(xml.slice(i, lt)));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) return;
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) return;
      visitor.text(xml.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) return;
      i = end + 2;
      continue;
    }
    // A tag runs to the next '>'; a '<' first means the '<' was stray text: resume there (each char is scanned once).
    let j = lt + 1;
    while (j < n) {
      const code = xml.charCodeAt(j);
      if (code === GT || code === LT) break;
      j += 1;
    }
    if (j >= n) return; // unterminated tag at the end: ignored
    if (xml.charCodeAt(j) === LT) {
      visitor.text(decodeEntities(xml.slice(lt, j)));
      i = j;
      continue;
    }
    i = j + 1;
    if (xml.charCodeAt(lt + 1) === 33) continue; // <!DOCTYPE ...> and other declarations
    if (xml.charCodeAt(lt + 1) === 47) {
      visitor.close(xml.slice(lt + 2, j).trim());
      continue;
    }
    const selfClosing = xml.charCodeAt(j - 1) === 47;
    const bodyEnd = selfClosing ? j - 1 : j;
    let k = lt + 1;
    while (k < bodyEnd && !isSpace(xml.charCodeAt(k))) k += 1;
    visitor.open(xml.slice(lt + 1, k), xml.slice(k, bodyEnd), selfClosing);
  }
}
