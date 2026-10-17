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
  | "add_slide";

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
      return "destructive";
    case "doc_live_cells_write":
      return args.overwrite === true ? "destructive" : "edit";
    default:
      return "edit";
  }
}
