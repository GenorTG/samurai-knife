/**
 * DOM bridge: lets the agent read and operate whatever tool page is mounted,
 * with no per-tool wiring. Controls get stable ids (`c12`) and output regions
 * get ids (`r3`) via a data attribute; the agent refers to them by id.
 *
 * Hard rules: never touch the widget itself, password or hidden inputs, or
 * cross-origin links. File inputs are only fed through attachFile (agent-made
 * content, never the user's disk).
 */

import { artifactFile, drainNewArtifacts, listArtifacts, type ArtifactInfo } from "./artifacts";
import { highlight, settleOutputs } from "./feedback";
import { BUSY_TEXT, WaitEvaluator, type WaitCondition } from "./wait-condition";
import { liveStatus, liveStatusNote } from "./office-live-tools";

export const WIDGET_ATTR = "data-agent-widget";
const ID_ATTR = "data-agent-id";

const VALUE_PREVIEW = 200;
const REGION_PREVIEW = 600;
const READ_LIMIT = 6000;
const MAX_CONTROLS = 90;
const MAX_LINKS = 25;
const MAX_REGIONS = 30;
const MAX_SNAPSHOT_CHARS = 9000;
const MAX_OPTIONS = 30;

let idCounter = 0;

export type BridgeResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

const STALE = "Element id not found on the page (the page changed). Call page_snapshot again and use a fresh id.";

/* ------------------------------------------------------------- primitives */

function inWidget(el: Element): boolean {
  return el.closest(`[${WIDGET_ATTR}]`) !== null;
}

function isVisible(el: Element): boolean {
  if (typeof el.checkVisibility === "function") {
    return el.checkVisibility({ visibilityProperty: true });
  }
  return el instanceof HTMLElement ? el.offsetParent !== null || el === document.body : true;
}

function rootElement(): Element {
  return document.querySelector("main") ?? document.body;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function assignId(el: Element, prefix: "c" | "r"): string {
  const existing = el.getAttribute(ID_ATTR);
  if (existing) return existing;
  idCounter += 1;
  const id = `${prefix}${idCounter}`;
  el.setAttribute(ID_ATTR, id);
  return id;
}

const CONTROL_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "summary",
  "a[href]",
  '[role="button"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="menuitem"]',
].join(",");

const REGION_SELECTOR = [
  "section",
  "pre",
  "output",
  "table",
  "dl",
  '[role="status"]',
  '[role="alert"]',
  "[aria-live]",
  `[data-agent-region]`,
].join(",");

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SELECT", "TEXTAREA", "INPUT", "OPTION"]);
const BLOCK_TAGS = new Set([
  "P", "DIV", "LI", "UL", "OL", "TR", "H1", "H2", "H3", "H4", "H5", "H6", "DT", "DD", "SECTION", "HEADER", "FOOTER", "PRE", "TABLE", "BR", "DL", "FIGURE",
]);

function isControlElement(el: Element): boolean {
  return el.matches(CONTROL_SELECTOR);
}

function isSensitiveInput(el: Element): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  return el.type === "password" || el.type === "hidden";
}

/** Visible text of a subtree, skipping controls/media; nested regions become [rN]. */
function textOf(
  el: Element,
  options: { regions?: Map<Element, string>; expandNested?: boolean },
): string {
  const lines: string[] = [];
  let line = "";
  const flush = () => {
    const cleaned = line.replace(/[ \t ]+/g, " ").trim();
    if (cleaned) lines.push(cleaned);
    line = "";
  };
  const walk = (node: Node, isRoot: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      line += node.textContent ?? "";
      return;
    }
    if (!(node instanceof Element)) return;
    if (!isRoot) {
      if (inWidget(node) || SKIP_TAGS.has(node.tagName)) return;
      if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return;
      if (isControlElement(node)) return;
      const regionId = options.regions?.get(node);
      if (regionId && !options.expandNested) {
        line += ` [${regionId}] `;
        return;
      }
      if (node instanceof HTMLElement && !isVisible(node)) return;
      if (node instanceof HTMLImageElement) {
        line += ` [image${node.alt ? `: ${node.alt}` : ""}] `;
        return;
      }
      if (node instanceof HTMLCanvasElement) {
        line += ` [canvas ${node.width}x${node.height}] `;
        return;
      }
      if (node instanceof HTMLIFrameElement) {
        // Cross-origin (the office editor): its document is not readable from here, and walking it must not throw.
        line += ` [embedded frame${node.title ? `: ${node.title}` : ""}] `;
        return;
      }
      if (node instanceof SVGElement) {
        if (node.tagName.toLowerCase() === "svg") line += " [graphic] ";
        return;
      }
    }
    if (node.tagName === "PRE" || node.tagName === "OUTPUT") {
      flush();
      for (const part of (node.textContent ?? "").split("\n")) {
        line += part;
        flush();
      }
      return;
    }
    const block = BLOCK_TAGS.has(node.tagName);
    if (block) flush();
    for (const child of Array.from(node.childNodes)) walk(child, false);
    if (block) flush();
    if (node.tagName === "TD" || node.tagName === "TH") line += " | ";
  };
  walk(el, true);
  flush();
  return lines.join("\n");
}

function labelText(el: Element): string {
  const ownLabel = (target: Element): string => squash(textOf(target, {}));

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((n): n is HTMLElement => n !== null)
      .map(ownLabel)
      .filter(Boolean);
    if (parts.length) return parts.join(" ");
  }
  const aria = el.getAttribute("aria-label");
  if (aria) return squash(aria);

  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    const labels = el.labels ? Array.from(el.labels) : [];
    const text = labels.map(ownLabel).filter(Boolean).join(" ");
    if (text) return text;
  }
  if (el instanceof HTMLInputElement && (el.type === "button" || el.type === "submit" || el.type === "reset") && el.value) {
    return el.value;
  }
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLSelectElement)) {
    const text = ownLabel(el);
    if (text) return text;
  }
  const fallback =
    ("placeholder" in el && typeof el.placeholder === "string" ? el.placeholder : "") ||
    el.getAttribute("title") ||
    el.getAttribute("name") ||
    "";
  return squash(fallback) || "(unlabeled)";
}

function sectionTitle(el: Element, cache: Map<Element, string>): string | undefined {
  const section = el.closest("section");
  if (!section) return undefined;
  let title = cache.get(section);
  if (title === undefined) {
    title = squash(section.querySelector("h1, h2, h3")?.textContent ?? "");
    cache.set(section, title);
  }
  return title || undefined;
}

/* --------------------------------------------------------------- snapshot */

export interface ControlInfo {
  id: string;
  kind: string;
  label: string;
  in?: string;
  type?: string;
  value?: string;
  len?: number;
  checked?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  required?: boolean;
  options?: string[];
  optionCount?: number;
  group?: string;
  href?: string;
  min?: string;
  max?: string;
  unsupported?: string;
  hint?: string;
}

function describeControl(el: Element, titles: Map<Element, string>): ControlInfo | null {
  if (inWidget(el) || isSensitiveInput(el)) return null;
  const isFile = el instanceof HTMLInputElement && el.type === "file";
  if (!isFile && !isVisible(el)) return null;
  if (el instanceof HTMLElement && el.hidden && !isFile) return null;

  const info: ControlInfo = { id: assignId(el, "c"), kind: "", label: clip(labelText(el), 80) };
  const sec = sectionTitle(el, titles);
  if (sec) info.in = clip(sec, 40);

  if (el instanceof HTMLInputElement) {
    info.type = el.type;
    if (el.type === "checkbox" || el.type === "radio") {
      info.kind = el.type;
      info.checked = el.checked;
      if (el.type === "radio") {
        if (el.name) info.group = el.name;
        if (el.value) info.value = clip(el.value, 60);
      }
    } else if (el.type === "file") {
      info.kind = "file";
      info.hint = el.multiple
        ? "file input (multiple): attach ALL files in one upload_file call {id, files:[{name, text|base64}]}"
        : "file input: attach with upload_file {id, name, text|base64}";
    } else if (el.type === "button" || el.type === "submit" || el.type === "reset") {
      info.kind = "button";
    } else {
      info.kind = "input";
      setValueFields(info, el.value);
      if (el.min) info.min = el.min;
      if (el.max) info.max = el.max;
    }
    if (el.readOnly) info.readonly = true;
    if (el.required) info.required = true;
  } else if (el instanceof HTMLTextAreaElement) {
    info.kind = "textarea";
    setValueFields(info, el.value);
    if (el.readOnly) info.readonly = true;
  } else if (el instanceof HTMLSelectElement) {
    info.kind = "select";
    setValueFields(info, el.value);
    const opts = Array.from(el.options);
    info.options = opts.slice(0, MAX_OPTIONS).map((o) => {
      const text = squash(o.text);
      return o.value === text || !o.value ? text : `${o.value} (${text})`;
    });
    if (opts.length > MAX_OPTIONS) info.optionCount = opts.length;
    const selected = el.selectedOptions[0];
    if (selected && squash(selected.text) !== el.value) info.value = `${el.value} (${squash(selected.text)})`;
  } else if (el instanceof HTMLAnchorElement) {
    info.kind = "link";
    info.href = el.pathname + el.search + el.hash;
    if (el.origin !== window.location.origin) info.unsupported = "external link; not clickable by the agent";
  } else if (el instanceof HTMLButtonElement || el.tagName === "SUMMARY") {
    info.kind = el.tagName === "SUMMARY" ? "summary" : "button";
    const expanded = el.getAttribute("aria-expanded");
    if (expanded !== null) info.checked = expanded === "true";
  } else {
    const role = el.getAttribute("role") ?? "button";
    info.kind = role;
    const state = el.getAttribute("aria-checked") ?? el.getAttribute("aria-selected") ?? el.getAttribute("aria-pressed");
    if (state !== null) info.checked = state === "true";
  }
  if (isDisabled(el)) info.disabled = true;
  return info;
}

function setValueFields(info: ControlInfo, value: string): void {
  info.value = clip(value, VALUE_PREVIEW);
  if (value.length > VALUE_PREVIEW) info.len = value.length;
}

function isDisabled(el: Element): boolean {
  if (el.getAttribute("aria-disabled") === "true") return true;
  return "disabled" in el && (el as HTMLButtonElement).disabled === true;
}

export interface SnapshotRegion {
  id: string;
  kind: string;
  title?: string;
  text: string;
  chars?: number;
}

export interface PageSnapshot {
  url: string;
  title: string;
  heading: string;
  controls: ControlInfo[];
  regions: SnapshotRegion[];
  pageText: string;
  /** Files tools produced this session (ids usable with upload_file {from_file} / read_text). */
  files?: ArtifactInfo[];
  /** The office document open in the editor on this page and whether the assistant's live-editing plugin is connected. */
  liveDocument?: { document: string; state: string; editor?: string; read_only?: boolean; reason?: string };
  notes: string[];
}

function collectRegions(root: Element): { el: Element; id: string }[] {
  const found: { el: Element; id: string }[] = [];
  for (const el of Array.from(root.querySelectorAll(REGION_SELECTOR))) {
    if (inWidget(el) || !isVisible(el)) continue;
    if (found.length >= MAX_REGIONS) break;
    found.push({ el, id: assignId(el, "r") });
  }
  return found;
}

export function snapshotPage(): PageSnapshot {
  const root = rootElement();
  const notes: string[] = [];
  const titles = new Map<Element, string>();

  const buttons: ControlInfo[] = [];
  const links: ControlInfo[] = [];
  let droppedControls = 0;
  let droppedLinks = 0;
  for (const el of Array.from(root.querySelectorAll(CONTROL_SELECTOR))) {
    const info = describeControl(el, titles);
    if (!info) continue;
    if (info.kind === "link") {
      if (links.length < MAX_LINKS) links.push(info);
      else droppedLinks += 1;
    } else if (buttons.length < MAX_CONTROLS) buttons.push(info);
    else droppedControls += 1;
  }
  if (droppedControls) notes.push(`${droppedControls} more controls omitted (limit ${MAX_CONTROLS}).`);
  if (droppedLinks) notes.push(`${droppedLinks} more links omitted; use list_tools / open_tool to navigate.`);

  const regionEls = collectRegions(root);
  const regionMap = new Map(regionEls.map((r) => [r.el, r.id] as const));
  let regions: SnapshotRegion[] = [];
  for (const { el, id } of regionEls) {
    const text = textOf(el, { regions: regionMap });
    const title = squash(el.querySelector("h1, h2, h3")?.textContent ?? "");
    if (!text && !title) continue;
    const region: SnapshotRegion = { id, kind: el.tagName.toLowerCase(), text };
    if (title) region.title = clip(title, 60);
    regions.push(region);
  }

  const pageText = textOf(root, { regions: regionMap });
  const heading = squash(root.querySelector("h1")?.textContent ?? "");
  const out: PageSnapshot = {
    url: window.location.pathname + window.location.search,
    title: document.title,
    heading,
    controls: [...buttons, ...links],
    regions: [],
    pageText: clip(pageText, 700),
    notes,
  };
  const produced = listArtifacts();
  if (produced.length) out.files = produced;

  // Shrink region previews until the whole snapshot fits the budget.
  for (const preview of [REGION_PREVIEW, 300, 140, 60]) {
    regions = regions.map((r) => {
      const full = r.chars ?? r.text.length;
      const text = clip(r.text, preview);
      const next: SnapshotRegion = { ...r, text };
      if (full > text.length) next.chars = full;
      return next;
    });
    out.regions = regions;
    if (JSON.stringify(out).length <= MAX_SNAPSHOT_CHARS) break;
  }
  if (regionEls.length >= MAX_REGIONS) notes.push(`Region list capped at ${MAX_REGIONS}.`);
  if (root === document.body) notes.push("No <main> element; snapshot covers the whole body.");
  const frames = Array.from(root.querySelectorAll("iframe")).filter((f) => !inWidget(f));
  const live = liveStatusNote();
  if (live) {
    out.liveDocument = liveStatus() ?? undefined;
    notes.push(`The office editor is an embedded frame (not clickable or fillable). ${live}`);
  } else if (frames.length) {
    notes.push(`${frames.length} embedded frame(s): their content is not part of this snapshot and cannot be clicked or filled; for saved office documents use the knife_doc_* tools.`);
  }
  return out;
}

/* ------------------------------------------------------- settle + delta */

/**
 * After the agent changes something, wait until the page has gone quiet (debounced outputs,
 * workers, lazy panels) so the same tool result can carry what changed.
 */
export async function settlePage(signal?: AbortSignal, minMs = 300, quietMs = 150, maxMs = 1500): Promise<void> {
  const root = rootElement();
  let last = Date.now();
  const observer = new MutationObserver(() => {
    last = Date.now();
  });
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  const start = Date.now();
  try {
    while (!signal?.aborted) {
      const now = Date.now();
      if (now - start >= maxMs || (now - start >= minMs && now - last >= quietMs)) return;
      await sleep(50, signal);
    }
  } finally {
    observer.disconnect();
  }
}

export interface SnapshotDelta {
  controls?: ControlInfo[];
  regions?: SnapshotRegion[];
}

/** Controls and regions of `after` that differ from `before` (the touched control itself is skipped). */
export function diffSnapshots(before: PageSnapshot, after: PageSnapshot, skipId?: string): SnapshotDelta {
  const was = new Map(before.controls.map((c) => [c.id, JSON.stringify(c)] as const));
  const controls = after.controls.filter((c) => c.id !== skipId && was.get(c.id) !== JSON.stringify(c));
  const wasRegion = new Map(before.regions.map((r) => [r.id, `${r.chars ?? r.text.length}|${r.text}`] as const));
  const regions = after.regions.filter((r) => wasRegion.get(r.id) !== `${r.chars ?? r.text.length}|${r.text}`);
  return { ...(controls.length ? { controls } : {}), ...(regions.length ? { regions } : {}) };
}

/* -------------------------------------------------------------- id lookup */

/** Human label of a snapshot control id, for live step lines. */
export function controlLabel(id: string): string | null {
  if (!/^[cr]\d+$/.test(id)) return null;
  const el = document.querySelector(`[${ID_ATTR}="${id}"]`);
  if (!el || inWidget(el)) return null;
  const label = clip(labelText(el), 40);
  return label || null;
}


function findById(id: string): Element | null {
  if (!/^[cr]\d+$/.test(id)) return null;
  const el = document.querySelector(`[${ID_ATTR}="${id}"]`);
  if (!el || !el.isConnected || inWidget(el)) return null;
  return el;
}

/** Live element for a snapshot id (page controls only, never the widget). */
export function controlElement(id: string): Element | null {
  return findById(id);
}

/** Words that make a button destructive: it discards, empties or reloads what the user has. */
const DESTRUCTIVE_LABEL =
  /\b(delete|remove|clear|reset|discard|erase|wipe|purge|trash|drop|revert|overwrite|start over|empty|reload|refresh|replace all)\b/i;

/**
 * Buttons that swap the user's content for other content; only a problem when the page holds the user's own input.
 * Canned content ("Load sample", "Restore defaults") and the tool's own output fed back ("Use output as input",
 * "Apply to subject", "Use in pattern", "Use as current schema").
 */
const OVERWRITE_LABEL = /\b(sample|example|restore|defaults?|undo|load)\b|\b(use|apply)\b[^.]*\b(as|to|in)\b/i;

export type ActionKind = "tab" | "toggle" | "link" | "button";

export interface ActionTarget {
  label: string;
  kind: ActionKind;
  destructive: boolean;
  /** Tab that is already selected (clicking it changes nothing). */
  active: boolean;
  /** Replaces what the user typed with canned content ("Load sample", "Restore defaults"…). */
  overwrites: boolean;
  /** A same-tab link to another page or suite tab of this app: the tool unmounts and its input is lost. */
  navigates: boolean;
}

/** True for a plain in-app link that changes pathname or query (hash-only, new-tab and external links keep the page). */
function linkLeavesPage(el: Element): boolean {
  if (!(el instanceof HTMLAnchorElement) || el.target === "_blank" || el.hasAttribute("download")) return false;
  let url: URL;
  try {
    url = new URL(el.href, window.location.href);
  } catch {
    return false;
  }
  if (url.origin !== window.location.origin) return false;
  return url.pathname !== window.location.pathname || url.search !== window.location.search;
}

/**
 * What a click would do, from the control alone. Tabs, checkboxes/radios/switches and
 * summaries only change the view ("light"); buttons run something. Destructive when the
 * visible label says it throws work away.
 */
export function describeActionTarget(id: string): ActionTarget | null {
  const el = findById(id);
  if (!el) return null;
  const label = clip(labelText(el), 60);
  const role = el.getAttribute("role");
  const isToggle =
    (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) ||
    el.tagName === "SUMMARY" ||
    role === "switch" ||
    role === "checkbox" ||
    role === "radio";
  const kind: ActionKind = role === "tab" ? "tab" : isToggle ? "toggle" : el instanceof HTMLAnchorElement ? "link" : "button";
  // The visible label is not the only tell: icon-only buttons carry a title, and a reset
  // button discards form input whatever it says. Links count too (a "Delete" anchor).
  const title = el.getAttribute("title") ?? "";
  const resets = el instanceof HTMLButtonElement || el instanceof HTMLInputElement ? el.type === "reset" : false;
  const destructive = kind !== "tab" && kind !== "toggle" && (resets || DESTRUCTIVE_LABEL.test(label) || DESTRUCTIVE_LABEL.test(title));
  const overwrites = kind === "button" && (OVERWRITE_LABEL.test(label) || OVERWRITE_LABEL.test(title));
  return { label, kind, destructive, active: el.getAttribute("aria-selected") === "true", overwrites, navigates: linkLeavesPage(el) };
}

/**
 * What the USER put in a field. Only trusted events count (real typing, pasting, choosing a file):
 * a page's own default/sample text and everything the assistant writes arrive without one, so
 * discarding them needs no confirmation. The value recorded at the user's last input is compared
 * with the current one, so text the assistant or the page replaced afterwards is no longer "theirs".
 */
const userValues = new WeakMap<Element, string>();
const userFileLists = new WeakMap<Element, FileList>();
/**
 * File inputs the user chose a file in. The list alone cannot tell: Dropzone empties `files` right after reading them (the file
 * then lives in the tool's state), so the user's pick is remembered here until the assistant replaces it.
 */
const userPickedFile = new WeakSet<Element>();

function trackUserInput(event: Event): void {
  if (!event.isTrusted) return;
  const el = event.target;
  if (el instanceof HTMLInputElement && el.type === "file") {
    if (el.files) userFileLists.set(el, el.files);
    if (el.files && el.files.length > 0) userPickedFile.add(el);
    else userPickedFile.delete(el);
  } else if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    userValues.set(el, el.value);
  }
}
if (typeof document !== "undefined") {
  document.addEventListener("input", trackUserInput, true);
  document.addEventListener("change", trackUserInput, true);
}

function holdsUserText(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  return !isBlank(el.value) && userValues.get(el) === el.value;
}

/** True when filling this field would wipe what the user put in it (empty replacement over real, user-authored content). */
export function fieldWouldBeCleared(id: string, newValue: string): boolean {
  const el = findById(id);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
  return isBlank(newValue) && holdsUserText(el);
}

/** True when filling this textarea would replace the user's own text with something different. */
export function fieldWouldBeOverwritten(id: string, newValue: string): boolean {
  const el = findById(id);
  if (!(el instanceof HTMLTextAreaElement) || el.readOnly) return false;
  return el.value !== newValue && holdsUserText(el);
}

/**
 * True when this file input still holds the file(s) the USER chose (the list itself is still theirs).
 * This is what "leaving the page loses my work" means: a Dropzone empties the list after reading it and the tool keeps
 * the file in state, and chains such as scan -> OCR -> compress leave that page on purpose once the result is downloaded,
 * so those picks do not block leaving (tests/agent_ocr_chain_real_e2e.py asserts no prompt there).
 */
function holdsListedUserFiles(el: Element): boolean {
  return el instanceof HTMLInputElement && el.type === "file" && !!el.files && el.files.length > 0 && userFileLists.get(el) === el.files;
}

/**
 * True when attaching a file here would replace one the user chose: either the list still holds their pick, or they picked a
 * file in this input and the assistant has not replaced it since (covers Dropzones, which empty the list). Used by the
 * `upload_file` approval check only.
 */
export function fileInputHoldsUserFiles(id: string): boolean {
  const el = findById(id);
  return !!el && (holdsListedUserFiles(el) || (el instanceof HTMLInputElement && el.type === "file" && userPickedFile.has(el)));
}

/** Empty once whitespace and invisible characters (zero-width space/joiners, BOM, word joiner) are ignored. */
const INVISIBLE = /[\s\u200B-\u200D\u2060\uFEFF]/g;
function isBlank(text: string): boolean {
  return text.replace(INVISIBLE, "") === "";
}

/**
 * Has the user put work on this page that leaving it would lose? Only fields people
 * actually type or drop into count (textareas, chosen files); defaults of small inputs do not.
 */
export function pageHasUserWork(): boolean {
  const root = rootElement();
  for (const el of Array.from(root.querySelectorAll("textarea, input[type=file]"))) {
    if (inWidget(el)) continue;
    if (el instanceof HTMLTextAreaElement && !el.readOnly && holdsUserText(el)) return true;
    if (holdsListedUserFiles(el)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ write */

function nativeSet(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function fire(el: Element, types: string[]): void {
  for (const type of types) el.dispatchEvent(new Event(type, { bubbles: true }));
}

function parseBool(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (["true", "1", "yes", "on", "checked"].includes(v)) return true;
  if (["false", "0", "no", "off", "unchecked"].includes(v)) return false;
  return null;
}

function checkUsable(id: string): { el: Element } | { error: string } {
  const el = findById(id);
  if (!el) return { error: STALE };
  if (!isVisible(el) && !(el instanceof HTMLInputElement && el.type === "file")) {
    return { error: `Element ${id} is not visible any more. Call page_snapshot again.` };
  }
  return { el };
}

export function fillField(id: string, value: string): BridgeResult<{ id: string; value: string; note?: string }> {
  const found = checkUsable(id);
  if ("error" in found) return fail(found.error);
  const el = found.el;
  if (isSensitiveInput(el)) return fail("Password and hidden fields are off limits.");

  if (el instanceof HTMLInputElement && el.type === "file") {
    return fail("File inputs are unsupported: ask the user to choose the file themselves.");
  }
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    if (el.disabled) return fail(`Control ${id} is disabled.`);
    const want = parseBool(value);
    if (want === null) return fail('For checkboxes and radios pass value "true" or "false".');
    if (el.type === "radio" && !want) return fail("A radio button cannot be unselected; select another option in its group instead.");
    highlight(el, "fill");
    if (el.checked !== want) el.click();
    settleOutputs();
    return { ok: true, id, value: String(el.checked) };
  }
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    if (el.disabled) return fail(`Control ${id} is disabled.`);
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.readOnly) {
      return fail(`Control ${id} is read-only.`);
    }
    if (el instanceof HTMLInputElement && ["button", "submit", "reset", "image"].includes(el.type)) {
      return fail("That is a button; use click.");
    }
    highlight(el, "fill");
    if (el instanceof HTMLSelectElement) {
      const wanted = value.trim();
      const match =
        Array.from(el.options).find((o) => o.value === value) ??
        // snapshots print a differing selection as "value (label)"; accept that form back
        Array.from(el.options).find((o) => `${o.value} (${squash(o.text)})` === wanted) ??
        Array.from(el.options).find((o) => squash(o.text) === wanted) ??
        Array.from(el.options).find((o) => squash(o.text).toLowerCase() === wanted.toLowerCase());
      if (!match) {
        const options = Array.from(el.options).slice(0, MAX_OPTIONS).map((o) => o.value || squash(o.text));
        return fail(`No option "${clip(value, 60)}" in ${id}. Options: ${options.join(", ")}`);
      }
      nativeSet(el, match.value);
      fire(el, ["input", "change"]);
      settleOutputs();
      return { ok: true, id, value: el.value };
    }
    nativeSet(el, value);
    fire(el, ["input", "change"]);
    settleOutputs();
    const after = el.value;
    const result: { ok: true; id: string; value: string; note?: string } = { ok: true, id, value: clip(after, VALUE_PREVIEW) };
    if (after !== value) result.note = "The field holds a different value than requested (the control or the page normalised it).";
    return result;
  }
  return fail(`Control ${id} (${el.tagName.toLowerCase()}) is not a form field; use click.`);
}

const MAX_UPLOAD_BYTES = 1024 * 1024;

export interface AgentFile {
  name: string;
  text?: string;
  base64?: string;
  mime?: string;
  /** Id (f1…) of a file a tool produced earlier; the bytes never pass through the model. */
  fromFile?: string;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  avif: "image/avif",
  bmp: "image/bmp",
  csv: "text/csv",
  gif: "image/gif",
  gz: "application/gzip",
  htm: "text/html",
  html: "text/html",
  ico: "image/vnd.microsoft.icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  markdown: "text/markdown",
  md: "text/markdown",
  mjs: "text/javascript",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  webp: "image/webp",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  zip: "application/zip",
};

function mimeTypeFor(file: AgentFile): string {
  const explicit = file.mime?.trim();
  if (explicit) return explicit;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function decodeAgentFile(file: AgentFile): { file: File } | { error: string } {
  if (file.fromFile) {
    const produced = artifactFile(file.fromFile, file.name);
    return produced ? { file: produced } : { error: `No produced file ${file.fromFile}; list them with page_snapshot (files).` };
  }
  let bytes: Uint8Array<ArrayBuffer>;
  if (typeof file.base64 === "string") {
    try {
      bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
    } catch {
      return { error: `base64 is not valid${fileLabel(file)}.` };
    }
  } else if (typeof file.text === "string") {
    bytes = new TextEncoder().encode(file.text);
  } else {
    return { error: `Pass either text (UTF-8 content) or base64${fileLabel(file)}.` };
  }
  if (bytes.length > MAX_UPLOAD_BYTES) return { error: `File is larger than 1 MiB${fileLabel(file)}.` };
  const name = file.name.replace(/[\\/]/g, "_").slice(0, 120) || "file";
  return { file: new File([bytes], name, { type: mimeTypeFor(file) }) };
}

function fileLabel(file: AgentFile): string {
  return file.name ? ` (${file.name})` : "";
}

/** Several files in one call only work on inputs with the `multiple` attribute; each call replaces the previous selection. */
export function attachFile(id: string, input: AgentFile | AgentFile[]): BridgeResult<{ id: string; name: string; bytes: number; files?: { name: string; bytes: number }[] }> {
  const found = checkUsable(id);
  if ("error" in found) return fail(found.error);
  const el = found.el;
  if (inWidget(el) || !(el instanceof HTMLInputElement) || el.type !== "file") {
    return fail(`Control ${id} is not a file input.`);
  }
  if (el.disabled) return fail(`Control ${id} is disabled.`);
  const list = Array.isArray(input) ? input : [input];
  if (list.length === 0) return fail("Pass at least one file.");
  if (list.length > 1 && !el.multiple) return fail(`Control ${id} accepts one file at a time; attach a single file.`);
  const transfer = new DataTransfer();
  const attached: { name: string; bytes: number }[] = [];
  for (const item of list) {
    const decoded = decodeAgentFile(item);
    if ("error" in decoded) return fail(decoded.error);
    transfer.items.add(decoded.file);
    attached.push({ name: decoded.file.name, bytes: decoded.file.size });
  }
  highlight(el, "upload");
  // From here on the file is the assistant's: a later attach needs no confirmation (the approval, if any, covered this one).
  userPickedFile.delete(el);
  userFileLists.delete(el);
  el.files = transfer.files;
  fire(el, ["input", "change"]);
  settleOutputs();
  return { ok: true, id, name: attached[0].name, bytes: attached[0].bytes, ...(attached.length > 1 ? { files: attached } : {}) };
}

export async function clickElement(id: string): Promise<BridgeResult<{ id: string; label: string; navigatedTo?: string; new_files?: ArtifactInfo[] }>> {
  const found = checkUsable(id);
  if ("error" in found) return fail(found.error);
  const el = found.el;
  if (isSensitiveInput(el)) return fail("Password and hidden fields are off limits.");
  if (el instanceof HTMLInputElement && el.type === "file") {
    return fail("File inputs are unsupported: ask the user to choose the file themselves.");
  }
  if (isDisabled(el)) return fail(`Control ${id} is disabled.`);
  if (el instanceof HTMLAnchorElement) {
    if (el.origin !== window.location.origin) return fail("External links are not clickable by the agent.");
    if (el.target === "_blank") return fail("That link opens a new tab; use open_tool or ask the user.");
  }
  const label = clip(labelText(el), 60);
  const before = window.location.pathname + window.location.search;
  highlight(el, "click");
  if (el instanceof HTMLElement) el.click();
  else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  settleOutputs();
  await sleep(160);
  const after = window.location.pathname + window.location.search;
  const result: { ok: true; id: string; label: string; navigatedTo?: string; new_files?: ArtifactInfo[] } = { ok: true, id, label };
  if (after !== before) result.navigatedTo = after;
  const produced = drainNewArtifacts();
  if (produced.length) result.new_files = produced;
  return result;
}

/** Full text of a control's value or a region's content (no highlight, no truncation). */
function elementText(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value;
  if (el.tagName === "PRE" || el.tagName === "OUTPUT") return el.textContent ?? "";
  if (isControlElement(el)) return labelText(el);
  return textOf(el, { expandNested: true });
}

export function readText(id: string): BridgeResult<{ id: string; text: string; chars: number }> {
  const el = findById(id);
  if (!el) return fail(STALE);
  if (el instanceof HTMLInputElement && (el.type === "password" || el.type === "hidden")) {
    return fail("Password and hidden fields are off limits.");
  }
  const text = elementText(el);
  highlight(el, "read");
  const chars = text.length;
  return { ok: true, id, text: chars > READ_LIMIT ? `${text.slice(0, READ_LIMIT)}\n…[truncated, ${chars} chars total]` : text, chars };
}

/* ----------------------------------------------------------- async helpers */

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** React stamps `__reactProps$…` on every DOM node it owns once hydrated. */
export function isHydrated(): boolean {
  const root = rootElement();
  const nodes = [root, ...Array.from(root.querySelectorAll("*")).slice(0, 300)];
  return nodes.some((node) => Object.keys(node).some((key) => key.startsWith("__reactProps$")));
}

/** Lazy tool/tab chunks render a "Loading tool…" status line until they arrive. */
function toolStillLoading(): boolean {
  return Array.from(document.querySelectorAll("main [role=status]")).some((el) =>
    (el.textContent ?? "").includes("Loading tool"),
  );
}

export async function waitForToolPanel(timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (toolStillLoading() && Date.now() < deadline && !signal?.aborted) await sleep(60, signal);
}

export async function waitForPage(
  pathname: string,
  timeoutMs: number,
  signal?: AbortSignal,
  tab?: string,
): Promise<{ arrived: boolean; hydrated: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let arrived = false;
  while (Date.now() < deadline && !signal?.aborted) {
    if (
      window.location.pathname === pathname &&
      (!tab || new URLSearchParams(window.location.search).get("tab") === tab) &&
      document.querySelector("main h1")
    ) {
      arrived = true;
      if (isHydrated()) {
        await waitForToolPanel(Math.max(0, deadline - Date.now()), signal);
        await sleep(120, signal);
        return { arrived: true, hydrated: true };
      }
    }
    await sleep(60, signal);
  }
  return { arrived, hydrated: arrived && isHydrated() };
}

/* ----------------------------------------------------------------- wait_for */

let inflight = 0;
let networkWatched = false;

/** Count fetches in flight (the widget's own /api/agent/* traffic excluded). Installed lazily, once. */
function watchNetwork(): void {
  if (networkWatched || typeof window === "undefined") return;
  networkWatched = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/agent/")) return original(input, init);
    inflight += 1;
    return original(input, init).finally(() => {
      inflight -= 1;
    });
  };
}

const BUSY_BUTTON = /^(working|processing|loading|running|converting|compressing|recogni[sz]ing|uploading|starting|please wait)\b/i;

/** Visible "still working" signals in the tool: busy status lines, unfinished progress bars, aria-busy, disabled "Working…" buttons. */
export function busyIndicators(): string[] {
  const found: string[] = [];
  const selector = '[role="status"], [aria-busy="true"], progress, [role="progressbar"], button:disabled';
  for (const el of Array.from(rootElement().querySelectorAll(selector))) {
    if (inWidget(el) || !isVisible(el)) continue;
    const text = squash(el.textContent ?? "");
    if (el instanceof HTMLProgressElement) {
      if (!el.hasAttribute("value") || el.value < el.max) found.push(el.getAttribute("aria-label") || (el.position >= 0 ? `progress ${Math.round(el.position * 100)}%` : "progress"));
    } else if (el.getAttribute("role") === "progressbar") {
      const now = Number(el.getAttribute("aria-valuenow"));
      if (!Number.isFinite(now) || now < Number(el.getAttribute("aria-valuemax") ?? 100)) found.push(el.getAttribute("aria-label") || text || "progress");
    } else if (el.getAttribute("aria-busy") === "true") {
      found.push(text || "busy region");
    } else if (el instanceof HTMLButtonElement) {
      if (BUSY_BUTTON.test(text)) found.push(text);
    } else if (BUSY_TEXT.test(text)) {
      found.push(text);
    }
  }
  return found.map((t) => clip(t, 80));
}

/** Text of one control/region (null when the id is gone), or the whole tool: visible text, control labels and field values. */
function scopeText(id: string | undefined): string | null {
  if (id) {
    const el = findById(id);
    return el ? elementText(el) : null;
  }
  const root = rootElement();
  const labels = Array.from(root.querySelectorAll(CONTROL_SELECTOR)).filter((el) => !inWidget(el) && !isSensitiveInput(el)).map((el) => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : labelText(el)));
  return `${textOf(root, { expandNested: true })}\n${labels.join("\n")}`;
}

export interface WaitOutcome {
  met: boolean;
  timedOut: boolean;
  aborted: boolean;
  reason?: string;
  elapsedMs: number;
  /** Busy indicators still showing when the wait ended. */
  busy: string[];
}

/**
 * Block until the condition holds, the timeout passes or the signal aborts. Polls every 150 ms; DOM
 * mutations in <main> (the widget and the agent's own highlight/flash attributes excluded) and fetches
 * in flight feed the "idle" condition. `onTick` fires about once a second for live progress.
 */
export async function waitForCondition(
  cond: WaitCondition,
  options: { signal?: AbortSignal; onTick?: (elapsedMs: number) => void },
): Promise<WaitOutcome> {
  const { signal, onTick } = options;
  if (cond.kind === "idle") watchNetwork();
  const started = Date.now();
  let lastMutation = started;
  const observer = new MutationObserver((records) => {
    if (records.some((r) => !(r.type === "attributes" && r.attributeName?.startsWith("data-agent")))) lastMutation = Date.now();
  });
  observer.observe(rootElement(), { subtree: true, childList: true, characterData: true, attributes: true });
  const evaluator = new WaitEvaluator(cond);
  let nextTick = 0;
  try {
    for (;;) {
      const elapsedMs = Date.now() - started;
      if (signal?.aborted) return { met: false, timedOut: false, aborted: true, elapsedMs, busy: [] };
      const busy = cond.kind === "busy_done" ? busyIndicators() : [];
      const verdict = evaluator.check({
        elapsedMs,
        sinceMutationMs: Date.now() - lastMutation,
        inflight,
        busy,
        scope: cond.kind === "text" || cond.kind === "change" ? scopeText(cond.id) : null,
        fileIds: cond.kind === "new_file" ? listArtifacts().map((a) => a.id) : [],
      });
      if (verdict.met) return { met: true, timedOut: false, aborted: false, reason: verdict.reason, elapsedMs, busy };
      if (elapsedMs >= cond.timeoutMs) return { met: false, timedOut: true, aborted: false, elapsedMs, busy: busy.length ? busy : busyIndicators() };
      if (elapsedMs >= nextTick) {
        onTick?.(elapsedMs);
        nextTick = elapsedMs + 1000;
      }
      await sleep(150, signal);
    }
  } finally {
    observer.disconnect();
  }
}
