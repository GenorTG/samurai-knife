import { readZip, type ZipReader } from "./zip";
import type { OfficeFormat } from "./templates";
import { decodeEntities, walkXml } from "./xml-walk";

/**
 * Plain-text view of an office file for the assistant (knife_doc_read) and the version preview. Structure-light on
 * purpose: paragraphs for text documents, tab-separated rows per sheet, "Slide N" blocks for presentations.
 *
 * Threat model: the file is untrusted (any user upload). Parsing is a single linear pass per XML part (`xml-walk.ts`,
 * no regex over the document: the previous regex version went quadratic on unclosed tags), the inflated input is capped
 * (`TEXT_MAX_PART_BYTES` per part, `TEXT_MAX_TOTAL_BYTES` per file), and server callers run it in the isolate pool
 * (`extract.ts`) under a timeout. This module stays synchronous and pure so the isolate worker can import it.
 */

/** Largest single XML part read for text (inflated). */
export const TEXT_MAX_PART_BYTES = 20 * 1024 * 1024;
/** Largest total inflated size read for text across all parts. */
export const TEXT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Paragraph stack: text goes to the innermost open paragraph; a paragraph is emitted when it closes (unclosed = dropped). */
class Paragraphs {
  private readonly open: string[] = [];
  readonly done: string[] = [];
  start(): void {
    this.open.push("");
  }
  /** Self-closing paragraph. */
  empty(): void {
    this.done.push("");
  }
  add(text: string): void {
    if (this.open.length) this.open[this.open.length - 1] += text;
  }
  end(): void {
    const text = this.open.pop();
    if (text !== undefined) this.done.push(text);
  }
  get inside(): boolean {
    return this.open.length > 0;
  }
  /** Take the paragraphs finished so far (used per table cell / page). */
  take(): string[] {
    return this.done.splice(0);
  }
}

/**
 * w:t / a:t text plus tabs and line breaks. WordprocessingML puts `<w:tab/>`/`<w:br/>` inside runs (a `w:tab` elsewhere is
 * a tab stop definition, not text); DrawingML puts `<a:br>` between runs.
 */
function runParagraphs(xml: string, prefix: "w" | "a"): string[] {
  const P = `${prefix}:p`;
  const T = `${prefix}:t`;
  const R = `${prefix}:r`;
  const paragraphs = new Paragraphs();
  let inText = 0;
  let inRun = 0;
  walkXml(xml, {
    open(name, _attrs, selfClosing) {
      if (name === P) {
        if (selfClosing) paragraphs.empty();
        else paragraphs.start();
      } else if (name === T) {
        if (!selfClosing) inText += 1;
      } else if (name === R) {
        if (!selfClosing) inRun += 1;
      } else if (paragraphs.inside && (prefix === "a" || inRun > 0)) {
        if (selfClosing && name === `${prefix}:tab`) paragraphs.add("\t");
        else if (name === `${prefix}:br` && (selfClosing || prefix === "a")) paragraphs.add("\n");
      }
    },
    close(name) {
      if (name === P) paragraphs.end();
      else if (name === T) inText = Math.max(0, inText - 1);
      else if (name === R) inRun = Math.max(0, inRun - 1);
    },
    text(value) {
      if (inText > 0) paragraphs.add(value);
    },
  });
  return paragraphs.done;
}

function docxText(zip: ZipReader): string {
  return runParagraphs(zip.text("word/document.xml") ?? "", "w").join("\n");
}

/** `name="value"` from a raw attribute string (attribute strings are short; the pattern has no nested quantifier). */
function attr(attrs: string, name: string): string | undefined {
  const at = attrs.search(new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}="`));
  if (at < 0) return undefined;
  const start = attrs.indexOf('"', at) + 1;
  const end = attrs.indexOf('"', start);
  return end < 0 ? undefined : attrs.slice(start, end);
}

function sheetOrder(zip: ZipReader): { name: string; path: string }[] {
  const targets = new Map<string, string>();
  walkXml(zip.text("xl/_rels/workbook.xml.rels") ?? "", {
    open(name, attrs) {
      if (name !== "Relationship") return;
      const id = attr(attrs, "Id");
      const target = attr(attrs, "Target");
      if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    },
    close() {},
    text() {},
  });
  const out: { name: string; path: string }[] = [];
  walkXml(zip.text("xl/workbook.xml") ?? "", {
    open(name, attrs) {
      if (name !== "sheet") return;
      const rid = attr(attrs, "r:id");
      const path = rid ? targets.get(rid) : undefined;
      if (path) out.push({ name: decodeEntities(attr(attrs, "name") ?? "Sheet"), path });
    },
    close() {},
    text() {},
  });
  return out;
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Column letters of a cell reference like `AB12` (empty when it is not one). */
function refColumn(ref: string | undefined): string {
  const match = ref ? /^([A-Z]+)\d+$/.exec(ref) : null;
  return match ? match[1] : "";
}

function sharedStrings(zip: ZipReader): string[] {
  const shared: string[] = [];
  let current: string | null = null;
  let inText = 0;
  walkXml(zip.text("xl/sharedStrings.xml") ?? "", {
    open(name, _attrs, selfClosing) {
      if (name === "si") current = selfClosing ? null : "";
      else if (name === "t" && !selfClosing && current !== null) inText += 1;
      if (name === "si" && selfClosing) shared.push("");
    },
    close(name) {
      if (name === "si" && current !== null) {
        shared.push(current);
        current = null;
        inText = 0;
      } else if (name === "t") inText = Math.max(0, inText - 1);
    },
    text(value) {
      if (inText > 0 && current !== null) current += value;
    },
  });
  return shared;
}

function sheetLines(xml: string, shared: string[]): string[] {
  const lines: string[] = [];
  let cells: string[] | null = null;
  let cell: { col: string; type: string | undefined; value: string; v: string | null; inV: boolean; inT: number } | null = null;
  const finishCell = () => {
    if (!cell || !cells) return;
    let value = "";
    if (cell.type === "inlineStr") value = cell.value;
    else if (cell.v !== null) value = cell.type === "s" ? (shared[Number(cell.v)] ?? "") : cell.v;
    const index = cell.col ? columnIndex(cell.col) : cells.length;
    while (cells.length < index) cells.push("");
    cells[index] = value;
    cell = null;
  };
  const finishRow = () => {
    if (!cells) return;
    while (cells.length && cells[cells.length - 1] === "") cells.pop();
    lines.push(cells.join("\t"));
    cells = null;
  };
  walkXml(xml, {
    open(name, attrs, selfClosing) {
      if (name === "row") {
        finishRow();
        cells = [];
        if (selfClosing) finishRow();
      } else if (name === "c" && cells) {
        cell = { col: refColumn(attr(attrs, "r")), type: attr(attrs, "t"), value: "", v: null, inV: false, inT: 0 };
        if (selfClosing) finishCell();
      } else if (cell && !selfClosing) {
        if (name === "v" && cell.v === null) {
          cell.inV = true;
          cell.v = "";
        } else if (name === "t") cell.inT += 1;
      }
    },
    close(name) {
      if (name === "row") finishRow();
      else if (name === "c") finishCell();
      else if (cell && name === "v") cell.inV = false;
      else if (cell && name === "t") cell.inT = Math.max(0, cell.inT - 1);
    },
    text(value) {
      if (!cell) return;
      if (cell.inV) cell.v += value;
      if (cell.inT > 0) cell.value += value;
    },
  });
  return lines;
}

function xlsxText(zip: ZipReader): string {
  const shared = sharedStrings(zip);
  return sheetOrder(zip)
    .map((sheet) => {
      const lines = sheetLines(zip.text(sheet.path) ?? "", shared);
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      return `# Sheet: ${sheet.name}\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

function pptxText(zip: ZipReader): string {
  const slides = zip
    .names()
    .filter((n) => /^ppt\/slides\/slide\d{1,6}\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  return slides
    .map((name, i) => `# Slide ${i + 1}\n${runParagraphs(zip.text(name) ?? "", "a").filter((t) => t.trim()).join("\n")}`)
    .join("\n\n");
}

const ODF_PARAGRAPH = new Set(["text:p", "text:h"]);

/**
 * ODF: every paragraph's character data (spans, links, list items...), `text:tab` / `text:line-break` / `text:s` spaces.
 * Paragraphs are grouped per table cell (ods) or per page (odp) by the callers through `onClose`.
 */
function odfWalk(xml: string, paragraphs: Paragraphs, onOpen: (name: string, attrs: string, selfClosing: boolean) => void, onClose: (name: string) => void): void {
  walkXml(xml, {
    open(name, attrs, selfClosing) {
      if (ODF_PARAGRAPH.has(name)) {
        if (selfClosing) paragraphs.empty();
        else paragraphs.start();
      } else if (selfClosing && name === "text:tab") paragraphs.add("\t");
      else if (selfClosing && name === "text:line-break") paragraphs.add("\n");
      else if (selfClosing && name === "text:s") {
        const count = Number(attr(attrs, "text:c") ?? 1);
        paragraphs.add(" ".repeat(Number.isInteger(count) && count > 0 ? Math.min(count, 1000) : 1));
      }
      onOpen(name, attrs, selfClosing);
    },
    close(name) {
      if (ODF_PARAGRAPH.has(name)) paragraphs.end();
      onClose(name);
    },
    text(value) {
      paragraphs.add(value);
    },
  });
}

function odfText(zip: ZipReader, format: "odt" | "ods" | "odp"): string {
  const xml = zip.text("content.xml") ?? "";
  const paragraphs = new Paragraphs();
  if (format === "odt") {
    odfWalk(xml, paragraphs, () => {}, () => {});
    return paragraphs.done.join("\n");
  }
  if (format === "ods") {
    const sheets: string[] = [];
    let table: { name: string; rows: string[] } | null = null;
    let row: string[] | null = null;
    let cellDepth = 0;
    const endCell = () => {
      const text = paragraphs.take().join(" ");
      if (row) row.push(text);
    };
    const endRow = () => {
      if (table && row) {
        // Trailing tabs trimmed by a scan, not /\t+$/: that regex is quadratic on a long run of tabs.
        const line = row.join("\t");
        let end = line.length;
        while (end > 0 && line.charCodeAt(end - 1) === 9) end -= 1;
        table.rows.push(line.slice(0, end));
      }
      row = null;
    };
    const endTable = () => {
      if (!table) return;
      while (table.rows.length && table.rows[table.rows.length - 1] === "") table.rows.pop();
      sheets.push(`# Sheet: ${table.name}\n${table.rows.join("\n")}`);
      table = null;
    };
    odfWalk(
      xml,
      paragraphs,
      (name, attrs, selfClosing) => {
        if (name === "table:table" && !selfClosing) {
          table = { name: decodeEntities(attr(attrs, "table:name") ?? "Sheet"), rows: [] };
        } else if (name === "table:table-row" && table) {
          row = [];
          if (selfClosing) endRow();
        } else if (name === "table:table-cell" && row) {
          paragraphs.take();
          if (selfClosing) row.push("");
          else cellDepth += 1;
        }
      },
      (name) => {
        if (name === "table:table-cell" && cellDepth > 0) {
          cellDepth -= 1;
          endCell();
        } else if (name === "table:table-row") endRow();
        else if (name === "table:table") endTable();
      },
    );
    return sheets.join("\n\n");
  }
  const pages: string[] = [];
  let inPage = false;
  odfWalk(
    xml,
    paragraphs,
    (name, _attrs, selfClosing) => {
      if (name !== "draw:page") return;
      paragraphs.take();
      if (selfClosing) pages.push("");
      else inPage = true;
    },
    (name) => {
      if (name !== "draw:page" || !inPage) return;
      inPage = false;
      pages.push(paragraphs.take().filter((t) => t.trim()).join("\n"));
    },
  );
  return pages.map((text, i) => `# Slide ${i + 1}\n${text}`).join("\n\n");
}

export function extractText(format: OfficeFormat, bytes: Buffer): string {
  const zip = readZip(bytes, TEXT_MAX_TOTAL_BYTES, TEXT_MAX_PART_BYTES);
  switch (format) {
    case "docx":
      return docxText(zip);
    case "xlsx":
      return xlsxText(zip);
    case "pptx":
      return pptxText(zip);
    default:
      return odfText(zip, format);
  }
}
