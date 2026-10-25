import { assessCall, type Assessment } from "./approval-policy";
import { CRAFT_TOOL_DEFS, craftStatusNote, craftToolAvailable, isCraftTool } from "./craft-live-tools";
import { getTrustMode } from "./interaction";
import { LIVE_TOOL_DEFS, isLiveTool, liveStatusNote, liveToolAvailable } from "./office-live-tools";
import { tryAcquireRun } from "./run-lock";
import { activeCraft } from "@/lib/craft/live";
import { craftGuide } from "@/lib/craft/guides";
import { runtime } from "./runtime-store";
import { runUiTool } from "./ui-tools";

/**
 * Runs a call an agent OUTSIDE the app sent this tab over MCP (`knife_ui_call`, src/lib/mcp/tools-ui.ts): one of the
 * page's live tools (doc_live_* for the open document, craft_* for the open Craft app), or list_tools for their
 * definitions. Same gate as the in-page assistant (approval-policy.ts under the tab's trust mode; no "allow for this
 * run": every call stands alone), and never while the in-page assistant runs in this account (the run lock), so the
 * two never interleave edits. Never throws.
 */

export const LIST_TOOLS = "list_tools";
const RESULT_LIMIT = 60_000;

export interface ExternalCall {
  tool: string;
  args: Record<string, unknown>;
  from: string;
  /** The account the server sent the call for (src/lib/ui-bridge/store.ts). */
  account?: string;
}

export interface ExternalAnswer {
  status: "done" | "declined" | "busy" | "unavailable";
  ok: boolean;
  content: string;
}

/** Asks the user; resolves true to go ahead. The card says who asks (`from`). */
export type ApproveFn = (request: Assessment & { from: string; tool: string; args: string }) => Promise<boolean>;

/** The call's arguments as the card shows them: an outside agent's intent is not in the user's own words, so show it. */
export function argsPreview(args: Record<string, unknown>, max = 400): string {
  const text = JSON.stringify(args);
  if (text === "{}") return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const ALL_DEFS = [...LIVE_TOOL_DEFS, ...CRAFT_TOOL_DEFS];

const available = (name: string): boolean => (isLiveTool(name) || isCraftTool(name)) && liveToolAvailable(name) && craftToolAvailable(name);

/** Names of the live tools this page offers right now (reported with presence). */
export function offeredLiveTools(): string[] {
  return ALL_DEFS.map((d) => d.function.name).filter(available);
}

/** The page's live state in one line (reported with presence), empty when it has none. */
export function liveNote(): string {
  return liveStatusNote() ?? craftStatusNote() ?? "";
}

const clip = (text: string): string => (text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT - 40)}… [cut at ${RESULT_LIMIT} characters]` : text);

export async function runExternalCall(call: ExternalCall, approve: ApproveFn, signal?: AbortSignal): Promise<ExternalAnswer> {
  // This page was loaded by one account and the call is for another (someone signed in elsewhere in this browser): the
  // open document, the Craft app and the file chain are the first account's, so nothing here may run for the second.
  const loadedAs = runtime.get().accountId;
  if (call.account && loadedAs && call.account !== loadedAs) {
    return { status: "unavailable", ok: false, content: "This tab was opened while another account was signed in; the user has to reload it before an agent can use it." };
  }
  if (call.tool === LIST_TOOLS) {
    const tools = ALL_DEFS.filter((d) => available(d.function.name)).map((d) => d.function);
    const app = activeCraft();
    const guide = app ? craftGuide(app.appId) : null;
    // An outside agent has no system prompt from us: the open app's guide comes with the definitions.
    return { status: "done", ok: true, content: JSON.stringify({ ok: true, page: liveNote() || "This page has no live tools.", tools, ...(guide ? { guide: guide.text } : {}) }) };
  }
  if (!isLiveTool(call.tool) && !isCraftTool(call.tool)) return { status: "unavailable", ok: false, content: `'${call.tool}' is not a live tool.` };
  if (!available(call.tool)) {
    return { status: "unavailable", ok: false, content: `${call.tool} is not available on this page now. ${liveNote() || "Open a document in the office editor or a Craft app with an agent API first."}` };
  }
  if (runtime.get().run !== "idle") return { status: "busy", ok: false, content: "The in-page assistant is running in this tab; try again when it finishes." };
  const accountId = runtime.get().accountId;
  const lease = accountId ? await tryAcquireRun(accountId) : null;
  if (accountId && !lease) return { status: "busy", ok: false, content: "The in-page assistant is running in another tab of this account; try again when it finishes." };
  try {
    const verdict = assessCall(call.tool, call.args, JSON.stringify(call.args), getTrustMode());
    if (verdict.ask && !(await approve({ ...verdict, from: call.from, tool: call.tool, args: argsPreview(call.args) }))) {
      return { status: "declined", ok: false, content: "The user declined this action." };
    }
    if (signal?.aborted) return { status: "declined", ok: false, content: "The request expired before it was approved." };
    // live tools never navigate; a stray navigation request is ignored rather than moving the user's page
    const result = await runUiTool(call.tool, call.args, { navigate: () => {}, signal });
    return { status: "done", ok: result.ok, content: clip(result.content) };
  } finally {
    lease?.release();
  }
}
