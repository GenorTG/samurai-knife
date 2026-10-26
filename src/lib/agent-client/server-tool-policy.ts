import type { KnifeToolEffectInfo } from "@/lib/mcp/define";
import type { TrustMode } from "./interaction";
import { containsUntrusted } from "@/lib/security/untrusted";
import { ct } from "@/lib/i18n/client-locale";

/**
 * Approval rules for the server-side knife_* tools, derived from the effect each tool declares (src/lib/mcp/define.ts),
 * never from its name. Threat: a prompt-injected model (instructions hidden in a fetched posting or page) deleting the
 * user's data, publishing it, or sending it out through a URL argument. Pure (no DOM): unit-tested in node, and the
 * taint detection (`carriesUntrusted`) is shared with /api/agent/chat, which keeps the conversation's flag.
 *  - read: never asks.
 *  - write: asks in All / Most (it "runs" something); free in Risky / None.
 *  - destructive (or a write whose arguments make it one): asks in every mode but None, never waived by "allow this run".
 *  - outbound: shows the destination; asks in All / Most. Once third-party content entered the CONVERSATION (any earlier
 *    turn too: the flag is sticky until Clear), a host the user did not name asks in every mode but None, as destructive
 *    (an exfiltration channel).
 *  - publishing writes (`publishes`: site commits and pull requests): after third-party content, ask in every mode but
 *    None, as destructive (a channel that publishes injected text or the user's data).
 * "Named" (mentionedHosts): typed by the user in this turn's own messages, outside what looks pasted: fenced code
 * blocks, quote lines (`> …`) and long paragraphs (more than PASTE_CHARS characters or PASTE_LINES lines). A posting
 * pasted into the prompt therefore cannot name its own exfiltration host. Heuristic by design: when unsure, it asks.
 */

export interface Assessment {
  ask: boolean;
  /** Shown as a warning and never covered by "allow this run". */
  destructive: boolean;
  title: string;
  detail: string;
}

/** What the run knows when a call is assessed. */
export interface TurnContext {
  /** Texts the user wrote in this turn (the prompt and any steering). */
  userTexts: string[];
  /** Third-party text entered the conversation (an untrusted envelope, a page read), in this turn or an earlier one. */
  untrustedSeen: boolean;
}

/** Response header of /api/agent/chat: "1" when the conversation holds third-party text (sticky until Clear). */
export const UNTRUSTED_HEADER = "x-knife-untrusted";

/** Page tools whose results show page text that may be third-party (a job posting rendered in the CV studio); every
 *  answer of a Craft app too (its code is third-party, and a project or media file may come from someone else). */
export const PAGE_READS: ReadonlySet<string> = new Set(["page_snapshot", "read_text", "craft_commands", "craft_inspect", "craft_execute", "craft_request", "craft_files"]);

/** The message shapes both the widget transcript and the chat route's body share. */
export type PolicyMessage =
  | { role: "assistant"; tool_calls?: readonly { id: string; function: { name: string } }[] | null }
  | { role: "tool"; tool_call_id: string; content: unknown }
  | { role: string };

/** Did any tool result in `messages` carry third-party text (an envelope, a page read, a tool declaring it)? */
export function carriesUntrusted(messages: readonly PolicyMessage[], effects: Record<string, KnifeToolEffectInfo>): boolean {
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !("tool_calls" in m) || !Array.isArray(m.tool_calls)) continue;
    for (const c of m.tool_calls) names.set(c.id, c.function.name);
  }
  for (const m of messages) {
    if (m.role !== "tool" || !("tool_call_id" in m)) continue;
    const name = names.get(m.tool_call_id) ?? "";
    if ((typeof m.content === "string" && containsUntrusted(m.content)) || PAGE_READS.has(name) || effects[name]?.untrustedOutput) return true;
  }
  return false;
}

type Args = Record<string, unknown>;
const NO: Assessment = { ask: false, destructive: false, title: "", detail: "" };

const label = (name: string): string => name.replace(/^knife_/, "").replace(/_/g, " ");

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** Arguments for the approval card: destinations in full (the user must see where data goes), the rest clipped. */
export function describeArgs(args: Args, urlArgs: readonly string[] = []): string {
  const parts = Object.entries(args).map(([key, value]) => {
    if (urlArgs.includes(key) && typeof value === "string") return `${key}: ${clip(value, 500)}`;
    const shown = typeof value === "string" ? JSON.stringify(clip(value, 60)) : clip(JSON.stringify(value) ?? "", 80);
    return `${key}: ${shown}`;
  });
  return clip(parts.join("; "), 900) || "(no arguments)";
}

const normHost = (host: string): string => host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

/** The host a URL-ish argument points at; null for pasted text (job_fetch takes "URL or text"). */
export function destinationHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v || /\s/.test(v)) return null;
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(v) ? v : /^[a-z0-9-]+(\.[a-z0-9-]+)+(?::\d+)?(\/|$)/i.test(v) ? `https://${v}` : null;
  if (!candidate) return null;
  try {
    const host = new URL(candidate).hostname;
    return host ? normHost(host.replace(/^\[|\]$/g, "")) : null;
  } catch {
    return null;
  }
}

/** A paragraph longer than this (characters or lines) reads as pasted content, not an instruction the user typed. */
export const PASTE_CHARS = 400;
export const PASTE_LINES = 4;

/** The parts of a user message that read as typed instructions: no fenced blocks, quote lines or long paragraphs. */
export function instructionText(text: string): string {
  // Line scan, not a regex over the whole message: linear on any input. An unclosed fence hides the rest (conservative).
  const kept: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) kept.push(/^\s*>/.test(line) ? "" : line);
  }
  return kept
    .join("\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.split("\n").filter((line) => line.trim() !== ""))
    .filter((lines) => lines.length > 0 && lines.length <= PASTE_LINES && lines.join("\n").length <= PASTE_CHARS)
    .map((lines) => lines.join("\n"))
    .join("\n\n");
}

/** Hosts the user named in this turn: URLs and bare domains in the instruction parts of their own messages. */
export function mentionedHosts(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of texts) {
    const text = instructionText(raw);
    for (const m of text.matchAll(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi)) {
      const host = destinationHost(m[0]);
      if (host) out.add(host);
    }
    for (const m of text.matchAll(/(?<![@\w.-])((?:[a-z0-9-]+\.)+[a-z]{2,63})(?![\w-])/gi)) out.add(normHost(m[1]));
  }
  return out;
}

/** Named by the user: the same host, or a subdomain of a domain they named ("example.com" covers jobs.example.com). */
function named(host: string, mentioned: Set<string>): boolean {
  for (const m of mentioned) if (host === m || host.endsWith(`.${m}`)) return true;
  return false;
}

function destructiveByArgs(info: KnifeToolEffectInfo, args: Args): boolean {
  return (info.destructiveWhen ?? []).some(({ arg, when }) => {
    const v = args[arg];
    return when === "true" ? v === true : Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.length > 0;
  });
}

export function assessServerCall(name: string, info: KnifeToolEffectInfo | undefined, args: Args, mode: TrustMode, turn: TurnContext): Assessment {
  if (mode === "free") return NO;
  // No effect known (the catalog could not be loaded): ask, like a write in the strictest reading.
  if (!info) return { ask: true, destructive: false, title: ct("Run “{name}”?", { name: label(name) }), detail: describeArgs(args) };
  const urlArgs = info.urlArgs ?? [];
  const detail = describeArgs(args, urlArgs);
  if (info.effect === "destructive" || destructiveByArgs(info, args)) {
    return { ask: true, destructive: true, title: ct("Run “{name}”?", { name: label(name) }), detail: ct("This deletes or replaces your data. {detail}", { detail }) };
  }
  if (info.effect === "outbound") {
    const hosts = [...new Set(urlArgs.map((key) => destinationHost(args[key])).filter((h): h is string => h !== null))];
    if (hosts.length > 0) {
      const mentioned = mentionedHosts(turn.userTexts);
      const unnamed = hosts.filter((h) => !named(h, mentioned));
      if (turn.untrustedSeen && unnamed.length > 0) {
        return {
          ask: true,
          destructive: true,
          title: ct("Send a request to {unnamed}?", { unnamed: unnamed.join(", ") }),
          detail: ct("Third-party text was read earlier in this conversation and you did not type this address yourself; a request there could carry your data out. {detail}", { detail }),
        };
      }
      return mode === "destructive" ? NO : { ask: true, destructive: false, title: ct("Fetch from {hosts}?", { hosts: hosts.join(", ") }), detail };
    }
    // An outbound tool given pasted text instead of an address only saves it: a write.
  }
  if (info.publishes && turn.untrustedSeen) {
    return {
      ask: true,
      destructive: true,
      title: ct("Run “{name}”?", { name: label(name) }),
      detail: ct("Third-party text was read earlier in this conversation; this writes to your repository outside Smart Knife (check that the content is what you asked for). {detail}", { detail }),
    };
  }
  if (info.effect === "outbound" || info.effect === "write") {
    return mode === "destructive" ? NO : { ask: true, destructive: false, title: ct("Run “{name}”?", { name: label(name) }), detail };
  }
  return NO;
}
