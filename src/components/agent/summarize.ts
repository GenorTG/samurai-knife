import { controlLabel } from "@/lib/agent-client/dom-bridge";
import { ct } from "@/lib/i18n/client-locale";

/** One-line summaries of tool calls and results for the transcript rows (in the interface language: browser only). */

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
    return label ? `"${label}"` : id || ct("control");
  };
  switch (name) {
    case "open_tool":
      return ct("Open {target}", { target: [str("slug"), str("tab")].filter(Boolean).join(" → ") || ct("tool") });
    case "list_tools":
      return str("query") ? ct("Find tools: {query}", { query: clip(str("query"), 40) }) : ct("List tools");
    case "page_snapshot":
      return ct("Read the page");
    case "fill_field":
      return ct("Fill {target} with {value}", { target: target(), value: JSON.stringify(clip(str("value"), 30)) });
    case "click":
      return ct("Click {target}", { target: target() });
    case "read_text":
      return ct("Read {target}", { target: target() });
    case "upload_file":
      return ct("Attach {file} to {target}", { file: str("from_file") ? ct("produced file {id}", { id: str("from_file") }) : str("name") || ct("file"), target: target() });
    case "load_tools":
      return ct("Load {group} tools", { group: str("group") || ct("specialist") });
    case "wait":
      return ct("Wait for the page");
    case "wait_for":
      return ct("Wait for {what}", { what: { busy_done: ct("the page to finish working"), new_file: ct("a file"), idle: ct("the page to go quiet"), change: ct("{target} to change", { target: target() }) }[str("until")] ?? (str("text") || str("regex") ? `“${clip(str("text") || str("regex"), 30)}”` : ct("the page")) });
    case "wait_for_user":
      return ct("Waiting for you: {message}", { message: clip(str("message"), 50) });
    default:
      return name.startsWith("knife_") ? ct("Run {name}", { name: name.slice(6).replace(/_/g, " ") }) : name;
  }
}

export interface ResultSummary {
  ok: boolean;
  text: string;
}

export function summarizeResult(name: string, content: string): ResultSummary {
  const obj = parseObject(content);
  if (!obj) return { ok: true, text: clip(content, 70) || ct("(empty)") };
  if (obj.ok === false || typeof obj.error === "string") {
    return { ok: false, text: clip(String(obj.error ?? ct("failed")), 90) };
  }
  if (name === "page_snapshot") {
    const controls = Array.isArray(obj.controls) ? obj.controls.length : 0;
    const regions = Array.isArray(obj.regions) ? obj.regions.length : 0;
    return { ok: true, text: ct("{controls} controls, {regions} regions", { controls, regions }) };
  }
  if (name === "list_tools") {
    const n = Array.isArray(obj.matches) ? obj.matches.length : obj.matched;
    return { ok: true, text: ct("{n} matches", { n: String(n ?? "?") }) };
  }
  if (name === "open_tool") return { ok: true, text: ct("opened {name}", { name: String(obj.opened ?? "") }) };
  if (name === "fill_field") return { ok: true, text: ct("value {value}", { value: JSON.stringify(clip(String(obj.value ?? ""), 40)) }) };
  if (name === "click") return { ok: true, text: ct("clicked {label}", { label: JSON.stringify(String(obj.label ?? "")) }) };
  if (name === "read_text") return { ok: true, text: ct("{n} chars", { n: String(obj.chars ?? "?") }) };
  if (name === "wait_for_user") return { ok: true, text: ct("resumed by {who}", { who: String(obj.resumed_by ?? ct("you")) }) };
  if (name === "wait_for") return { ok: true, text: obj.timed_out ? ct("timed out after {s} s", { s: String(obj.waited_s) }) : ct("done after {s} s", { s: String(obj.waited_s) }) };
  if (name === "wait") return { ok: true, text: `${String(obj.waitedMs ?? "")} ms` };
  return { ok: true, text: clip(content, 70) };
}
