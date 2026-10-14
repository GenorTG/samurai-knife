import { controlLabel } from "@/lib/agent-client/dom-bridge";

/** One-line summaries of tool calls and results for the transcript rows. */

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function summarizeArgs(raw: string): string {
  const obj = parseObject(raw);
  if (!obj) return clip(raw, 60);
  const parts = Object.entries(obj).map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(clip(v, 28)) : JSON.stringify(v)}`);
  return clip(parts.join(" "), 70);
}

/** Human-readable description of what a tool call is about to do. */
export function describeCall(name: string, raw: string): string {
  const obj = parseObject(raw) ?? {};
  const str = (k: string): string => (typeof obj[k] === "string" ? (obj[k] as string) : "");
  const target = (): string => {
    const id = str("id");
    const label = id ? controlLabel(id) : null;
    return label ? `"${label}"` : id || "control";
  };
  switch (name) {
    case "open_tool":
      return `Open ${[str("slug"), str("tab")].filter(Boolean).join(" → ") || "tool"}`;
    case "list_tools":
      return str("query") ? `Find tools: ${clip(str("query"), 40)}` : "List tools";
    case "page_snapshot":
      return "Read the page";
    case "fill_field":
      return `Fill ${target()} with ${JSON.stringify(clip(str("value"), 30))}`;
    case "click":
      return `Click ${target()}`;
    case "read_text":
      return `Read ${target()}`;
    case "upload_file":
      return `Attach ${str("from_file") ? `produced file ${str("from_file")}` : str("name") || "file"} to ${target()}`;
    case "load_tools":
      return `Load ${str("group") || "specialist"} tools`;
    case "wait":
      return "Wait for the page";
    case "wait_for":
      return `Wait for ${{ busy_done: "the page to finish working", new_file: "a file", idle: "the page to go quiet", change: `${target()} to change` }[str("until")] ?? (str("text") || str("regex") ? `“${clip(str("text") || str("regex"), 30)}”` : "the page")}`;
    case "wait_for_user":
      return `Waiting for you: ${clip(str("message"), 50)}`;
    default:
      return name.startsWith("knife_") ? `Run ${name.slice(6).replace(/_/g, " ")}` : name;
  }
}

export interface ResultSummary {
  ok: boolean;
  text: string;
}

export function summarizeResult(name: string, content: string): ResultSummary {
  const obj = parseObject(content);
  if (!obj) return { ok: true, text: clip(content, 70) || "(empty)" };
  if (obj.ok === false || typeof obj.error === "string") {
    return { ok: false, text: clip(String(obj.error ?? "failed"), 90) };
  }
  if (name === "page_snapshot") {
    const controls = Array.isArray(obj.controls) ? obj.controls.length : 0;
    const regions = Array.isArray(obj.regions) ? obj.regions.length : 0;
    return { ok: true, text: `${controls} controls, ${regions} regions` };
  }
  if (name === "list_tools") {
    const n = Array.isArray(obj.matches) ? obj.matches.length : obj.matched;
    return { ok: true, text: `${String(n ?? "?")} matches` };
  }
  if (name === "open_tool") return { ok: true, text: `opened ${String(obj.opened ?? "")}` };
  if (name === "fill_field") return { ok: true, text: `value ${JSON.stringify(clip(String(obj.value ?? ""), 40))}` };
  if (name === "click") return { ok: true, text: `clicked ${JSON.stringify(String(obj.label ?? ""))}` };
  if (name === "read_text") return { ok: true, text: `${String(obj.chars ?? "?")} chars` };
  if (name === "wait_for_user") return { ok: true, text: `resumed by ${String(obj.resumed_by ?? "you")}` };
  if (name === "wait_for") return { ok: true, text: obj.timed_out ? `timed out after ${String(obj.waited_s)} s` : `done after ${String(obj.waited_s)} s` };
  if (name === "wait") return { ok: true, text: `${String(obj.waitedMs ?? "")} ms` };
  return { ok: true, text: clip(content, 70) };
}
