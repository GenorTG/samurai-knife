import { readZip, type ZipReader } from "./zip";
import type { OfficeFormat } from "./templates";
import { decodeEntities, walkXml, type XmlVisitor } from "./xml-walk";

/**
 * Plain-text view of an office file for the assistant (knife_doc_read) and the version preview. Structure-light on
 * purpose: paragraphs for text documents, tab-separated rows per sheet, "Slide N" blocks for presentations.
 *
 * Threat model: the file is untrusted (any user upload). Parsing is a single linear pass per XML part (`xml-walk.ts`,
 * no regex over the document: the previous regex version went quadratic on unclosed tags), the inflated input is capped
 * (`TEXT_MAX_PART_BYTES` per part, `TEXT_MAX_TOTAL_BYTES` per file), and so is the OUTPUT, while it is built: a few bytes
 * of markup can stand for much more text (a cell ref `r="XFD1"` pads 16k empty cells, `<text:s text:c="1000"/>`, one
 * shared string referenced by every cell), so every character appended is charged to a `TextBudget` and the walk stops
 * when it runs out. Server callers run it in the isolate pool (`extract.ts`) under a timeout and a heap cap. This module
 * stays synchronous and pure so the isolate worker can import it.
 */

/** Largest single XML part read for text (inflated). */
export const TEXT_MAX_PART_BYTES = 20 * 1024 * 1024;
/** Largest total inflated size read for text across all parts. */
export const TEXT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** Default (and largest) number of characters `extractText` produces; callers ask for less. */
export const TEXT_MAX_CHARS = 1_000_000;
/** Spreadsheet column limit (Excel's last column is XFD = 16384). A reference past it is ignored. */
export const SHEET_MAX_COLUMNS = 16_384;

/** Budget above the requested length, so the separators `TextBudget` overcounts never cut real text short. */
const TEXT_BUDGET_SLACK = 1_024;

/** Thrown out of the XML walk when the output budget is spent; caught by `extractTextBounded`. */
class BudgetSpent extends Error {}

/**
 * Characters the extraction may still produce. Charged as text enters an accumulator (plus separators), so the work and
 * memory spent on the output are bounded before any join: an upper bound of the final length, never an underestimate
 * (it overcounts by at most one separator per paragraph list, row list or sheet, hence `TEXT_BUDGET_SLACK`).
 */
class TextBudget {
  spent = false;
  private left: number;
  constructor(chars: number) {
    this.left = chars;
  }
  /** Charge `n` characters of markup-made text (separators, padding); throws BudgetSpent past the budget. */
  charge(n: number): void {
    this.left -= n;
    if (this.left < 0) this.stop();
  }
  /** Charge `text` and hand it to `put`; past the budget only the part that fits is handed over, then BudgetSpent. */
  add(text: string, put: (text: string) => void): void {
    if (text.length <= this.left) {
      this.left -= text.length;
      put(text);
      return;
    }
    if (this.left > 0) put(text.slice(0, this.left));
    this.stop();
  }
  private stop(): never {
    this.left = -1;
    this.spent = true;
    throw new BudgetSpent();
  }
  /** Stop before starting more work (a further sheet or slide) once spent. */
  check(): void {
    if (this.spent) throw new BudgetSpent();
  }
}

/** Paragraph stack: text goes to the innermost open paragraph; a paragraph is emitted when it closes (unclosed = dropped). */
class Paragraphs {
  private readonly open: string[] = [];
  readonly done: string[] = [];
  private readonly budget: TextBudget;
  constructor(budget: TextBudget) {
    this.budget = budget;
  }
  start(): void {
    this.open.push("");
  }
  /** Self-closing paragraph. */
  empty(): void {
    this.budget.charge(1);
    this.done.push("");
  }
  add(text: string): void {
    const top = this.open.length - 1;
    if (top < 0) return;
    this.budget.add(text, (fit) => {
      this.open[top] += fit;
    });
  }
  end(): void {
    if (!this.open.length) return;
    this.budget.charge(1); // the newline that joins it; on a spent budget the paragraph stays open for flushOpen
    this.done.push(this.open.pop() as string);
  }
  get inside(): boolean {
    return this.open.length > 0;
  }
  /** The budget ran out: keep the text of paragraphs still open (already charged) as finished ones. */
  flushOpen(): void {
    this.done.push(...this.open.splice(0));
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
function runParagraphs(xml: string, prefix: "w" | "a", paragraphs: Paragraphs): string[] {
  const P = `${prefix}:p`;
  const T = `${prefix}:t`;
  const R = `${prefix}:r`;
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

function docxText(zip: ZipReader, budget: TextBudget): string {
  const paragraphs = new Paragraphs(budget);
  untilSpent(() => runParagraphs(zip.text("word/document.xml") ?? "", "w", paragraphs));
  if (budget.spent) paragraphs.flushOpen();
  return paragraphs.done.join("\n");
}

/** Run `work`; a spent budget ends it early (what was collected so far stands), any other error propagates. */
function untilSpent(work: () => void): void {
  try {
    work();
  } catch (error) {
    if (!(error instanceof BudgetSpent)) throw error;
  }
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

/** Zero-based column of `AB`-style letters, or -1 past XFD (checked per letter, so a long run never overflows). */
function columnIndex(ref: string): number {
  if (ref.length > 3) return -1;
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n > SHEET_MAX_COLUMNS ? -1 : n - 1;
}

/** Column letters of a cell reference like `AB12` (empty when it is not one). */
function refColumn(ref: string | undefined): string {
  const match = ref && ref.length <= 16 ? /^([A-Z]+)\d+$/.exec(ref) : null;
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

function sheetLines(xml: string, shared: string[], budget: TextBudget, lines: string[]): void {
  let cells: string[] | null = null;
  let cell: { col: string; type: string | undefined; value: string; v: string | null; inV: boolean; inT: number } | null = null;
  const finishCell = () => {
    if (!cell || !cells) return;
    let value = "";
    if (cell.type === "inlineStr") value = cell.value;
    else if (cell.v !== null) value = cell.type === "s" ? (shared[Number(cell.v)] ?? "") : cell.v;
    const column = cell.col ? columnIndex(cell.col) : -1;
    const index = column >= 0 ? column : Math.min(cells.length, SHEET_MAX_COLUMNS - 1);
    cell = null;
    // Gap cells cost a tab each in the joined row: charged before they are allocated.
    budget.charge(Math.max(0, index - cells.length) + 1);
    while (cells.length < index) cells.push("");
    const row = cells;
    budget.add(value, (fit) => {
      row[index] = fit;
    });
  };
  const finishRow = () => {
    if (!cells) return;
    while (cells.length && cells[cells.length - 1] === "") cells.pop();
    budget.charge(1);
    lines.push(cells.join("\t"));
    cells = null;
  };
  const visitor: XmlVisitor = {
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
      if (cell.inT > 0) cell.value += value; // input-sized: charged once, when the cell is finished
    },
  };
  try {
    walkXml(xml, visitor);
  } catch (error) {
    // Out of budget mid-row: keep the cells finished so far (already charged).
    if (error instanceof BudgetSpent && cells) lines.push((cells as string[]).join("\t"));
    throw error;
  }
}

function xlsxText(zip: ZipReader, budget: TextBudget): string {
  const shared = sharedStrings(zip);
  const sheets: string[] = [];
  untilSpent(() => {
    for (const sheet of sheetOrder(zip)) {
      budget.check();
      const lines: string[] = [];
      budget.charge(sheet.name.length + 12); // "# Sheet: <name>\n" and the blank line between sheets
      try {
        sheetLines(zip.text(sheet.path) ?? "", shared, budget, lines);
      } finally {
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        sheets.push(`# Sheet: ${sheet.name}\n${lines.join("\n")}`);
      }
    }
  });
  return sheets.join("\n\n");
}

function pptxText(zip: ZipReader, budget: TextBudget): string {
  const names = zip
    .names()
    .filter((n) => /^ppt\/slides\/slide\d{1,6}\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  const slides: string[] = [];
  untilSpent(() => {
    for (const name of names) {
      budget.check();
      budget.charge(20); // "# Slide <n>\n" and the blank line between slides
      const paragraphs = new Paragraphs(budget);
      try {
        runParagraphs(zip.text(name) ?? "", "a", paragraphs);
      } finally {
        if (budget.spent) paragraphs.flushOpen();
        slides.push(`# Slide ${slides.length + 1}\n${paragraphs.done.filter((t) => t.trim()).join("\n")}`);
      }
    }
  });
  return slides.join("\n\n");
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

function odfText(zip: ZipReader, format: "odt" | "ods" | "odp", budget: TextBudget): string {
  const xml = zip.text("content.xml") ?? "";
  const paragraphs = new Paragraphs(budget);
  if (format === "odt") {
    untilSpent(() => odfWalk(xml, paragraphs, () => {}, () => {}));
    if (budget.spent) paragraphs.flushOpen();
    return paragraphs.done.join("\n");
  }
  if (format === "ods") {
    const sheets: string[] = [];
    let table: { name: string; rows: string[] } | null = null;
    let row: string[] | null = null;
    let cellDepth = 0;
    const endCell = () => {
      const text = paragraphs.take().join(" ");
      if (row) {
        budget.charge(1);
        row.push(text);
      }
    };
    const endRow = () => {
      if (table && row) {
        // Trailing tabs trimmed by a scan, not /\t+$/: that regex is quadratic on a long run of tabs.
        budget.charge(1);
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
    untilSpent(() => odfWalk(
      xml,
      paragraphs,
      (name, attrs, selfClosing) => {
        if (name === "table:table" && !selfClosing) {
          table = { name: decodeEntities(attr(attrs, "table:name") ?? "Sheet"), rows: [] };
          budget.charge(table.name.length + 12); // "# Sheet: <name>\n" and the blank line between sheets
        } else if (name === "table:table-row" && table) {
          row = [];
          if (selfClosing) endRow();
        } else if (name === "table:table-cell" && row) {
          paragraphs.take();
          if (selfClosing) {
            budget.charge(1);
            row.push("");
          } else cellDepth += 1;
        }
      },
      (name) => {
        if (name === "table:table-cell" && cellDepth > 0) {
          cellDepth -= 1;
          endCell();
        } else if (name === "table:table-row") endRow();
        else if (name === "table:table") endTable();
      },
    ));
    if (budget.spent) {
      // Keep the partial cell, row and sheet (their text is already charged).
      paragraphs.flushOpen();
      if (row) endCell();
      endRow();
      endTable();
    }
    return sheets.join("\n\n");
  }
  const pages: string[] = [];
  let inPage = false;
  untilSpent(() => odfWalk(
    xml,
    paragraphs,
    (name, _attrs, selfClosing) => {
      if (name !== "draw:page") return;
      budget.charge(20); // "# Slide <n>\n" and the blank line between slides
      paragraphs.take();
      if (selfClosing) pages.push("");
      else inPage = true;
    },
    (name) => {
      if (name !== "draw:page" || !inPage) return;
      inPage = false;
      pages.push(paragraphs.take().filter((t) => t.trim()).join("\n"));
    },
  ));
  if (budget.spent && inPage) {
    paragraphs.flushOpen();
    pages.push(paragraphs.take().filter((t) => t.trim()).join("\n"));
  }
  return pages.map((text, i) => `# Slide ${i + 1}\n${text}`).join("\n\n");
}

export interface ExtractedText {
  /** At most `maxChars` characters. */
  text: string;
  /** The document has more text than `maxChars` (extraction stopped early). */
  truncated: boolean;
}

/** Plain text of an office file, at most `maxChars` characters (capped at TEXT_MAX_CHARS); stops parsing once reached. */
export function extractTextBounded(format: OfficeFormat, bytes: Uint8Array, maxChars = TEXT_MAX_CHARS): ExtractedText {
  const limit = Math.max(0, Math.min(Math.floor(maxChars), TEXT_MAX_CHARS));
  // One character over the limit tells "exactly maxChars" from "more than maxChars".
  const budget = new TextBudget(limit + 1 + TEXT_BUDGET_SLACK);
  const zip = readZip(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), TEXT_MAX_TOTAL_BYTES, TEXT_MAX_PART_BYTES);
  let text: string;
  switch (format) {
    case "docx":
      text = docxText(zip, budget);
      break;
    case "xlsx":
      text = xlsxText(zip, budget);
      break;
    case "pptx":
      text = pptxText(zip, budget);
      break;
    default:
      text = odfText(zip, format, budget);
  }
  const truncated = budget.spent || text.length > limit;
  return { text: truncated ? text.slice(0, limit) : text, truncated };
}

/** In-process extraction (tests, trusted input). Server code on user files uses `extract.ts` (isolate pool). */
export function extractText(format: OfficeFormat, bytes: Buffer, maxChars = TEXT_MAX_CHARS): string {
  return extractTextBounded(format, bytes, maxChars).text;
}
