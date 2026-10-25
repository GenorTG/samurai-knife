import * as z from "zod/v4";
import { defineTool, type KnifeToolDefinition } from "./define";
import { CALL_TIMEOUT_MS, LIST_TOOLS, LIVE_TOOL_NAME, MAX_CALL_ARGS_BYTES, MAX_CALL_TIMEOUT_MS, openTabs, requestCall, requestShow } from "@/lib/ui-bridge/store";
import { SHOW_PARAMS, ShowPathError, showPath } from "@/lib/ui-bridge/path";
import { UNTRUSTED_NOTE, wrapUntrusted } from "@/lib/security/untrusted";

/**
 * MCP-only tools for agents OUTSIDE the app (the built-in assistant drives the page directly with open_tool): see which
 * app pages the user has open, and bring one of them to the result of your work. Data edits go through the knife_* tools;
 * open pages refresh by themselves (CV studio polls every 2 s and highlights what changed). knife_ui_call runs one of the
 * open page's live tools (the office document, a Craft app) in the user's visible tab, behind the same approval cards
 * the in-page assistant gets (docs/MCP.md "knife_ui_call").
 */

const ago = (ms: number): string => (ms < 1_500 ? "now" : `${Math.round(ms / 1000)} s ago`);

export const UI_BRIDGE_TOOLS: KnifeToolDefinition[] = [
  defineTool({
    name: "knife_ui_state",
    scope: "account",
    effect: "read",
    description:
      "Which Smart Knife pages the user has open in a browser right now (path, title, visible, last activity), most recently active first. Use it to know what the user is looking at before you change something, and whether knife_ui_show can reach a tab.",
    schema: z.object({}).strict(),
    run(_input, ctx) {
      const now = Date.now();
      const tabs = openTabs(ctx?.accountId ?? "").map((t) => ({
        clientId: t.clientId,
        path: t.path,
        title: t.title,
        visible: t.visible,
        connected: t.connected,
        lastActive: t.activeAt ? ago(now - t.activeAt) : "never",
        lastSeen: ago(now - t.at),
        ...(t.live ? { live: t.live } : {}),
        ...(t.tools.length ? { liveTools: t.tools } : {}),
      }));
      return {
        tabs,
        note: tabs.length
          ? "knife_ui_show targets the first connected tab unless you pass clientId. liveTools = what knife_ui_call can run in that tab now (knife_ui_call {tool:'list_tools'} returns their parameters)."
          : "No app tab is open: ask the user to open the app, or just make the change (it shows when they open it).",
      };
    },
  }),
  defineTool({
    name: "knife_ui_show",
    scope: "account",
    effect: "write",
    description:
      "Bring the user's open Smart Knife tab to a page so they SEE your result: slug (e.g. 'cv-studio'), optional tab ('profile', 'jobs', 'variants', 'applications', 'showcase' for cv-studio), optional deep links: job (offer id, Job offers tab), variant (CV version id, CV versions tab), focus (profile id-path, Profile tab), doc (office document id), workflow (workflow id: opens it in the workflow editor, slug 'workflows'). note = one short line shown to the user ('Tailored your CV for Addepto'). Goes to the most recently active tab (or clientId from knife_ui_state). Changes you make with knife_* tools appear live anyway; use this to point at them.",
    schema: z.object({
      slug: z.string().min(1).max(80),
      tab: z.string().max(40).optional(),
      job: z.string().max(64).optional(),
      variant: z.string().max(64).optional(),
      focus: z.string().max(300).optional(),
      doc: z.string().max(64).optional(),
      workflow: z.string().max(64).optional(),
      note: z.string().max(300).optional(),
      clientId: z.string().max(64).optional(),
    }).strict(),
    run({ slug, tab, note, clientId, ...rest }, ctx) {
      let path: string;
      try {
        path = showPath(slug, tab, Object.fromEntries(SHOW_PARAMS.map((k) => [k, rest[k]])));
      } catch (error) {
        if (error instanceof ShowPathError) throw new Error(error.message);
        throw error;
      }
      const sent = requestShow(ctx?.accountId ?? "", path, note ?? "", "MCP agent", clientId);
      if (!sent) return { shown: false, path, note: clientId ? `No connected tab '${clientId}'.` : "No app tab is open (or none is connected): the user will see the change when they open " + path };
      return { shown: true, path, tab: { clientId: sent.tab.clientId, was: sent.tab.path, visible: sent.tab.visible } };
    },
  }),
  defineTool({
    name: "knife_ui_call",
    scope: "account",
    effect: "write",
    untrustedOutput: true,
    description:
      "Run one live tool in the user's open, visible Smart Knife tab and get its result: the office document open in the editor (doc_live_* tools: read, write, format, tables, cells, charts, slides) or the Craft app open on /tools/artcraft (craft_* tools: inspect, commands, execute, screenshot, files). First call knife_ui_call {tool:'list_tools'}: the definitions and parameters of the tools the open page offers, and for a Craft app its guide (units, how to read the document, exact commands for common jobs: read it before the first edit; craft_commands {command:'<id>'} gives one command's whole parameter doc); open the right page with knife_ui_show (e.g. slug 'office' with doc=<id>, or slug 'artcraft' tab 'vectorcraft') if needed. The user's tab asks the user before acting (same trust mode and approval cards as the in-page assistant; destructive calls are always confirmed); a refusal comes back as declined: do not retry it. Files a tool makes (craft_screenshot, craft_export, an export craft_execute returns) stay in the tab and come back only as new_files ids (\"f3\"): to get one, call craft_file_save {file:\"f3\"} here (it keeps the file in the user's Craft files, asked like any edit) and read it with knife_craft_file_read {id}. Waits up to timeoutSeconds (default 60) for the answer. Never runs without a visible tab. " +
      UNTRUSTED_NOTE,
    schema: z.object({
      tool: z.string().min(1).max(60),
      args: z.record(z.string(), z.unknown()).optional(),
      clientId: z.string().max(64).optional(),
      timeoutSeconds: z.number().int().min(5).max(MAX_CALL_TIMEOUT_MS / 1000).optional(),
    }).strict(),
    async run({ tool, args, clientId, timeoutSeconds }, ctx) {
      if (tool !== LIST_TOOLS && !LIVE_TOOL_NAME.test(tool)) {
        throw new Error(`'${tool}' is not a live tool: knife_ui_call runs doc_live_* and craft_* tools (or list_tools). Data edits go through the other knife_* tools.`);
      }
      const sent = requestCall(ctx?.accountId ?? "", { tool, args: args ?? {}, from: "MCP agent", clientId, timeoutMs: (timeoutSeconds ?? CALL_TIMEOUT_MS / 1000) * 1000 });
      if ("refused" in sent) {
        switch (sent.refused) {
          case "no_tab":
            return { called: false, reason: "no_tab", note: clientId ? `No visible, connected tab '${clientId}' (knife_ui_state lists them).` : "No visible app tab: ask the user to open Smart Knife (and the document or Craft app) and keep the tab in front." };
          case "not_offered":
            return {
              called: false,
              reason: "not_offered",
              tab: { clientId: sent.tab.clientId, path: sent.tab.path },
              liveTools: sent.tab.tools,
              note: sent.tab.live || (sent.tab.tools.length ? `This page does not offer ${tool} now.` : "This page has no live tools: open a document in the office editor or a Craft app with an agent API (VectorCraft, FilmCraft, EffectCraft) first (knife_ui_show)."),
            };
          case "too_many":
            return { called: false, reason: "too_many", note: "Other calls to this account's tab are still waiting for an answer; wait for them first." };
          case "args_too_big":
            return { called: false, reason: "args_too_big", note: `Arguments are ${sent.bytes} bytes; the limit is ${MAX_CALL_ARGS_BYTES}.` };
        }
      }
      const outcome = await sent.outcome;
      const tab = { clientId: sent.tab.clientId, path: sent.tab.path };
      switch (outcome.status) {
        case "done":
          // what the page returns is the document's / app's content: third-party text for the agent
          return { called: true, tool, tab, ok: outcome.ok, result: wrapUntrusted(`${tool} in the open tab ${sent.tab.path}`, outcome.content) };
        case "declined":
          return { called: true, tool, tab, ok: false, reason: "declined", note: "The user declined this action. Do not retry it; tell them what you wanted to do and ask how they would like to proceed." };
        case "busy":
          return { called: false, tool, tab, reason: "busy", note: outcome.content || "The in-page assistant is running in this account; try again when it finishes." };
        case "unavailable":
          return { called: false, tool, tab, reason: "not_offered", note: outcome.content };
        case "timeout":
          return { called: false, tool, tab, reason: "timeout", note: outcome.pickedUp ? "The tab did not answer in time (the user may not have answered the approval card)." : "The tab did not pick the call up in time (it was hidden or closed)." };
        case "gone":
          return { called: false, tool, tab, reason: "gone", note: "The tab closed or went away before answering." };
      }
    },
  }),
];
