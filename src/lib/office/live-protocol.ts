/**
 * Live editing of the open office document: the wire protocol between the Smart Knife page and the editor plugin
 * (`sidecars/office/plugins/knife-bridge/bridge.js`). Pure: no DOM, no I/O, so the server (editor config), the browser
 * bridge (live-bridge.ts) and the unit tests share it. Contract and security model: docs/SIDECARS.md ("Live editing plugin").
 *
 * Handshake: plugin -> app window `hello {token}` (postMessage, targetOrigin = app origin); app checks origin, token and
 * that the sender sits inside its own editor iframe, then replies `welcome {token}` with a MessagePort. All requests and
 * responses travel over that private port afterwards.
 */

export const LIVE_PROTOCOL = "knife-office-bridge";
export const LIVE_PROTOCOL_VERSION = 1;
/** Must match `guid` in sidecars/office/plugins/knife-bridge/config.json. */
export const LIVE_PLUGIN_GUID = "asc.{6AF2FF69-9582-4CD7-A71D-9C3A6940B8F5}";

export type LiveEditor = "word" | "cell" | "slide";

export interface LiveHello {
  protocol: typeof LIVE_PROTOCOL;
  v: number;
  kind: "hello";
  token: string;
  editor: LiveEditor | "unknown";
  viewMode: boolean;
  title: string;
  plugin: string;
  commands: string[];
}

export interface LiveResponse {
  protocol: typeof LIVE_PROTOCOL;
  kind: "response";
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  ms?: number;
}

export interface LivePong {
  protocol: typeof LIVE_PROTOCOL;
  kind: "pong";
  id: string;
}

/** What the plugin reads from editorConfig.plugins.options[LIVE_PLUGIN_GUID]. */
export interface LivePluginOptions {
  token: string;
  appOrigin: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A hello for THIS session (right protocol, version and token), else null. Origin/source checks are the caller's. */
export function parseHello(data: unknown, token: string): LiveHello | null {
  if (!isRecord(data) || data.protocol !== LIVE_PROTOCOL || data.kind !== "hello") return null;
  if (data.v !== LIVE_PROTOCOL_VERSION || typeof data.token !== "string" || data.token !== token) return null;
  const editor = data.editor === "word" || data.editor === "cell" || data.editor === "slide" ? data.editor : "unknown";
  return {
    protocol: LIVE_PROTOCOL,
    v: LIVE_PROTOCOL_VERSION,
    kind: "hello",
    token,
    editor,
    viewMode: data.viewMode === true,
    title: typeof data.title === "string" ? data.title.slice(0, 200) : "",
    plugin: typeof data.plugin === "string" ? data.plugin.slice(0, 20) : "",
    commands: Array.isArray(data.commands) ? data.commands.filter((c): c is string => typeof c === "string").slice(0, 50) : [],
  };
}

export function parsePortMessage(data: unknown): LiveResponse | LivePong | null {
  if (!isRecord(data) || data.protocol !== LIVE_PROTOCOL || typeof data.id !== "string") return null;
  if (data.kind === "pong") return { protocol: LIVE_PROTOCOL, kind: "pong", id: data.id };
  if (data.kind !== "response" || typeof data.ok !== "boolean") return null;
  return {
    protocol: LIVE_PROTOCOL,
    kind: "response",
    id: data.id,
    ok: data.ok,
    data: data.data,
    error: typeof data.error === "string" ? data.error : undefined,
    ms: typeof data.ms === "number" ? data.ms : undefined,
  };
}

/** `http(s)://host[:port]` only (what window.location.origin gives), else null. */
export function normalizeOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
  if (value.replace(/\/$/, "") !== url.origin) return null;
  return url.origin;
}

/**
 * The app origin the browser claims (`?origin=` on the editor-config request) must name the host the request came to,
 * so the plugin only ever says hello to the page that asked for the editor.
 */
export function appOriginFor(claimed: string | null, hostHeader: string | null): string | null {
  if (!claimed || !hostHeader) return null;
  const origin = normalizeOrigin(claimed);
  if (!origin) return null;
  return new URL(origin).host.toLowerCase() === hostHeader.trim().toLowerCase() ? origin : null;
}

/* ------------------------------------------------------------------------------------------ assistant commands */

/** Plugin command names (the allowlist in bridge.js). */
export type LiveCommand =
  | "get_text"
  | "get_structure"
  | "get_selection"
  | "insert_text"
  | "replace_text"
  | "insert_paragraphs"
  | "set_paragraph_style"
  | "delete_range"
  | "add_comment"
  | "cells_read"
  | "cells_write"
  | "add_sheet"
  | "add_slide"
  | "format_text"
  | "insert_table"
  | "insert_list"
  | "set_header_footer"
  | "track_changes"
  | "cells_format"
  | "column_width"
  | "add_chart"
  | "sort_range"
  | "set_slide_text"
  | "set_slide_notes"
  | "delete_slide";

export const LIVE_READ_COMMANDS: ReadonlySet<LiveCommand> = new Set(["get_text", "get_structure", "get_selection", "cells_read"]);

export interface LiveCall {
  cmd: LiveCommand;
  args: Record<string, unknown>;
}

export type LiveArgs = Record<string, unknown>;

/** Short validation error for the model, or null. */
export type ArgCheck = { ok: true; call: LiveCall } | { ok: false; error: string };

const str = (args: LiveArgs, key: string): string | undefined => (typeof args[key] === "string" ? (args[key] as string) : undefined);
const int = (args: LiveArgs, key: string): number | undefined =>
  typeof args[key] === "number" && Number.isInteger(args[key]) ? (args[key] as number) : undefined;

const MAX_TEXT = 100_000;
const STYLE = /^[\p{L}\p{N} _-]{1,60}$/u;
const SHEET = /^[^\\/?*[\]:]{1,31}$/;
const RANGE = /^\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?$/;
const CELL = /^\$?[A-Za-z]{1,3}\$?\d{1,7}$/;
const HEX = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const FONT = /^[\p{L}\p{N} ._-]{1,60}$/u;
/** Highlight colours the word editor knows by name. */
export const HIGHLIGHTS = ["yellow", "green", "cyan", "magenta", "blue", "red", "darkBlue", "darkCyan", "darkGreen", "darkMagenta", "darkRed", "darkYellow", "lightGray", "darkGray", "black", "none"] as const;
/** Chart types the spreadsheet editor's AddChart takes. */
export const CHART_TYPES = ["bar", "barStacked", "barStackedPercent", "horizontalBar", "horizontalBarStacked", "lineNormal", "lineStacked", "pie", "doughnut", "scatter", "area", "areaStacked"] as const;
const ALIGN = ["left", "center", "right", "justify"] as const;

function rgb(value: unknown): { r: number; g: number; b: number } | null | undefined {
  if (value === undefined) return undefined;
  const m = typeof value === "string" ? HEX.exec(value.trim()) : null;
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}

/** "B" -> 1 (0-based column index). */
function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** "a1:c5" -> {abs:"$A$1:$C$5", firstCol, firstRow} (0-based). */
function absRange(range: string): { abs: string; col: number; row: number; lastCol: number } {
  const parts = range.replace(/\$/g, "").toUpperCase().split(":");
  const cell = (ref: string) => {
    const m = /^([A-Z]{1,3})(\d{1,7})$/.exec(ref) as RegExpExecArray;
    return { col: m[1], row: Number(m[2]) };
  };
  const a = cell(parts[0]);
  const b = cell(parts[1] ?? parts[0]);
  return { abs: `$${a.col}$${a.row}:$${b.col}$${b.row}`, col: colIndex(a.col), row: a.row - 1, lastCol: colIndex(b.col) };
}

/**
 * Assistant tool (doc_live_*) -> plugin command with validated arguments (doc_live_save is not a plugin command: it goes
 * through the server's force-save, see office-live-tools.ts). The plugin validates again inside the editor
 * (ranges, styles); this layer gives the model a precise error before anything reaches the document.
 */
export function toLiveCall(tool: string, args: LiveArgs): ArgCheck {
  const fail = (error: string): ArgCheck => ({ ok: false, error });
  const call = (cmd: LiveCommand, a: LiveArgs): ArgCheck => ({ ok: true, call: { cmd, args: a } });
  switch (tool) {
    case "doc_live_read": {
      const what = str(args, "what") ?? "text";
      const maxChars = int(args, "max_chars");
      if (maxChars !== undefined && (maxChars < 100 || maxChars > 60_000)) return fail("max_chars must be 100..60000");
      if (what === "text") return call("get_text", maxChars ? { max_chars: maxChars } : {});
      if (what === "selection") return call("get_selection", {});
      if (what === "structure") {
        const from = int(args, "from");
        const limit = int(args, "limit");
        if (from !== undefined && from < 0) return fail("from must be >= 0");
        if (limit !== undefined && (limit < 1 || limit > 500)) return fail("limit must be 1..500");
        return call("get_structure", { ...(from !== undefined ? { from } : {}), ...(limit !== undefined ? { limit } : {}) });
      }
      return fail('what must be "text", "structure" or "selection"');
    }
    case "doc_live_insert_text": {
      const text = str(args, "text");
      if (!text) return fail("text is required");
      if (text.length > MAX_TEXT) return fail(`text is longer than ${MAX_TEXT} characters`);
      const where = str(args, "where") ?? "end";
      if (where !== "cursor" && where !== "end") return fail('where must be "cursor" or "end"');
      return call("insert_text", { text, where });
    }
    case "doc_live_insert_paragraphs": {
      const list = args.paragraphs;
      if (!Array.isArray(list) || list.length === 0 || list.length > 200) return fail("paragraphs must be a list of 1..200 {text, style?}");
      const paragraphs: { text: string; style?: string }[] = [];
      for (const item of list) {
        if (typeof item === "string") {
          paragraphs.push({ text: item });
          continue;
        }
        if (typeof item !== "object" || item === null) return fail("each paragraph is {text, style?}");
        const p = item as LiveArgs;
        const text = str(p, "text");
        const style = str(p, "style");
        if (text === undefined || text.length > MAX_TEXT || text.includes("\n")) return fail("each paragraph needs text without line breaks (one list item per paragraph)");
        if (style !== undefined && !STYLE.test(style)) return fail(`bad style name "${style}"`);
        paragraphs.push(style ? { text, style } : { text });
      }
      const index = int(args, "index");
      if (index !== undefined && index < 0) return fail("index must be >= 0 (omit it to append)");
      return call("insert_paragraphs", { paragraphs, ...(index !== undefined ? { index } : {}) });
    }
    case "doc_live_replace": {
      const search = str(args, "search");
      const replace = str(args, "replace");
      if (!search) return fail("search is required");
      if (replace === undefined) return fail('replace is required ("" deletes every match)');
      if (search.length > 500 || replace.length > 5000) return fail("search max 500, replace max 5000 characters");
      return call("replace_text", { search, replace, match_case: args.match_case === true });
    }
    case "doc_live_set_style": {
      const from = int(args, "from");
      const to = int(args, "to");
      const style = str(args, "style");
      if (from === undefined || from < 0) return fail("from (paragraph index from doc_live_read structure) is required");
      if (to !== undefined && to < from) return fail("to must be >= from");
      if (!style || !STYLE.test(style)) return fail('style is required, e.g. "Heading 1", "Title", "Normal"');
      return call("set_paragraph_style", { from, ...(to !== undefined ? { to } : {}), style });
    }
    case "doc_live_delete": {
      const from = int(args, "from");
      const to = int(args, "to");
      if (from === undefined || from < 0) return fail("from (paragraph index from doc_live_read structure) is required");
      if (to !== undefined && to < from) return fail("to must be >= from");
      return call("delete_range", { from, ...(to !== undefined ? { to } : {}) });
    }
    case "doc_live_comment": {
      const text = str(args, "text");
      if (!text || text.length > 5000) return fail("text (1..5000 characters) is required");
      const quote = str(args, "quote");
      const index = int(args, "index");
      if (quote !== undefined && (quote.length === 0 || quote.length > 500)) return fail("quote must be 1..500 characters");
      return call("add_comment", { text, ...(quote ? { quote } : {}), ...(index !== undefined ? { index } : {}) });
    }
    case "doc_live_cells_read": {
      const range = str(args, "range");
      const sheet = str(args, "sheet");
      if (range !== undefined && !RANGE.test(range)) return fail('range must look like "A1" or "A1:C10"');
      if (sheet !== undefined && !SHEET.test(sheet)) return fail("bad sheet name");
      return call("cells_read", { ...(range ? { range } : {}), ...(sheet ? { sheet } : {}) });
    }
    case "doc_live_cells_write": {
      const start = str(args, "start");
      const sheet = str(args, "sheet");
      const values = args.values;
      if (!start || !CELL.test(start)) return fail('start must be the top-left cell, e.g. "A1"');
      if (sheet !== undefined && !SHEET.test(sheet)) return fail("bad sheet name");
      if (!Array.isArray(values) || values.length === 0 || values.length > 500) return fail("values must be a list of rows (1..500), each a list of cells");
      let cells = 0;
      for (const row of values) {
        if (!Array.isArray(row) || row.length > 100) return fail("each row must be a list of up to 100 cells");
        for (const v of row) {
          if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return fail("cells are text, numbers, booleans, null (skip) or formulas as text starting with =");
          if (typeof v === "string" && v.length > 5000) return fail("a cell is longer than 5000 characters");
          cells += 1;
        }
      }
      if (cells > 2000) return fail("write at most 2000 cells per call");
      return call("cells_write", { start, values, overwrite: args.overwrite === true, ...(sheet ? { sheet } : {}) });
    }
    case "doc_live_add_sheet": {
      const name = str(args, "name");
      if (!name || !SHEET.test(name)) return fail("name is required (max 31 characters, none of \\ / ? * [ ] :)");
      return call("add_sheet", { name });
    }
    case "doc_live_add_slide": {
      const title = str(args, "title");
      const body = str(args, "body");
      const index = int(args, "index");
      if (!title || title.length > 500) return fail("title (1..500 characters) is required");
      if (body !== undefined && body.length > 10_000) return fail("body max 10000 characters");
      if (index !== undefined && index < 0) return fail("index must be >= 0 (omit it to append)");
      return call("add_slide", { title, ...(body ? { body } : {}), ...(index !== undefined ? { index } : {}) });
    }
    case "doc_live_format": {
      const quote = str(args, "quote");
      const from = int(args, "from");
      const to = int(args, "to");
      if (quote !== undefined && (quote.length === 0 || quote.length > 500)) return fail("quote must be 1..500 characters");
      if (quote !== undefined && from !== undefined) return fail("pass quote OR from/to, not both");
      if (from !== undefined && from < 0) return fail("from must be >= 0");
      if (to !== undefined && (from === undefined || to < from)) return fail("to needs from, and must be >= from");
      const out: LiveArgs = {};
      for (const key of ["bold", "italic", "underline", "strikeout"]) {
        if (args[key] !== undefined && typeof args[key] !== "boolean") return fail(`${key} must be true or false`);
        if (typeof args[key] === "boolean") out[key] = args[key];
      }
      const color = rgb(args.color);
      if (color === null) return fail('color must be "#rrggbb"');
      if (color) out.color = color;
      const highlight = str(args, "highlight");
      if (highlight !== undefined && !(HIGHLIGHTS as readonly string[]).includes(highlight)) return fail(`highlight must be one of ${HIGHLIGHTS.join(", ")}`);
      if (highlight) out.highlight = highlight;
      if (args.size !== undefined && (typeof args.size !== "number" || args.size < 1 || args.size > 400)) return fail("size is the font size in points (1..400)");
      if (typeof args.size === "number") out.size = args.size;
      const font = str(args, "font");
      if (font !== undefined && !FONT.test(font)) return fail("bad font name");
      if (font) out.font = font;
      if (Object.keys(out).length === 0) return fail("nothing to change: pass bold, italic, underline, strikeout, color, highlight, size or font");
      return call("format_text", { ...out, ...(quote ? { quote, all: args.all === true, match_case: args.match_case === true } : {}), ...(from !== undefined ? { from, ...(to !== undefined ? { to } : {}) } : {}) });
    }
    case "doc_live_insert_table": {
      const rows = args.rows;
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > 200) return fail("rows must be a list of 1..200 rows, each a list of cell texts");
      let cells = 0;
      const clean: string[][] = [];
      for (const row of rows) {
        if (!Array.isArray(row) || row.length === 0 || row.length > 30) return fail("each row is a list of 1..30 cells");
        const out: string[] = [];
        for (const v of row) {
          if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return fail("cells are text or numbers");
          const text = v === null ? "" : String(v);
          if (text.length > 2000 || text.includes("\n")) return fail("a cell is one line of up to 2000 characters");
          out.push(text);
          cells += 1;
        }
        clean.push(out);
      }
      if (cells > 2000) return fail("at most 2000 cells per table");
      const index = int(args, "index");
      if (index !== undefined && index < 0) return fail("index must be >= 0 (omit it to append)");
      return call("insert_table", { rows: clean, header: args.header !== false, ...(index !== undefined ? { index } : {}) });
    }
    case "doc_live_insert_list": {
      const items = args.items;
      if (!Array.isArray(items) || items.length === 0 || items.length > 200) return fail("items must be a list of 1..200 texts");
      if (!items.every((i) => typeof i === "string" && i.length > 0 && i.length <= 5000 && !i.includes("\n"))) return fail("each item is one line of text (1..5000 characters)");
      const index = int(args, "index");
      if (index !== undefined && index < 0) return fail("index must be >= 0 (omit it to append)");
      return call("insert_list", { items, numbered: args.numbered === true, ...(index !== undefined ? { index } : {}) });
    }
    case "doc_live_header_footer": {
      const header = str(args, "header");
      const footer = str(args, "footer");
      if (header === undefined && footer === undefined) return fail("pass header and/or footer (\"\" empties it)");
      if ((header?.length ?? 0) > 2000 || (footer?.length ?? 0) > 2000) return fail("header and footer max 2000 characters");
      return call("set_header_footer", { ...(header !== undefined ? { header } : {}), ...(footer !== undefined ? { footer } : {}) });
    }
    case "doc_live_track_changes":
      if (typeof args.on !== "boolean") return fail("on must be true or false");
      return call("track_changes", { on: args.on });
    case "doc_live_cells_format": {
      const range = str(args, "range");
      const sheet = str(args, "sheet");
      if (!range || !RANGE.test(range)) return fail('range must look like "A1" or "A1:C10"');
      if (sheet !== undefined && !SHEET.test(sheet)) return fail("bad sheet name");
      const out: LiveArgs = {};
      for (const key of ["bold", "italic", "underline", "wrap"]) {
        if (args[key] !== undefined && typeof args[key] !== "boolean") return fail(`${key} must be true or false`);
        if (typeof args[key] === "boolean") out[key] = args[key];
      }
      for (const key of ["font_color", "fill"]) {
        const color = rgb(args[key]);
        if (color === null) return fail(`${key} must be "#rrggbb"`);
        if (color) out[key] = color;
      }
      if (args.font_size !== undefined && (typeof args.font_size !== "number" || args.font_size < 1 || args.font_size > 409)) return fail("font_size is 1..409 points");
      if (typeof args.font_size === "number") out.font_size = args.font_size;
      const format = str(args, "number_format");
      if (format !== undefined && (format.length === 0 || format.length > 100)) return fail('number_format like "0.00", "#,##0", "0%", "yyyy-mm-dd" (max 100 characters)');
      if (format) out.number_format = format;
      const align = str(args, "align");
      if (align !== undefined && !(ALIGN as readonly string[]).includes(align)) return fail(`align must be one of ${ALIGN.join(", ")}`);
      if (align) out.align = align;
      if (Object.keys(out).length === 0) return fail("nothing to change: pass bold, italic, underline, wrap, font_color, fill, font_size, number_format or align");
      return call("cells_format", { range, ...(sheet ? { sheet } : {}), ...out });
    }
    case "doc_live_column_width": {
      const columns = str(args, "columns")?.toUpperCase().replace(/\$/g, "");
      const sheet = str(args, "sheet");
      const m = columns ? /^([A-Z]{1,3})(?::([A-Z]{1,3}))?$/.exec(columns) : null;
      if (!m) return fail('columns is a column or a span: "B" or "A:D"');
      if (sheet !== undefined && !SHEET.test(sheet)) return fail("bad sheet name");
      const width = args.width;
      if (typeof width !== "number" || width < 0 || width > 255) return fail("width is in characters (0..255)");
      const first = colIndex(m[1]);
      const last = m[2] ? colIndex(m[2]) : first;
      if (last < first || last - first > 200) return fail("columns must go left to right, at most 200");
      return call("column_width", { columns, first, last, width, ...(sheet ? { sheet } : {}) });
    }
    case "doc_live_add_chart": {
      const range = str(args, "range");
      const sheet = str(args, "sheet");
      const type = str(args, "type") ?? "bar";
      const at = str(args, "at");
      if (!range || !RANGE.test(range) || !range.includes(":")) return fail('range is the data block with its header row, e.g. "A1:B6"');
      if (sheet !== undefined && !SHEET.test(sheet)) return fail("bad sheet name");
      if (!(CHART_TYPES as readonly string[]).includes(type)) return fail(`type must be one of ${CHART_TYPES.join(", ")}`);
      if (at !== undefined && !CELL.test(at)) return fail('at is the top-left cell of the chart, e.g. "E2"');
      const title = str(args, "title");
      if (title !== undefined && title.length > 200) return fail("title max 200 characters");
      const data = absRange(range);
      // Default: right of the data, one column gap.
      const anchor = at ? absRange(at) : { col: data.lastCol + 2, row: data.row };
      const size = (key: string, fallback: number) => (typeof args[key] === "number" ? Math.max(30, Math.min(500, args[key] as number)) : fallback);
      return call("add_chart", {
        abs: data.abs,
        type,
        at: at ?? null,
        at_col: anchor.col,
        at_row: anchor.row,
        width_mm: size("width_mm", 130),
        height_mm: size("height_mm", 75),
        in_rows: args.series_in_rows === true,
        ...(title ? { title } : {}),
        ...(sheet ? { sheet } : {}),
      });
    }
    case "doc_live_sort": {
      const range = str(args, "range");
      const sheet = str(args, "sheet");
      const by = str(args, "by")?.toUpperCase();
      if (!range || !RANGE.test(range) || !range.includes(":")) return fail('range is the block to sort, e.g. "A1:C20"');
      if (!by || !/^[A-Z]{1,3}$/.test(by)) return fail('by is the column letter to sort on, e.g. "B"');
      if (sheet !== undefined && !SHEET.test(sheet)) return fail("bad sheet name");
      const data = absRange(range);
      const col = colIndex(by);
      if (col < data.col || col > data.lastCol) return fail(`column ${by} is outside ${range}`);
      const firstRow = data.row + 1;
      return call("sort_range", { range, key: `${by}${firstRow}`, descending: args.descending === true, header: args.header !== false, ...(sheet ? { sheet } : {}) });
    }
    case "doc_live_slide_text": {
      const index = int(args, "index");
      const shape = int(args, "shape");
      const text = str(args, "text");
      if (index === undefined || index < 0) return fail("index (slide, 0-based, from doc_live_read structure) is required");
      if (shape === undefined || shape < 0) return fail("shape (from the slide's shapes in doc_live_read structure) is required");
      if (text === undefined || text.length > 10_000) return fail("text is required (max 10000 characters; \"\" empties the shape)");
      return call("set_slide_text", { index, shape, text });
    }
    case "doc_live_slide_notes": {
      const index = int(args, "index");
      const text = str(args, "text");
      if (index === undefined || index < 0) return fail("index (slide, 0-based) is required");
      if (text === undefined || text.length > 10_000) return fail("text is required (max 10000 characters)");
      return call("set_slide_notes", { index, text });
    }
    case "doc_live_delete_slide": {
      const index = int(args, "index");
      if (index === undefined || index < 0) return fail("index (slide, 0-based) is required");
      return call("delete_slide", { index });
    }
    default:
      return fail(`unknown live document tool "${tool}"`);
  }
}

/** Which editors each assistant tool works in (also decides which tools the model sees). */
export const LIVE_TOOL_EDITORS: Record<string, readonly LiveEditor[]> = {
  doc_live_read: ["word", "cell", "slide"],
  doc_live_save: ["word", "cell", "slide"],
  doc_live_insert_text: ["word"],
  doc_live_insert_paragraphs: ["word"],
  doc_live_replace: ["word"],
  doc_live_set_style: ["word"],
  doc_live_delete: ["word"],
  doc_live_comment: ["word"],
  doc_live_cells_read: ["cell"],
  doc_live_cells_write: ["cell"],
  doc_live_add_sheet: ["cell"],
  doc_live_add_slide: ["slide"],
  doc_live_format: ["word"],
  doc_live_insert_table: ["word"],
  doc_live_insert_list: ["word"],
  doc_live_header_footer: ["word"],
  doc_live_track_changes: ["word"],
  doc_live_cells_format: ["cell"],
  doc_live_column_width: ["cell"],
  doc_live_add_chart: ["cell"],
  doc_live_sort: ["cell"],
  doc_live_slide_text: ["slide"],
  doc_live_slide_notes: ["slide"],
  doc_live_delete_slide: ["slide"],
};

export type LiveRisk = "read" | "edit" | "destructive";

/** read = never asks; edit = acting call (asks in All/Most); destructive = asks in every mode except None, one by one. */
export function liveRisk(tool: string, args: LiveArgs): LiveRisk {
  switch (tool) {
    case "doc_live_read":
    case "doc_live_cells_read":
      return "read";
    case "doc_live_delete":
    case "doc_live_replace":
    case "doc_live_delete_slide":
    // These replace what is there (a shape's text, the header or footer).
    case "doc_live_slide_text":
    case "doc_live_header_footer":
      return "destructive";
    case "doc_live_cells_write":
      return args.overwrite === true ? "destructive" : "edit";
    default:
      return "edit";
  }
}
