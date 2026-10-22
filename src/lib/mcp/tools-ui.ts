import * as z from "zod/v4";
import { defineTool, type KnifeToolDefinition } from "./define";
import { openTabs, requestShow } from "@/lib/ui-bridge/store";
import { SHOW_PARAMS, ShowPathError, showPath } from "@/lib/ui-bridge/path";

/**
 * MCP-only tools for agents OUTSIDE the app (the built-in assistant drives the page directly with open_tool): see which
 * app pages the user has open, and bring one of them to the result of your work. Data edits go through the knife_* tools;
 * open pages refresh by themselves (CV studio polls every 2 s and highlights what changed).
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
      const tabs = openTabs(ctx?.accountId ?? "").map((t) => ({ clientId: t.clientId, path: t.path, title: t.title, visible: t.visible, connected: t.connected, lastActive: t.activeAt ? ago(now - t.activeAt) : "never", lastSeen: ago(now - t.at) }));
      return { tabs, note: tabs.length ? "knife_ui_show targets the first connected tab unless you pass clientId." : "No app tab is open: ask the user to open the app, or just make the change (it shows when they open it)." };
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
];
