import type { KnifeToolEffectInfo } from "@/lib/mcp/define";
import type { TrustMode } from "./interaction";

/**
 * Approval rules for the server-side knife_* tools, derived from the effect each tool declares (src/lib/mcp/define.ts),
 * never from its name. Threat: a prompt-injected model (instructions hidden in a fetched posting or page) deleting the
 * user's data or sending it out through a URL argument. Pure (no DOM): unit-tested in node.
 *  - read: never asks.
 *  - write: asks in All / Most (it "runs" something); free in Risky / None.
 *  - destructive (or a write whose arguments make it one): asks in every mode but None, never waived by "allow this run".
 *  - outbound: shows the destination; asks in All / Most. After third-party content entered this turn, a host the user
 *    did not name in this turn's messages asks in every mode but None, as destructive (an exfiltration channel).
 */

export interface Assessment {
  ask: boolean;
  /** Shown as a warning and never covered by "allow this run". */
  destructive: boolean;
  title: string;
  detail: string;
}

/** What the run knows about the current turn (since the user's message that started it). */
export interface TurnContext {
  /** Texts the user wrote in this turn (the prompt and any steering). */
  userTexts: string[];
  /** A tool result in this turn carried third-party text (an untrusted envelope, a page read). */
  untrustedSeen: boolean;
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

/** Hosts the user named in this turn: URLs and bare domains in their own messages. */
export function mentionedHosts(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
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
  if (!info) return { ask: true, destructive: false, title: `Run “${label(name)}”?`, detail: describeArgs(args) };
  const urlArgs = info.urlArgs ?? [];
  const detail = describeArgs(args, urlArgs);
  if (info.effect === "destructive" || destructiveByArgs(info, args)) {
    return { ask: true, destructive: true, title: `Run “${label(name)}”?`, detail: `This deletes or replaces your data. ${detail}` };
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
          title: `Send a request to ${unnamed.join(", ")}?`,
          detail: `Third-party text was read earlier in this turn and you did not name this address; a request there could carry your data out. ${detail}`,
        };
      }
      return mode === "destructive" ? NO : { ask: true, destructive: false, title: `Fetch from ${hosts.join(", ")}?`, detail };
    }
    // An outbound tool given pasted text instead of an address only saves it: a write.
  }
  if (info.effect === "outbound" || info.effect === "write") {
    return mode === "destructive" ? NO : { ask: true, destructive: false, title: `Run “${label(name)}”?`, detail };
  }
  return NO;
}
