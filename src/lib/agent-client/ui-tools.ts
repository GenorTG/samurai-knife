import { requestWait } from "./interaction";
import { CATEGORIES, TOOLS, categoryLabel, findTool, resolveAlias, type ToolMeta } from "@/lib/registry";
import { getFeedback, navigationFinished, navigationStarted, stepStarted } from "./feedback";
import { searchTargets } from "./tool-search";
import { ARTIFACT_ID, drainNewArtifacts, readArtifactText } from "./artifacts";
import { attachFile, clickElement, controlElement, controlLabel, diffSnapshots, fillField, readText, settlePage, sleep, snapshotPage, waitForCondition, waitForPage, waitForToolPanel } from "./dom-bridge";
import { MAX_WAIT_FOR_MS, describeWait, parseWaitFor, waitingLabel } from "./wait-condition";
import type { FunctionToolDef, ToolRunResult } from "./types";
import { LIVE_TOOL_DEFS, isLiveTool, runLiveTool } from "./office-live-tools";
import { CRAFT_TOOL_DEFS, isCraftTool, runCraftTool } from "./craft-live-tools";

/**
 * Tools the model can call that run in the browser, against the live page.
 * Server-side `knife_*` tools are fetched from /api/agent/tools instead.
 */

const MAX_WAIT_MS = 5000;
const NAVIGATION_TIMEOUT_MS = 20000;
const RESULT_LIMIT = 14000;

function def(name: string, description: string, properties: Record<string, unknown>, required: string[]): FunctionToolDef {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
  };
}

export const UI_TOOL_DEFS: FunctionToolDef[] = [
  def(
    "list_tools",
    "Find what to open. With a query it returns ranked matches: each has slug (+ tab for suite tabs) ready to pass to open_tool, so one call is enough; the first match is the best. Without a query it lists every tool with its tab ids.",
    {
      query: { type: "string", description: "What you want, e.g. 'base64', 'merge csv', 'cron', 'jwt decode'." },
      category: { type: "string", enum: CATEGORIES.map((c) => c.id), description: "Restrict to one category." },
      limit: { type: "integer", description: "Max results (default 30 with a query, all without).", minimum: 1, maximum: 120 },
    },
    [],
  ),
  def(
    "open_tool",
    "Navigate the page to a tool by slug, optionally to a tab of a suite (client-side; this widget stays open). Waits for the page to load and returns the page snapshot (same shape as page_snapshot), so act on its ids right away.",
    {
      slug: { type: "string", description: "Tool or suite slug from list_tools, e.g. 'qr'. Retired slugs such as 'cron' also work." },
      tab: { type: "string", description: "Tab id inside a suite (listed as tabs by list_tools), e.g. 'cron' in 'meeting-timezones'." },
    },
    ["slug"],
  ),
  def(
    "page_snapshot",
    "Describe the current page: form controls and buttons (each with an id like c12, label, type, value, state), output regions (ids like r3) and page text. Call before acting and again after the page may have changed.",
    {},
    [],
  ),
  def(
    "fill_field",
    "Set a text input, textarea, select (value or visible label), checkbox or radio ('true'/'false') by control id from the latest snapshot. Fires the events the page listens to, waits for the page to settle and returns what changed (changed.controls / changed.regions with ids and text), so no wait or page_snapshot is needed to see the output.",
    {
      id: { type: "string", description: "Control id from page_snapshot, e.g. c12." },
      value: { type: "string", description: "New value as text." },
    },
    ["id", "value"],
  ),
  def(
    "click",
    "Click a button, link (same-origin only), tab, summary or other control by id from the latest snapshot. Waits for the page to settle and returns what changed (changed.controls / changed.regions), or the new snapshot when the URL changed.",
    { id: { type: "string", description: "Control id from page_snapshot." } },
    ["id"],
  ),
  def(
    "read_text",
    "Read the full text of a control value or an output region by id (c.. or r..), or of a text file a tool produced (f1, f2… from page_snapshot files / new_files). Long text is truncated.",
    { id: { type: "string", description: "Control or region id from page_snapshot, or a produced text file id such as f1." } },
    ["id"],
  ),
  def(
    "wait",
    `Pause up to ${MAX_WAIT_MS} ms for debounced output or rendering. For anything slower (OCR, conversion, uploads, a result that has not appeared yet) use wait_for instead: it returns as soon as the work is done. Reports new_files when a tool produced a file meanwhile.`,
    { ms: { type: "integer", minimum: 0, maximum: MAX_WAIT_MS, description: "Milliseconds to wait." } },
    ["ms"],
  ),
  def(
    "wait_for",
    `Block until something happens on the page, up to timeout_s (default 60, max ${MAX_WAIT_FOR_MS / 1000}), instead of polling with wait/page_snapshot. Use it for slow work such as OCR, conversions or uploads: click the button, then wait_for. until: "busy_done" = the progress/status line ("Recognizing page 1 of 4…", progress bar, disabled "Working…" button) is gone (best default after starting work); "new_file" = a tool produced a download; "text" = {text} or {regex} appears (anywhere, or inside {id}); "change" = the control/region {id} changes; "idle" = nothing on the page changes for idle_ms (default 1500). Returns what changed (changed.controls / changed.regions, new_files). If timed_out is true the work is not finished: call wait_for again or tell the user it is slow. The user sees "Waiting for … (12 s)" live and can Stop.`,
    {
      until: { type: "string", enum: ["busy_done", "new_file", "text", "change", "idle"], description: "What to wait for (inferred as text/change when text/regex/id is given alone)." },
      text: { type: "string", description: "For until=text: case-insensitive text to wait for." },
      regex: { type: "string", description: "For until=text: JavaScript regex source (case-insensitive) instead of text." },
      id: { type: "string", description: "Control or region id from the latest snapshot: scope for text, the thing to watch for change." },
      idle_ms: { type: "integer", minimum: 200, maximum: 30000, description: "For until=idle: quiet period in ms (default 1500)." },
      timeout_s: { type: "integer", minimum: 1, maximum: MAX_WAIT_FOR_MS / 1000, description: "Give up after this many seconds (default 60)." },
    },
    [],
  ),
  def(
    "wait_for_user",
    "Pause the run until the USER provides something you cannot invent: their real file, their own text or a decision. First navigate to the tool and page_snapshot, then call this with a short message and, when the user must use a particular control (e.g. a file input), its id so it pulses on the page. The run resumes automatically when they use that control, press Continue, or reply in chat; the result says which. Never fabricate the user's real data and never end your turn just to ask for a file when the control is on the page.",
    {
      message: { type: "string", description: "What you need, one short sentence, no control ids, e.g. 'Choose the PDF you want to compress.'" },
      id: { type: "string", description: "Optional control id from page_snapshot that the user should use." },
    },
    ["message"],
  ),
  def(
    "upload_file",
    "Attach a file to a file input (kind \"file\" in page_snapshot). To chain tools, pass from_file with the id (f1, f2…) of a file a previous tool produced (shown as new_files after the click that made it, and as files in page_snapshot): the bytes never pass through you, so it works for binary output too. Otherwise pass a file you create as UTF-8 text, or binary as base64 (max 1 MiB each). When a prompt supplies base64, copy it byte-for-byte; never reconstruct or normalize it. MIME is inferred from known filename extensions when omitted. An input marked multiple takes several files in ONE call via files:[{name, text|base64}]; each call replaces the previous selection. Then page_snapshot to see what the tool did with it.",
    {
      id: { type: "string", description: "File input id." },
      name: { type: "string", description: "File name, e.g. sample.csv. Optional with from_file (keeps the produced name)." },
      from_file: { type: "string", description: "Id of a file a tool produced earlier, e.g. f1." },
      text: { type: "string", description: "UTF-8 file content." },
      base64: { type: "string", description: "Binary file content, base64." },
      mime: { type: "string", description: "Optional MIME type; inferred from known filename extensions when omitted." },
      files: {
        type: "array",
        description: "Several files for an input that accepts multiple; replaces name/text/base64.",
        items: {
          type: "object",
          properties: { name: { type: "string" }, from_file: { type: "string" }, text: { type: "string" }, base64: { type: "string" }, mime: { type: "string", description: "Optional MIME type; inferred from known filename extensions when omitted." } },
        },
      },
    },
    ["id"],
  ),
  // Live editing of the open office document (group office_live; offered only while the editor plugin is connected).
  ...LIVE_TOOL_DEFS,
  // The Craft app open on the page (group craft_live; offered only while an app with an agent API is connected).
  ...CRAFT_TOOL_DEFS,
];

const UI_TOOL_NAMES = new Set(UI_TOOL_DEFS.map((d) => d.function.name));

export function isUiTool(name: string): boolean {
  return UI_TOOL_NAMES.has(name);
}

export interface UiToolContext {
  /** Client-side navigation (router.push). */
  navigate: (href: string) => void;
  signal?: AbortSignal;
  chatId?: string;
}

type Args = Record<string, unknown>;

function stringArg(args: Args, key: string): string | null {
  const v = args[key];
  return typeof v === "string" ? v : null;
}

function out(ok: boolean, body: object): ToolRunResult {
  const text = JSON.stringify(body);
  if (text.length <= RESULT_LIMIT) return { ok, content: text };
  return { ok, content: JSON.stringify({ ok, _truncated: true, preview: text.slice(0, RESULT_LIMIT - 100) }) };
}

function okAndBody<T extends { ok: boolean }>(r: T): [boolean, T] {
  return [r.ok, r];
}

function error(message: string): ToolRunResult {
  return out(false, { ok: false, error: message });
}

function listTools(args: Args): ToolRunResult {
  const query = stringArg(args, "query")?.trim() ?? "";
  const category = stringArg(args, "category");
  const pool = category ? TOOLS.filter((t) => t.category === category) : TOOLS;
  const requested = typeof args.limit === "number" ? Math.floor(args.limit) : null;
  if (query) {
    const limit = Math.max(1, Math.min(30, requested ?? 8));
    const matches = searchTargets(query, pool, limit);
    return out(true, {
      ok: true,
      query,
      matches: matches.map((m) => ({
        open_tool: m.tab ? { slug: m.slug, tab: m.tab } : { slug: m.slug },
        name: m.label,
        summary: m.summary.slice(0, 90),
        handles: m.keywords.join(", "),
      })),
      ...(matches.length === 0 ? { note: "Nothing matched. Try one different keyword, or call list_tools without a query for the full list." } : {}),
    });
  }
  const limit = Math.max(1, Math.min(120, requested ?? 120));
  return out(true, {
    ok: true,
    total: TOOLS.length,
    tools: pool.slice(0, limit).map(
      (t) => `${t.slug} | ${t.name} | ${categoryLabel(t.category)}${t.tabs ? ` | tabs: ${t.tabs.map((tab) => tab.id).join(",")}` : ""}`,
    ),
  });
}

function targetLabel(tool: ToolMeta, tabId: string): string {
  const tab = tool.tabs?.find((t) => t.id === tabId);
  return tab ? `${tool.name} → ${tab.label}` : tool.name;
}

async function openTool(args: Args, ctx: UiToolContext): Promise<ToolRunResult> {
  const requested = stringArg(args, "slug")?.trim().replace(/^\/?tools\//, "") ?? "";
  const alias = resolveAlias(requested);
  const slug = alias?.slug ?? requested;
  const tool = findTool(slug);
  if (!tool) {
    const near = searchTargets(requested, TOOLS, 4).map((m) => (m.tab ? `{slug:"${m.slug}", tab:"${m.tab}"}` : `{slug:"${m.slug}"}`));
    return error(`Unknown tool slug "${requested}".${near.length ? ` Did you mean: ${near.join(", ")}?` : ""} Call list_tools with a query to find the right slug.`);
  }
  const wantedTab = stringArg(args, "tab")?.trim() || alias?.tab || "";
  if (wantedTab && !tool.tabs?.some((t) => t.id === wantedTab)) {
    const ids = tool.tabs?.map((t) => t.id).join(", ");
    return error(`"${tool.slug}" has no tab "${wantedTab}".${ids ? ` Tabs: ${ids}.` : " It is not a suite."}`);
  }
  const target = `/tools/${tool.slug}`;
  const href = wantedTab ? `${target}?tab=${wantedTab}` : target;
  const current = window.location.pathname + window.location.search;
  const sameTab = wantedTab ? new URLSearchParams(window.location.search).get("tab") === wantedTab : true;
  const label = targetLabel(tool, wantedTab);
  const switching = window.location.pathname !== target || !sameTab;
  if (switching) {
    navigationStarted(label);
    ctx.navigate(href);
  }
  const alreadyHere = !switching;
  const { arrived, hydrated } = await waitForPage(target, NAVIGATION_TIMEOUT_MS, ctx.signal, wantedTab || undefined);
  navigationFinished(switching && arrived ? label : null);
  if (!arrived) return error(`Navigation to ${href} (from ${current}) did not complete in time; try again or call page_snapshot.`);
  await waitForToolPanel(3000, ctx.signal);
  return out(true, {
    ok: true,
    opened: tool.slug,
    name: tool.name,
    url: href,
    ...(tool.tabs && !wantedTab ? { tabs: tool.tabs.map((t) => t.id), note: "Suite: pass tab to open a specific tab." } : {}),
    hydrated,
    ...(alreadyHere ? { note: "Already on this page: nothing was reloaded or reset; the page state is unchanged." } : {}),
    snapshot: snapshotPage(),
    next: "The snapshot above is current: use its control ids. Call page_snapshot only after the page may have changed.",
  });
}

async function wait(args: Args, ctx: UiToolContext): Promise<ToolRunResult> {
  const raw = typeof args.ms === "number" ? args.ms : 500;
  const ms = Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(raw)));
  await sleep(ms, ctx.signal);
  const produced = drainNewArtifacts();
  return out(true, { ok: true, waitedMs: ms, ...(produced.length ? { new_files: produced } : {}) });
}

/** Show "Waiting for … (12 s)" on the running step line and in the top-bar pill (both render the step label). */
function showWaitProgress(label: string): void {
  const step = [...getFeedback().steps].reverse().find((s) => s.name === "wait_for" && s.status === "running");
  if (step) stepStarted(step.id, step.name, label);
}

async function waitFor(args: Args, ctx: UiToolContext): Promise<ToolRunResult> {
  const parsed = parseWaitFor(args);
  if (!parsed.ok) return error(parsed.error);
  const { cond } = parsed;
  if (cond.id && !controlElement(cond.id)) return error(`Element id ${cond.id} not found on the page. Call page_snapshot and use a fresh id.`);
  const label = cond.id ? controlLabel(cond.id) : null;
  const before = snapshotPage();
  const outcome = await waitForCondition(cond, { signal: ctx.signal, onTick: (ms) => showWaitProgress(waitingLabel(cond, ms, label)) });
  if (outcome.aborted) return error("Stopped by the user.");
  await settlePage(ctx.signal, 150, 150, 600);
  const produced = drainNewArtifacts();
  const changed = diffSnapshots(before, snapshotPage());
  return out(true, {
    ok: true,
    met: outcome.met,
    timed_out: outcome.timedOut,
    waited_s: Math.round(outcome.elapsedMs / 100) / 10,
    condition: describeWait(cond, label),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.timedOut ? { still_busy: outcome.busy, hint: "Not met yet. Call wait_for again to keep waiting (the clock restarts), or tell the user it is taking long." } : {}),
    changed,
    ...(produced.length ? { new_files: produced } : {}),
  });
}

/** Run an acting call, let the page settle, and attach what changed so the model needs no wait/snapshot/read round. */
async function settled(run: () => ToolRunResult | Promise<ToolRunResult>, skipId: string | null, ctx: UiToolContext): Promise<ToolRunResult> {
  const before = snapshotPage();
  const r = await run();
  if (!r.ok) return r;
  await settlePage(ctx.signal);
  const body = JSON.parse(r.content) as Record<string, unknown>;
  const after = snapshotPage();
  if (after.url !== before.url) body.snapshot = after;
  else body.changed = diffSnapshots(before, after, skipId ?? undefined);
  const produced = drainNewArtifacts();
  if (produced.length) body.new_files = [...((body.new_files as unknown[] | undefined) ?? []), ...produced];
  return out(true, body);
}

export async function runUiTool(name: string, args: Args, ctx: UiToolContext): Promise<ToolRunResult> {
  try {
    if (isLiveTool(name)) return await runLiveTool(name, args, ctx.signal);
    if (isCraftTool(name)) return await runCraftTool(name, args, ctx.signal);
    switch (name) {
      case "list_tools":
        return listTools(args);
      case "open_tool":
        return await openTool(args, ctx);
      case "page_snapshot":
        await waitForToolPanel(3000, ctx.signal);
        return out(true, { ok: true, ...snapshotPage() });
      case "fill_field": {
        const id = stringArg(args, "id");
        const value = typeof args.value === "string" ? args.value : typeof args.value === "number" || typeof args.value === "boolean" ? String(args.value) : null;
        if (!id || value === null) return error('fill_field needs {"id": string, "value": string}.');
        return settled(() => out(...okAndBody(fillField(id, value))), id, ctx);
      }
      case "click": {
        const id = stringArg(args, "id");
        if (!id) return error('click needs {"id": string}.');
        return settled(async () => out(...okAndBody(await clickElement(id))), null, ctx);
      }
      case "read_text": {
        const id = stringArg(args, "id");
        if (!id) return error('read_text needs {"id": string}.');
        if (ARTIFACT_ID.test(id)) {
          const file = await readArtifactText(id);
          return "error" in file ? error(file.error) : out(true, { ok: true, id, ...file });
        }
        const r = readText(id);
        return out(r.ok, r);
      }
      case "wait":
        return await wait(args, ctx);
      case "wait_for":
        return await waitFor(args, ctx);
      case "wait_for_user": {
        const message = stringArg(args, "message")?.trim();
        if (!message) return error('wait_for_user needs {"message": string}.');
        const id = stringArg(args, "id");
        const r = await requestWait({ message, targetId: id }, ctx.signal, ctx.chatId ?? "default");
        if (r.resumedBy === "aborted") return error("Cancelled by the user.");
        if (r.resumedBy === "timeout") return error("The user did not respond within 30 minutes; stop and tell them you are waiting.");
        return out(true, {
          ok: true,
          resumed_by: r.resumedBy,
          ...(r.message ? { user_said: r.message } : {}),
          next: r.resumedBy === "message" ? "Treat user_said as their reply." : "Call page_snapshot to see what the user provided, then continue.",
        });
      }
      case "upload_file":
      {
        const id = stringArg(args, "id");
        const name = stringArg(args, "name");
        const many = Array.isArray(args.files) ? (args.files as Args[]) : null;
        if (!id || (!name && !stringArg(args, "from_file") && !many)) return error('upload_file needs {"id": string, "from_file": "f1"}, {"id": string, "name": string, "text"|"base64": string} or {"id": string, "files": [...]}.');
        const toFile = (a: Args) => ({
          name: stringArg(a, "name") ?? "",
          fromFile: stringArg(a, "from_file") ?? undefined,
          text: stringArg(a, "text") ?? undefined,
          base64: stringArg(a, "base64") ?? undefined,
          mime: stringArg(a, "mime") ?? undefined,
        });
        return settled(() => out(...okAndBody(attachFile(id, many ? many.map(toFile) : toFile(args)))), null, ctx);
      }
      default:
        return error(`Unknown UI tool "${name}".`);
    }
  } catch (exc) {
    return error(exc instanceof Error ? exc.message : "UI tool failed.");
  }
}
