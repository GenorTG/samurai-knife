import { describeCall } from "@/components/agent/summarize";
import { findTool, resolveAlias } from "@/lib/registry";
import { describeActionTarget, fieldWouldBeCleared, fieldWouldBeOverwritten, fileInputHoldsUserFiles, pageHasUserWork } from "./dom-bridge";
import type { TrustMode } from "./interaction";
import { activeLiveBridge } from "@/lib/office/live-bridge";
import { assessLiveCall, isLiveTool } from "./office-live-tools";
import { assessCraftCall, isCraftTool } from "./craft-live-tools";
import type { Assessment } from "./server-tool-policy";
import { ct } from "@/lib/i18n/client-locale";

/**
 * Decides whether a tool call needs the user's OK under the active trust mode.
 * This file covers the page tools; reads, waits and wait_for_user never prompt. The server-side knife_* tools are
 * judged by their declared effect in server-tool-policy.ts (deletes confirmed, writes and outbound requests acting).
 */

export type { Assessment } from "./server-tool-policy";

type Args = Record<string, unknown>;
const NO: Assessment = { ask: false, destructive: false, title: "", detail: "" };

const str = (args: Args, key: string): string => (typeof args[key] === "string" ? (args[key] as string) : "");

function openTarget(args: Args) {
  const raw = str(args, "slug").trim().replace(/^\/?tools\//, "");
  const alias = resolveAlias(raw);
  const tool = findTool(alias?.slug ?? raw);
  const tab = str(args, "tab").trim() || alias?.tab || "";
  return { raw, tool, tab };
}

export function assessCall(name: string, args: Args, rawArgs: string, mode: TrustMode): Assessment {
  if (mode === "free") return NO;
  const detail = describeCall(name, rawArgs);
  // Edits inside the open office document: acting calls; delete / replace-all / overwriting cells are destructive.
  if (isLiveTool(name)) return assessLiveCall(name, args, mode, detail, activeLiveBridge()?.docName ?? "");
  // Calls into the open Craft app: commands and input act; ids that lose work (delete, close, revert…) are destructive.
  if (isCraftTool(name)) return assessCraftCall(name, args, mode, detail);

  switch (name) {
    case "open_tool": {
      const { raw, tool, tab } = openTarget(args);
      const target = tool ? `/tools/${tool.slug}` : null;
      const currentTab = new URLSearchParams(window.location.search).get("tab") ?? "";
      const leaving = target !== window.location.pathname || (tab !== "" && tab !== currentTab);
      if (!leaving) return NO; // already there: nothing to approve
      const where = tool?.name ?? (raw || "a tool");
      if (pageHasUserWork()) {
        return { ask: true, destructive: true, title: ct("Leave this page for {where}?", { where }), detail: ct("Text or files you entered here will be lost.") };
      }
      return mode === "destructive" ? NO : { ask: true, destructive: false, title: ct("Open {where}?", { where }), detail };
    }
    case "fill_field": {
      const id = str(args, "id");
      const clearing = fieldWouldBeCleared(id, typeof args.value === "string" ? args.value : "x");
      if (clearing) return { ask: true, destructive: true, title: ct("Clear this field?"), detail };
      if (fieldWouldBeOverwritten(id, typeof args.value === "string" ? args.value : "")) {
        return { ask: true, destructive: true, title: ct("Replace your text?"), detail: ct("This field holds text you entered; the new value overwrites it.") };
      }
      return mode === "strict" ? { ask: true, destructive: false, title: ct("Fill a field?"), detail } : NO;
    }
    case "upload_file":
      // Attaching replaces the input's file list outright, so a file the user picked themselves would be dropped.
      if (fileInputHoldsUserFiles(str(args, "id"))) {
        return { ask: true, destructive: true, title: ct("Replace your file?"), detail: ct("This file input holds a file you chose; attaching another one replaces it.") };
      }
      return mode === "destructive" ? NO : { ask: true, destructive: false, title: ct("Attach a file?"), detail };
    case "click": {
      const target = describeActionTarget(str(args, "id"));
      if (!target) return NO; // stale id: the tool itself will report it
      if (target.destructive) return { ask: true, destructive: true, title: ct("Click “{label}”?", { label: target.label }), detail: ct("This looks like it deletes, clears or resets something.") };
      // Switching suite tabs unmounts the tool (its input is lost) and sample/restore buttons replace what was typed.
      if (target.kind === "tab" && !target.active && pageHasUserWork()) {
        return { ask: true, destructive: true, title: ct("Switch to “{label}”?", { label: target.label }), detail: ct("Text or files you entered here will be lost.") };
      }
      // A same-tab link to another page or suite tab unmounts the tool just like open_tool does.
      if (target.navigates && pageHasUserWork()) {
        return { ask: true, destructive: true, title: ct("Leave this page via “{value}”?", { value: target.label || "a link" }), detail: ct("Text or files you entered here will be lost.") };
      }
      if (target.overwrites && pageHasUserWork()) {
        return { ask: true, destructive: true, title: ct("Click “{label}”?", { label: target.label }), detail: ct("This replaces the text you entered here.") };
      }
      if (mode === "destructive") return NO;
      const runs = target.kind === "button" || target.kind === "link";
      if (mode === "strict" || runs) return { ask: true, destructive: false, title: ct("Click “{value}”?", { value: target.label || "a control" }), detail };
      return NO; // tabs / toggles in Standard only change the view
    }
    default:
      return NO;
  }
}
