import { activeCraft, craftPresence, type ActiveCraft } from "@/lib/craft/live";
import { addArtifact, artifactFile, artifactInfo, ARTIFACT_ID } from "./artifacts";
import { craftGuide } from "@/lib/craft/guides";
import { ApiError, errorText, saveCraftFile } from "@/tools/sidecars/client";
import type { Assessment } from "./approval-policy";
import type { TrustMode } from "./interaction";
import type { FunctionToolDef, ToolRunResult } from "./types";
import { ct } from "@/lib/i18n/client-locale";

/**
 * craft_* : the assistant reads and drives the Craft app open on this page through the app's own agent API
 * (`window.vectorcraft` / `filmcraft` / `effectcraft`: the desktop control channel as promises), relayed by the Craft
 * bridge (sidecars/craft/knife-bridge/bridge.js "agent", src/lib/craft/live.ts). Browser-side tools, offered only
 * while an app with that API is connected (and each only if the app has the function behind it); the group is preloaded
 * on /tools/artcraft. Apps draw on one canvas, so these tools replace page_snapshot / click for the app.
 */

export const CRAFT_TOOL_PREFIX = "craft_";
const RESULT_LIMIT = 14000;
const MAX_IMPORT = 50 * 1024 * 1024;

function def(name: string, description: string, properties: Record<string, unknown>, required: string[]): FunctionToolDef {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}

const PARAMS = { type: "object", description: "Parameters as the command/method documents them (omit for none).", additionalProperties: true };

export const CRAFT_TOOL_DEFS: FunctionToolDef[] = [
  def(
    "craft_guide",
    "How to work in the open Craft app: its units and coordinates, how to read the document, the commands for common jobs (create, style, animate, cut, export) with exact parameters, and its pitfalls. Read it once before your first edit in an app.",
    {},
    [],
  ),
  def(
    "craft_commands",
    "List the open Craft app's engine and menu commands (ids, titles, parameters, enabled state and why not). Pass query to filter (words matched in the id or title, e.g. \"export\", \"layer\"); pass command (an exact id) for that one command with its whole parameter documentation before you run it. Use the ids with craft_execute.",
    { query: { type: "string" }, command: { type: "string", description: "An exact command id: returns its full parameter docs." }, limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 40." } },
    [],
  ),
  def(
    "craft_inspect",
    "Read the open Craft app's state: what=ui (default) = tool, workspace, panels, selection, document; what=elements = every on-screen interactive element with id, label and rect (prefix filters the ids), for craft_request ui.click {id}.",
    { what: { type: "string", enum: ["ui", "elements"] }, prefix: { type: "string" } },
    [],
  ),
  def(
    "craft_execute",
    "Run one engine command in the open Craft app (an id from craft_commands, with its params), e.g. {command:\"file.newSequence\", params:{fromItem:48}}. Use the ids and paths the result returns in your next calls. File data the app returns (an export without a path) is saved to your file chain. The user sees the change at once and can undo it in the app (Ctrl+Z).",
    { command: { type: "string" }, params: PARAMS },
    ["command"],
  ),
  def(
    "craft_request",
    "Call a control method of the open Craft app: ui.click {id} or {x,y}, ui.key {key:\"Ctrl+Z\"}, ui.type {text}, ui.drag {from,to}, ui.scroll, ui.set {...}, ui.menu.invoke {command}, ui.menu.list, ui.elements {prefix}, ui.playback {action}, perf.stats. For engine commands prefer craft_execute.",
    { method: { type: "string" }, params: PARAMS },
    ["method"],
  ),
  def(
    "craft_screenshot",
    "Capture the open Craft app's canvas (or one panel) as a PNG file in your file chain (returns its file id, width and height). You do not see the image: use it as a file (upload_file from_file, craft_import) or tell the user it is ready; read the state with craft_inspect.",
    { panel: { type: "string", description: "A panel id from craft_inspect; omit for the whole app." } },
    [],
  ),
  def("craft_files", "List the open Craft app's own files (its virtual file table: exports, imported media) with path, size and kind.", {}, []),
  def(
    "craft_export",
    "Copy one of the Craft app's own files (a path from craft_files, e.g. an export) into your file chain, so you can upload_file it into another tool. Up to 50 MB.",
    { path: { type: "string" } },
    ["path"],
  ),
  def(
    "craft_import",
    "Import files from your file chain (ids like \"f3\" from new_files) into the open Craft app as a dropped file would (FilmCraft: project media; VectorCraft: opens the document or picture). Up to 50 MB each.",
    { files: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } } },
    ["files"],
  ),
  def(
    "craft_file_save",
    "Keep a file of your file chain (an id like \"f3\": a craft_screenshot, craft_export or an export craft_execute returned) in the user's own files (\"My files\" of the Craft apps, counted in their storage), under this app. Returns its id there: it opens in any Craft app on any device, and an agent outside the app reads it with knife_craft_file_read {id}. name defaults to the file's name; a file of this app with that name is replaced only with replace:true (asked as destructive). Up to 50 MB.",
    { file: { type: "string", description: "A file chain id, e.g. \"f3\"." }, name: { type: "string", description: "File name in the user's files (default: the chain file's name)." }, replace: { type: "boolean", description: "Replace a file of this app with the same name (default false: refused, and the existing id is named)." } },
    ["file"],
  ),
];

/** The app function each tool needs (probe reports which ones the app has). */
const NEEDS: Record<string, string> = {
  craft_guide: "inspect",
  craft_commands: "commands",
  craft_inspect: "inspect",
  craft_execute: "execute",
  craft_request: "request",
  craft_screenshot: "screenshot",
  craft_files: "files",
  craft_export: "readFile",
  craft_import: "import",
};

/** Tools that need only a connected app (they never call it): the app's id names where the file goes. */
const APP_ONLY = new Set(["craft_file_save"]);

export function isCraftTool(name: string): boolean {
  return name.startsWith(CRAFT_TOOL_PREFIX);
}

/** A craft_* tool is offered only while a Craft app with an agent API is connected and has the function behind it. */
export function craftToolAvailable(name: string): boolean {
  if (!isCraftTool(name)) return true;
  const app = activeCraft();
  if (APP_ONLY.has(name)) return app !== null;
  const need = NEEDS[name];
  return app !== null && need !== undefined && app.methods.includes(need);
}

/** For page snapshots: one line the model can act on. */
export function craftStatusNote(): string | null {
  const presence = craftPresence();
  if (!presence) return null;
  const app = `${presence.appName} ${presence.version}`;
  if (presence.state === "connected") {
    const guide = craftGuide(presence.appId);
    return `The Craft app ${app} is CONNECTED: read and drive it with the craft_* tools. ${guide ? `Before the first edit read craft_guide (how this app works, commands for common jobs). ${guide.brief}` : "Start with craft_inspect, find commands with craft_commands {query}."} The user sees every change and can undo it in the app.`;
  }
  if (presence.state === "probing") return `${app} is starting; the craft_* tools appear once its agent API answers.`;
  return `${app} has no agent API in this version: its canvas cannot be read or driven (VectorCraft, FilmCraft and EffectCraft have one). Files it saves go to the user's files.`;
}

export function craftStatus(): { app: string; version: string; state: string } | null {
  const presence = craftPresence();
  return presence ? { app: presence.appName, version: presence.version, state: presence.state } : null;
}

/* ------------------------------------------------------------------------------------------- trust */

/** Control methods that only read. */
const READ_METHODS = new Set(["ui.inspect", "ui.elements", "ui.menu.list", "engine.commands", "perf.stats", "ui.timeline.hit", "ui.timeline.locate"]);
/** Ids that lose work: asked one by one in every mode but None. */
const DESTRUCTIVE = /(delete|remove|clear|reset|revert|discard|close|quit|exit|purge|wipe|erase|overwrite)/i;

const NO: Assessment = { ask: false, destructive: false, title: "", detail: "" };

type Args = Record<string, unknown>;
const str = (args: Args, key: string): string => (typeof args[key] === "string" ? (args[key] as string).trim() : "");

export type CraftRisk = "read" | "act" | "destructive";

export function craftRisk(name: string, args: Args): CraftRisk {
  switch (name) {
    case "craft_execute": {
      const command = str(args, "command");
      return DESTRUCTIVE.test(command) ? "destructive" : "act";
    }
    case "craft_request": {
      const method = str(args, "method");
      if (READ_METHODS.has(method)) return "read";
      // ui.menu.invoke {command} runs a command too; app.quit closes the app.
      const inner = typeof (args.params as Args | undefined)?.command === "string" ? String((args.params as Args).command) : "";
      return DESTRUCTIVE.test(method) || DESTRUCTIVE.test(inner) ? "destructive" : "act";
    }
    case "craft_import":
      return "act";
    case "craft_file_save":
      // Writes the account's storage; replacing a file the person keeps loses its old contents.
      return args.replace === true ? "destructive" : "act";
    default:
      return "read";
  }
}

/** Trust-mode verdict for a craft_* call (see approval-policy.ts for the modes). */
export function assessCraftCall(name: string, args: Args, mode: TrustMode, detail: string): Assessment {
  if (mode === "free") return NO;
  const risk = craftRisk(name, args);
  if (risk === "read") return NO;
  const app = activeCraft()?.appName ?? "the Craft app";
  if (name === "craft_file_save") {
    // No such chain file: nothing would be saved, the tool itself says so (like a click on a stale id).
    const chain = ARTIFACT_ID.test(str(args, "file")) ? artifactInfo(str(args, "file")) : null;
    if (!chain) return NO;
    const label = str(args, "name") || chain.name;
    if (risk === "destructive") return { ask: true, destructive: true, title: ct("Replace {label} in your files?", { label: label.slice(0, 60) }), detail: ct("{detail} (the file of the same name saved from {app} is overwritten)", { detail, app }) };
    if (mode === "destructive") return NO;
    return { ask: true, destructive: false, title: ct("Save {label} to your files?", { label: label.slice(0, 60) }), detail: ct("{detail} ({kb} KB into your storage)", { detail, kb: Math.max(1, Math.round(chain.bytes / 1024)) }) };
  }
  const what = name === "craft_execute" ? str(args, "command") : name === "craft_request" ? str(args, "method") : "import files";
  if (risk === "destructive") return { ask: true, destructive: true, title: ct("Run {what} in {app}?", { what: what.slice(0, 60), app }), detail: ct("{detail} (it may lose work; undo with Ctrl+Z in the app if it allows)", { detail }) };
  if (mode === "destructive") return NO;
  return { ask: true, destructive: false, title: name === "craft_import" ? ct("Import files into {app}?", { app }) : ct("Run {what} in {app}?", { what: what.slice(0, 60), app }), detail };
}

/* ------------------------------------------------------------------------------------------- run */

function out(ok: boolean, body: object): ToolRunResult {
  const text = JSON.stringify(body);
  if (text.length <= RESULT_LIMIT) return { ok, content: text };
  return { ok, content: JSON.stringify({ ok, _truncated: true, preview: text.slice(0, RESULT_LIMIT - 100), hint: "Too long: narrow it (craft_commands query, craft_inspect what=elements prefix)." }) };
}

const fail = (error: string): ToolRunResult => out(false, { ok: false, error });

async function call(app: ActiveCraft, method: string, args: unknown[], signal?: AbortSignal, transfer?: Transferable[]): Promise<{ ok: true; result: unknown } | { ok: false; error: ToolRunResult }> {
  const reply = await app.call(method, args, signal, transfer);
  if (!reply.ok) return { ok: false, error: fail(`${app.appName}: ${reply.error ?? "error"}`) };
  return { ok: true, result: reply.result };
}

const params = (args: Args): Args => (args.params && typeof args.params === "object" && !Array.isArray(args.params) ? (args.params as Args) : {});

function commandList(result: unknown): unknown[] {
  return Array.isArray(result)
    ? result
    : result && typeof result === "object"
      ? (Object.values(result).find(Array.isArray) as unknown[] | undefined) ?? Object.entries(result).map(([id, value]) => ({ id, ...(value && typeof value === "object" ? value : { value }) }))
      : [];
}

/** For a mistyped id: the same command family first (`document.*` for "document.exportt"), closest prefix first. */
function similarCommands(result: unknown, wanted: string): unknown[] {
  const ids = commandList(result).filter((e): e is Args => Boolean(e) && typeof e === "object" && typeof (e as Args).id === "string");
  const family = wanted.split(".")[0];
  const common = (id: string): number => {
    let n = 0;
    while (n < id.length && n < wanted.length && id[n] === wanted[n]) n += 1;
    return n;
  };
  const last = wanted.split(".").pop()?.toLowerCase() ?? "";
  return ids
    .map((e) => ({ e, id: String(e.id), rank: common(String(e.id)) + (String(e.id).startsWith(`${family}.`) ? 100 : 0) + (last.length > 3 && String(e.id).toLowerCase().includes(last.slice(0, 4)) ? 10 : 0) }))
    .filter((m) => m.rank > 2)
    .sort((x, y) => y.rank - x.rank)
    .slice(0, 8)
    .map((m) => compactCommand(m.e, 200));
}

function filterCommands(result: unknown, query: string, limit: number): { total: number; commands: unknown[] } {
  const list = commandList(result);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = (entry: unknown, key: string): string => {
    const value = entry && typeof entry === "object" ? (entry as Record<string, unknown>)[key] : undefined;
    return Array.isArray(value) ? value.join(" > ") : typeof value === "string" ? value : "";
  };
  // id + label (+ menu path) decide a match; the parameter text only breaks ties (it mentions many words).
  const score = (entry: unknown): number => {
    const head = `${text(entry, "id")} ${text(entry, "command")} ${text(entry, "label")} ${text(entry, "menu")} ${text(entry, "path")}`.toLowerCase();
    const all = `${head} ${text(entry, "params")}`.toLowerCase();
    if (!words.every((word) => all.includes(word))) return 0;
    return 1 + words.filter((word) => head.includes(word)).length;
  };
  const matches = words.length
    ? list.map((entry) => ({ entry, rank: score(entry) })).filter((m) => m.rank > 0).sort((a, b) => b.rank - a.rank).map((m) => m.entry)
    : list;
  return { total: matches.length, commands: matches.slice(0, limit).map((entry) => compactCommand(entry)) };
}

/**
 * One line per command: the id to call, what the menu calls it, its parameters (clipped in a list; whole for one command,
 * craft_commands {command}), and whether it can run now (with the app's reason when it says one).
 */
function compactCommand(entry: unknown, paramsLimit = 300): unknown {
  if (!entry || typeof entry !== "object") return entry;
  const e = entry as Record<string, unknown>;
  const menu = Array.isArray(e.menu) ? e.menu.join(" > ") : Array.isArray(e.path) ? e.path.join(" > ") : undefined;
  const params = typeof e.params === "string" ? e.params : e.params == null ? undefined : JSON.stringify(e.params);
  return {
    id: e.id ?? e.command,
    ...(typeof e.label === "string" ? { label: e.label } : {}),
    ...(menu ? { menu } : {}),
    ...(params ? { params: params.length > paramsLimit ? `${params.slice(0, paramsLimit)}… (craft_commands {command:"${String(e.id ?? e.command)}"} for all of it)` : params } : {}),
    ...(e.enabled === false ? { enabled: false, ...(typeof e.why === "string" && e.why ? { why: e.why } : {}) } : {}),
  };
}

function base64Blob(base64: string, mime: string): Blob {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function runCraftTool(name: string, args: Args, signal?: AbortSignal): Promise<ToolRunResult> {
  const app = activeCraft();
  if (!app) {
    const note = craftStatusNote();
    return fail(`${note ?? "No Craft app is open on this page."} To use one: open_tool artcraft with tab vectorcraft, filmcraft or effectcraft and wait until page_snapshot says it is connected.`);
  }
  if (name === "craft_file_save") return saveToFiles(app, args);
  const need = NEEDS[name];
  if (!need) return fail(`Unknown tool "${name}".`);
  if (!app.methods.includes(need)) return fail(`${app.appName} ${app.version} has no ${need}(); ${name} does not work in it.`);
  const where = { app: app.appName, version: app.version };

  switch (name) {
    case "craft_commands": {
      const r = await call(app, "commands", [], signal);
      if (!r.ok) return r.error;
      const exact = str(args, "command");
      if (exact) {
        const entry = commandList(r.result).find((e) => e && typeof e === "object" && ((e as Args).id === exact || (e as Args).command === exact));
        if (!entry) {
          const near = similarCommands(r.result, exact);
          return out(false, { ok: false, ...where, error: `${app.appName} has no command "${exact}".`, ...(near.length ? { similar: near } : {}) });
        }
        return out(true, { ok: true, ...where, command: compactCommand(entry, Infinity) });
      }
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 40;
      const query = str(args, "query");
      const { total, commands } = filterCommands(r.result, query, limit);
      // Fewer entries rather than a cut-off result: the model needs whole entries.
      let shown = commands;
      const body = () => ({ ok: true, ...where, ...(query ? { query } : {}), total, shown: shown.length, commands: shown, ...(total > shown.length ? { note: "More match: narrow the query (or page with a more specific word)." } : {}) });
      while (shown.length > 1 && JSON.stringify(body()).length > RESULT_LIMIT) shown = shown.slice(0, Math.floor(shown.length * 0.8));
      return out(true, body());
    }
    case "craft_inspect": {
      const elements = str(args, "what") === "elements";
      const prefix = str(args, "prefix");
      const r = elements ? await call(app, "request", ["ui.elements", prefix ? { prefix } : {}], signal) : await call(app, "inspect", [], signal);
      if (!r.ok) return r.error;
      return out(true, { ok: true, ...where, [elements ? "elements" : "state"]: r.result });
    }
    case "craft_execute": {
      const command = str(args, "command");
      if (!command) return fail('craft_execute needs {"command": "<id from craft_commands>"}.');
      const r = await call(app, "execute", [command, params(args)], signal);
      if (!r.ok) return r.error;
      const files: unknown[] = [];
      const result = inlineFilesToArtifacts(r.result, `${app.appId}-${command.replace(/[^a-z0-9]+/gi, "-")}`, files);
      return out(true, { ok: true, ...where, command, result, ...(files.length ? { new_files: files, note: "The file data the app returned is in your file chain (ids above), not in this result." } : {}) });
    }
    case "craft_request": {
      const method = str(args, "method");
      if (!method) return fail('craft_request needs {"method": "ui.click", "params": {...}}.');
      const r = await call(app, "request", [method, params(args)], signal);
      if (!r.ok) return r.error;
      const files: unknown[] = [];
      const result = inlineFilesToArtifacts(r.result, `${app.appId}-${method.replace(/[^a-z0-9]+/gi, "-")}`, files);
      return out(true, { ok: true, ...where, method, result, ...(files.length ? { new_files: files } : {}) });
    }
    case "craft_guide": {
      const guide = craftGuide(app.appId);
      if (!guide) return out(true, { ok: true, ...where, guide: "No guide for this app yet: read the state with craft_inspect, find commands with craft_commands {query} and check each command's params with craft_commands {command}." });
      const mismatch = guide.verified !== app.version ? `This guide was checked against ${app.appName} ${guide.verified}; the open app is ${app.version}: if a command fails, confirm it with craft_commands {command}.` : undefined;
      return out(true, { ok: true, ...where, guide: guide.text, ...(mismatch ? { note: mismatch } : {}) });
    }
    case "craft_screenshot": {
      const panel = str(args, "panel");
      let r = await call(app, "screenshot", [panel ? { panel } : {}], signal);
      if (!r.ok) return r.error;
      // FilmCraft and VectorCraft answer `pngBase64`, EffectCraft `png`; VectorCraft only when asked with data:true.
      const pngOf = (value: unknown): string | null => {
        const shot = value as { pngBase64?: unknown; png?: unknown } | null;
        return typeof shot?.pngBase64 === "string" && shot.pngBase64 ? shot.pngBase64 : typeof shot?.png === "string" && shot.png ? shot.png : null;
      };
      if (!pngOf(r.result)) {
        r = await call(app, "screenshot", [{ ...(panel ? { panel } : {}), data: true }], signal);
        if (!r.ok) return r.error;
      }
      const png = pngOf(r.result);
      const shot = r.result as { width?: unknown; height?: unknown } | null;
      if (!png || !shot) return fail(`${app.appName} returned no image.`);
      const file = addArtifact(base64Blob(png, "image/png"), `${app.appId}-${panel || "screenshot"}.png`);
      return out(true, { ok: true, ...where, file, width: shot.width, height: shot.height, note: "Saved as a PNG in your file chain; you cannot see it." });
    }
    case "craft_files": {
      const r = await call(app, "files", [], signal);
      if (!r.ok) return r.error;
      return out(true, { ok: true, ...where, files: r.result });
    }
    case "craft_export": {
      const path = str(args, "path");
      if (!path) return fail('craft_export needs {"path": "<a path from craft_files>"}.');
      const r = await call(app, "readFile", [path], signal);
      if (!r.ok) return r.error;
      const bytes = (r.result as { bytes?: unknown } | null)?.bytes;
      if (!(bytes instanceof ArrayBuffer)) return fail(`${app.appName} returned no bytes for ${path}.`);
      const fileName = path.split("/").filter(Boolean).pop() || "export";
      const file = addArtifact(new Blob([bytes], { type: mimeOf(fileName) }), fileName);
      return out(true, { ok: true, ...where, path, file });
    }
    case "craft_import": {
      const ids = Array.isArray(args.files) ? args.files.filter((id): id is string => typeof id === "string").slice(0, 20) : [];
      if (!ids.length) return fail('craft_import needs {"files": ["f1", …]} (ids from new_files).');
      const files: { name: string; mime: string; bytes: ArrayBuffer }[] = [];
      for (const id of ids) {
        if (!ARTIFACT_ID.test(id)) return fail(`"${id}" is not a file id (they look like "f3").`);
        const file = artifactFile(id);
        if (!file) return fail(`File ${id} is no longer in your file chain.`);
        if (file.size > MAX_IMPORT) return fail(`${file.name} is larger than 50 MB.`);
        files.push({ name: file.name, mime: file.type, bytes: await file.arrayBuffer() });
      }
      const r = await call(app, "import", [files], signal, files.map((f) => f.bytes));
      if (!r.ok) return r.error;
      return out(true, { ok: true, ...where, imported: files.map((f) => f.name), result: r.result });
    }
  }
  return fail(`Unknown tool "${name}".`);
}

/**
 * craft_file_save: a chain file (bytes in this tab only) into the account's Craft files through the same route the
 * apps' Save uses (POST /api/craft/files, this tab's session: its quota, upload slot and save rate), so it outlives the
 * tab and an agent outside the app can read it (knife_craft_file_read). Never replaces unless asked (replace:true).
 */
async function saveToFiles(app: ActiveCraft, args: Args): Promise<ToolRunResult> {
  const id = str(args, "file");
  if (!ARTIFACT_ID.test(id)) return fail(`craft_file_save needs {"file": "f3"} (an id from new_files or a craft_* result)${id ? `; "${id.slice(0, 40)}" is not one` : ""}.`);
  const file = artifactFile(id, str(args, "name").slice(0, 160) || undefined);
  if (!file) return fail(`File ${id} is no longer in the file chain (it keeps the 16 newest files of this tab).`);
  if (file.size > MAX_IMPORT) return fail(`${file.name} is larger than 50 MB; it cannot be kept in your files.`);
  if (file.size === 0) return fail(`${file.name} is empty.`);
  const replace = args.replace === true;
  try {
    const saved = (await saveCraftFile(app.appId, file.name, file.type || "application/octet-stream", await file.arrayBuffer(), { replace })).file;
    return out(true, {
      ok: true,
      app: app.appName,
      saved: { id: saved.id, name: saved.name, app: saved.app, mime: saved.mime, size: saved.size, updatedAt: saved.updatedAt },
      from: id,
      note: `In the user's files ("My files" in every Craft app). An agent outside the app reads it with knife_craft_file_read {"id":"${saved.id}"}.`,
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === "file_exists") {
      return out(false, { ok: false, error: error.message, hint: "Pass another name, or replace:true to overwrite it (the user is asked)." });
    }
    return fail(`Could not save ${file.name} to your files: ${errorText(error)}`);
  }
}

/** Keys under which the apps return a file's bytes inline (VectorCraft document.export without a path, clipboard.exportPng, …). */
const INLINE_DATA_KEYS = new Set(["dataBase64", "pngBase64", "png", "base64"]);
const INLINE_MIN_CHARS = 512;

/**
 * Replaces file data an app returned inline (base64 under dataBase64 / pngBase64 / png) with a file in the chain, so a
 * 2 MB export never lands in the model's context: `{dataBase64, format: "png"}` becomes `{file: {id: "f3", …}, format}`.
 * Walks objects and arrays (VectorCraft's multi-artboard exports return `files: [{name, dataBase64}]`).
 */
function inlineFilesToArtifacts(value: unknown, stem: string, files: unknown[], depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => inlineFilesToArtifacts(item, stem, files, depth + 1));
  const obj = value as Record<string, unknown>;
  const outObj: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(obj)) {
    if (INLINE_DATA_KEYS.has(key) && typeof item === "string" && item.length >= INLINE_MIN_CHARS && /^[A-Za-z0-9+/=\r\n]+$/.test(item.slice(0, 2048))) {
      const ext = typeof obj.format === "string" ? obj.format.toLowerCase().replace(/^png8$/, "png") : key === "png" || key === "pngBase64" ? "png" : "";
      const given = typeof obj.name === "string" ? obj.name.split("/").pop() : "";
      const fileName = given || `${stem}${ext ? `.${ext}` : ""}`;
      try {
        const file = addArtifact(base64Blob(item.replace(/\s+/g, ""), mimeOf(fileName)), fileName);
        files.push(file);
        outObj.file = file;
      } catch {
        outObj[key] = `<${item.length} characters of base64 that could not be decoded>`;
      }
      continue;
    }
    outObj[key] = inlineFilesToArtifacts(item, stem, files, depth + 1);
  }
  return outObj;
}

const MIMES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm", wav: "audio/wav", mp3: "audio/mpeg", gif: "image/gif", webp: "image/webp" };

function mimeOf(name: string): string {
  return MIMES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}
