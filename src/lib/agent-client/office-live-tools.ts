import { activeLiveBridge, connectedLiveEditor, type OfficeLiveBridge } from "@/lib/office/live-bridge";
import { errorText, forceSaveDoc, getDoc } from "@/tools/sidecars/client";
import { CHART_TYPES, HIGHLIGHTS, LIVE_TOOL_EDITORS, liveRisk, toLiveCall } from "@/lib/office/live-protocol";
import type { Assessment } from "./approval-policy";
import type { TrustMode } from "./interaction";
import type { FunctionToolDef, ToolRunResult } from "./types";
import { ct } from "@/lib/i18n/client-locale";
import { msg } from "@/lib/i18n/msg";

/**
 * doc_live_* : the assistant reads and edits the document OPEN in the office editor, through the editor plugin
 * (src/lib/office/live-bridge.ts). Browser-side tools: the model only sees the ones that fit the connected editor
 * (word / cell / slide) and only while the plugin is connected; the group is preloaded on /tools/office.
 */

export const LIVE_TOOL_PREFIX = "doc_live_";
const RESULT_LIMIT = 14000;

function def(name: string, description: string, properties: Record<string, unknown>, required: string[]): FunctionToolDef {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}

const PARAGRAPH_INDEX = "Element index from doc_live_read {what:\"structure\"} (0-based; tables count as one element).";

export const LIVE_TOOL_DEFS: FunctionToolDef[] = [
  def(
    "doc_live_read",
    "Read the document open in the office editor, live (includes unsaved edits). what=text: the whole text (word: one line per paragraph; spreadsheet: active sheet as TSV; presentation: text per slide). what=structure: word = paragraphs with index, style and heading level (use the indices for the edit tools); spreadsheet = sheets and used ranges; presentation = slides with their texts. what=selection: what the user has selected.",
    {
      what: { type: "string", enum: ["text", "structure", "selection"], description: "Default text." },
      from: { type: "integer", minimum: 0, description: "structure: first element index (paging)." },
      limit: { type: "integer", minimum: 1, maximum: 500, description: "structure: max elements (default 200)." },
      max_chars: { type: "integer", minimum: 100, maximum: 60000, description: "text: cap (default 20000)." },
    },
    [],
  ),
  def(
    "doc_live_insert_text",
    "Word: type text into the open document. where=end (default) appends it as new paragraph(s) (each line = one paragraph; an empty last paragraph is filled first); where=cursor inserts at the user's cursor (replacing their selection).",
    { text: { type: "string" }, where: { type: "string", enum: ["end", "cursor"] } },
    ["text"],
  ),
  def(
    "doc_live_insert_paragraphs",
    "Word: insert paragraphs before element index (omit index to append), each optionally styled (\"Heading 1\".. \"Heading 9\", \"Title\", \"Normal\"...). One list item per paragraph, no line breaks inside.",
    {
      paragraphs: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: { type: "object", properties: { text: { type: "string" }, style: { type: "string" } }, required: ["text"], additionalProperties: false },
      },
      index: { type: "integer", minimum: 0, description: PARAGRAPH_INDEX },
    },
    ["paragraphs"],
  ),
  def(
    "doc_live_replace",
    "Word: replace EVERY occurrence of search with replace in the open document (\"\" deletes them); returns how many were replaced. The user confirms it.",
    { search: { type: "string" }, replace: { type: "string" }, match_case: { type: "boolean", description: "Default false." } },
    ["search", "replace"],
  ),
  def(
    "doc_live_set_style",
    "Word: set the paragraph style of elements from..to (inclusive), e.g. \"Heading 1\" to make a heading, \"Normal\" for body text.",
    { from: { type: "integer", minimum: 0, description: PARAGRAPH_INDEX }, to: { type: "integer", minimum: 0 }, style: { type: "string" } },
    ["from", "style"],
  ),
  def(
    "doc_live_delete",
    "Word: delete elements from..to (inclusive) from the open document; returns the removed text. The user confirms it.",
    { from: { type: "integer", minimum: 0, description: PARAGRAPH_INDEX }, to: { type: "integer", minimum: 0 } },
    ["from"],
  ),
  def(
    "doc_live_comment",
    "Word: add a review comment on the first occurrence of quote, or on paragraph index, or (neither) on the user's selection/cursor.",
    { text: { type: "string" }, quote: { type: "string" }, index: { type: "integer", minimum: 0 } },
    ["text"],
  ),
  def(
    "doc_live_cells_read",
    "Spreadsheet: read values and formulas of a range (default: the used range of the active sheet). Max 2000 cells.",
    { range: { type: "string", description: "A1 or A1:C10." }, sheet: { type: "string", description: "Sheet name (default: active)." } },
    [],
  ),
  def(
    "doc_live_cells_write",
    "Spreadsheet: write a block of cells starting at the top-left cell start. values = rows of cells (text, number, boolean, null = leave as is); text starting with = is a formula (e.g. \"=SUM(A1:A3)\"). Refuses to overwrite non-empty cells (it lists them) unless overwrite=true, which the user confirms.",
    {
      start: { type: "string", description: "Top-left cell, e.g. A1." },
      values: { type: "array", items: { type: "array", items: { type: ["string", "number", "boolean", "null"] } } },
      sheet: { type: "string" },
      overwrite: { type: "boolean" },
    },
    ["start", "values"],
  ),
  def("doc_live_add_sheet", "Spreadsheet: add a new sheet (it becomes the active one).", { name: { type: "string" } }, ["name"]),
  def(
    "doc_live_add_slide",
    "Presentation: add a slide with a title and optional body text (each line one paragraph) at index (default: end).",
    { title: { type: "string" }, body: { type: "string" }, index: { type: "integer", minimum: 0 } },
    ["title"],
  ),
  def(
    "doc_live_save",
    "Save the open document now (force-save), so the library copy (knife_doc_read, Download) has the latest edits. Edits are also saved when the editor closes.",
    {},
    [],
  ),
  // Word: formatting, tables, lists, header and footer, track changes.
  def(
    "doc_live_format",
    "Word: character formatting. Target: quote (the first occurrence of that text; all:true = every occurrence), or elements from..to (whole paragraphs), or neither = the user's selection. Set any of bold, italic, underline, strikeout, color \"#rrggbb\", highlight (a colour name), size (points), font.",
    {
      quote: { type: "string" },
      all: { type: "boolean" },
      match_case: { type: "boolean" },
      from: { type: "integer", minimum: 0, description: PARAGRAPH_INDEX },
      to: { type: "integer", minimum: 0 },
      bold: { type: "boolean" },
      italic: { type: "boolean" },
      underline: { type: "boolean" },
      strikeout: { type: "boolean" },
      color: { type: "string", description: "#rrggbb" },
      highlight: { type: "string", enum: [...HIGHLIGHTS] },
      size: { type: "number", minimum: 1, maximum: 400 },
      font: { type: "string" },
    },
    [],
  ),
  def(
    "doc_live_insert_table",
    "Word: insert a table (rows of cell texts; the first row is a bold header unless header:false) before element index, or at the end.",
    {
      rows: { type: "array", minItems: 1, maxItems: 200, items: { type: "array", minItems: 1, maxItems: 30, items: { type: "string" } } },
      header: { type: "boolean", description: "Default true." },
      index: { type: "integer", minimum: 0, description: PARAGRAPH_INDEX },
    },
    ["rows"],
  ),
  def(
    "doc_live_insert_list",
    "Word: insert a bulleted (or numbered:true) list, one item per paragraph, before element index or at the end.",
    { items: { type: "array", minItems: 1, maxItems: 200, items: { type: "string" } }, numbered: { type: "boolean" }, index: { type: "integer", minimum: 0, description: PARAGRAPH_INDEX } },
    ["items"],
  ),
  def(
    "doc_live_header_footer",
    "Word: set the page header and/or footer text (replaces what is there; \"\" empties it). The user confirms it.",
    { header: { type: "string" }, footer: { type: "string" } },
    [],
  ),
  def("doc_live_track_changes", "Word: turn track changes on or off (with it on, your edits show as suggestions the user accepts or rejects).", { on: { type: "boolean" } }, ["on"]),
  // Spreadsheets: formats, column widths, charts, sorting.
  def(
    "doc_live_cells_format",
    "Spreadsheet: format a range: bold, italic, underline, wrap, font_size, font_color / fill \"#rrggbb\", number_format (\"0.00\", \"#,##0\", \"0%\", \"yyyy-mm-dd\", \"[$€-x-euro2] #,##0.00\"), align.",
    {
      range: { type: "string" },
      sheet: { type: "string" },
      bold: { type: "boolean" },
      italic: { type: "boolean" },
      underline: { type: "boolean" },
      wrap: { type: "boolean" },
      font_size: { type: "number" },
      font_color: { type: "string" },
      fill: { type: "string" },
      number_format: { type: "string" },
      align: { type: "string", enum: ["left", "center", "right", "justify"] },
    },
    ["range"],
  ),
  def("doc_live_column_width", "Spreadsheet: set the width of a column or a span (\"B\", \"A:D\") in characters.", { columns: { type: "string" }, width: { type: "number", minimum: 0, maximum: 255 }, sheet: { type: "string" } }, ["columns", "width"]),
  def(
    "doc_live_add_chart",
    "Spreadsheet: add a chart of a data block with its header row (e.g. \"A1:B6\": categories in the first column, one series per further column). at = top-left cell of the chart (default: right of the data).",
    {
      range: { type: "string" },
      type: { type: "string", enum: [...CHART_TYPES], description: "Default bar." },
      title: { type: "string" },
      at: { type: "string" },
      sheet: { type: "string" },
      width_mm: { type: "number" },
      height_mm: { type: "number" },
      series_in_rows: { type: "boolean", description: "Series are rows instead of columns." },
    },
    ["range"],
  ),
  def(
    "doc_live_sort",
    "Spreadsheet: sort the rows of a block by one column (by = its letter). header (default true) keeps the first row in place.",
    { range: { type: "string" }, by: { type: "string" }, descending: { type: "boolean" }, header: { type: "boolean" }, sheet: { type: "string" } },
    ["range", "by"],
  ),
  // Presentations: slide text, notes, delete.
  def(
    "doc_live_slide_text",
    "Presentation: replace the text of one shape on a slide (index and shape from doc_live_read {what:\"structure\"}: each slide lists its text shapes). The user confirms it.",
    { index: { type: "integer", minimum: 0 }, shape: { type: "integer", minimum: 0 }, text: { type: "string" } },
    ["index", "shape", "text"],
  ),
  def("doc_live_slide_notes", "Presentation: set the speaker notes of a slide (replaces them).", { index: { type: "integer", minimum: 0 }, text: { type: "string" } }, ["index", "text"]),
  def("doc_live_delete_slide", "Presentation: delete a slide (returns its texts). The user confirms it.", { index: { type: "integer", minimum: 0 } }, ["index"]),
];

export function isLiveTool(name: string): boolean {
  return name.startsWith(LIVE_TOOL_PREFIX);
}

/** A doc_live_* tool is offered only while an editor of the right type is connected. */
export function liveToolAvailable(name: string): boolean {
  if (!isLiveTool(name)) return true;
  const editor = connectedLiveEditor();
  return editor !== null && (LIVE_TOOL_EDITORS[name] ?? []).includes(editor);
}

/** For page snapshots: one line the model can act on. */
export function liveStatusNote(): string | null {
  const bridge = activeLiveBridge();
  if (!bridge) return null;
  const state = bridge.state;
  if (state.state === "connected") {
    return `Live editing CONNECTED to "${bridge.docName}" (${state.editor} editor${state.viewMode ? ", read-only" : ""}): read and edit it with the doc_live_* tools (the user sees every change at once and can undo with Ctrl+Z in the editor).`;
  }
  if (state.state === "connecting") return `Live editing for "${bridge.docName}" is connecting (the editor is still loading); doc_live_* tools appear once it is connected.`;
  return `Live editing unavailable for "${bridge.docName}": ${state.reason}. Use knife_doc_read for the saved copy.`;
}

export function liveStatus(): { document: string; state: string; editor?: string; read_only?: boolean; reason?: string } | null {
  const bridge = activeLiveBridge();
  if (!bridge) return null;
  const state = bridge.state;
  if (state.state === "connected") return { document: bridge.docName, state: "connected", editor: state.editor, read_only: state.viewMode };
  if (state.state === "unavailable") return { document: bridge.docName, state: "unavailable", reason: state.reason };
  return { document: bridge.docName, state: "connecting" };
}

const NO: Assessment = { ask: false, destructive: false, title: "", detail: "" };

/** Trust-mode verdict for a doc_live_* call (see approval-policy.ts for the modes). */
export function assessLiveCall(name: string, args: Record<string, unknown>, mode: TrustMode, detail: string, docName: string): Assessment {
  if (mode === "free") return NO;
  const risk = liveRisk(name, args);
  if (risk === "read") return NO;
  // whole sentences (with or without the document's name), so each translates as one text
  const doc = docName;
  if (risk === "destructive") {
    const slide = typeof args.index === "number" ? args.index + 1 : "";
    const search = String(args.search ?? "").slice(0, 40);
    const titles: Record<string, string> = doc
      ? {
          doc_live_delete: ct("Delete paragraphs in “{doc}”?", { doc }),
          doc_live_replace: ct("Replace every “{search}” in “{doc}”?", { search, doc }),
          doc_live_delete_slide: ct("Delete slide {slide} in “{doc}”?", { slide, doc }),
          doc_live_slide_text: ct("Replace text on slide {slide} in “{doc}”?", { slide, doc }),
          doc_live_header_footer: ct("Replace the header or footer in “{doc}”?", { doc }),
        }
      : {
          doc_live_delete: ct("Delete paragraphs?"),
          doc_live_replace: ct("Replace every “{search}”?", { search }),
          doc_live_delete_slide: ct("Delete slide {slide}?", { slide }),
          doc_live_slide_text: ct("Replace text on slide {slide}?", { slide }),
          doc_live_header_footer: ct("Replace the header or footer?"),
        };
    const title = titles[name] ?? (doc ? ct("Overwrite cells in “{doc}”?", { doc }) : ct("Overwrite cells?"));
    return { ask: true, destructive: true, title, detail: ct("{detail} (undo with Ctrl+Z in the editor)", { detail }) };
  }
  if (mode === "destructive") return NO;
  return { ask: true, destructive: false, title: doc ? ct("Edit the open document “{doc}”?", { doc }) : ct("Edit the open document?"), detail };
}

function out(ok: boolean, body: object): ToolRunResult {
  const text = JSON.stringify(body);
  if (text.length <= RESULT_LIMIT) return { ok, content: text };
  return { ok, content: JSON.stringify({ ok, _truncated: true, preview: text.slice(0, RESULT_LIMIT - 100) }) };
}

export async function runLiveTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolRunResult> {
  const bridge = activeLiveBridge();
  if (!bridge || !bridge.connected) {
    const why = bridge
      ? liveStatusNote()
      : "No office document is open in the editor on this page.";
    return out(false, {
      ok: false,
      error: `${why} To edit live: open_tool office, click Open on the document and wait until page_snapshot says live editing is connected. For the saved file use knife_doc_read / knife_doc_create.`,
    });
  }
  const editor = connectedLiveEditor();
  const editors = LIVE_TOOL_EDITORS[name];
  if (!editors) return out(false, { ok: false, error: `Unknown tool "${name}".` });
  if (!editor || !editors.includes(editor)) return out(false, { ok: false, error: `${name} works in the ${editors.join("/")} editor; the open document is a ${editor ?? "unknown"} document.` });
  if (name === "doc_live_save") return saveLive(bridge, signal);
  const checked = toLiveCall(name, args);
  if (!checked.ok) return out(false, { ok: false, error: checked.error });
  const result = await bridge.call(checked.call.cmd, checked.call.args, { signal });
  if (!result.ok) return out(false, { ok: false, error: result.error ?? "the editor reported an error" });
  const data = typeof result.data === "object" && result.data !== null ? (result.data as Record<string, unknown>) : { value: result.data };
  if (data.needs_overwrite === true) {
    return out(false, {
      ok: false,
      error: "Not written: these cells are not empty. Pick empty cells, or ask the user and call again with overwrite:true.",
      ...data,
    });
  }
  return out(true, { ok: true, document: bridge.docName, ...data });
}

/**
 * Force-save through the server (Document Server command service), then wait for the callback's new library version.
 * "unchanged" right after an edit only means the editor has not sent it yet, so it is retried for a few seconds.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error(msg("Stopped by the user.")));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error(msg("Stopped by the user.")));
    }, { once: true });
  });
}

async function saveLive(bridge: OfficeLiveBridge, signal?: AbortSignal): Promise<ToolRunResult> {
  try {
    const before = (await getDoc(bridge.docId)).version;
    let status: "saving" | "unchanged" | "not_open" = "unchanged";
    for (let attempt = 0; attempt < 6; attempt += 1) {
      status = (await forceSaveDoc(bridge.docId)).status;
      if (status !== "unchanged") break;
      await sleep(1200, signal);
    }
    if (status === "not_open") return out(false, { ok: false, error: "The editor session is not open on the server (was the editor closed?)." });
    if (status === "unchanged") return out(true, { ok: true, saved: false, version: before, note: "No unsaved changes: the library copy is already current." });
    for (let i = 0; i < 40; i += 1) {
      await sleep(750, signal);
      const doc = await getDoc(bridge.docId);
      if (doc.version > before) return out(true, { ok: true, saved: true, version: doc.version, document: doc.name });
    }
    return out(false, { ok: false, error: "The save was requested but the new version has not arrived after 30 s; check the office page status." });
  } catch (error) {
    return out(false, { ok: false, error: errorText(error) });
  }
}
