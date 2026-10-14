/**
 * Pure logic behind the `wait_for` UI tool: parse the model's arguments into a condition and decide,
 * from periodic observations of the page, when it holds. No DOM access here (the observations are
 * gathered in dom-bridge.ts), so the rules are unit-testable under plain node.
 */

export const MAX_WAIT_FOR_MS = 120_000;
export const DEFAULT_WAIT_FOR_MS = 60_000;
export const DEFAULT_IDLE_MS = 1500;
/** How long a busy indicator may take to show up after the action that starts the work. */
export const BUSY_GRACE_MS = 1500;
/** The busy indicator must stay gone this long (status lines flicker between steps). */
export const BUSY_GONE_MS = 400;

export type WaitKind = "new_file" | "text" | "change" | "busy_done" | "idle";
export const WAIT_KINDS: readonly WaitKind[] = ["new_file", "text", "change", "busy_done", "idle"];

export interface WaitCondition {
  kind: WaitKind;
  /** Scope for text/change: a control (c..) or region (r..) id from the latest snapshot. */
  id?: string;
  /** Case-insensitive substring for kind "text". */
  text?: string;
  regex?: RegExp;
  idleMs: number;
  timeoutMs: number;
}

export type ParsedWait = { ok: true; cond: WaitCondition } | { ok: false; error: string };

type Args = Record<string, unknown>;

const str = (args: Args, key: string): string => (typeof args[key] === "string" ? (args[key] as string).trim() : "");
const num = (args: Args, key: string): number | null => (typeof args[key] === "number" && Number.isFinite(args[key]) ? (args[key] as number) : null);

const USAGE =
  'wait_for needs {"until": "busy_done" | "new_file" | "text" | "change" | "idle"}: busy_done = progress/status line is gone, new_file = a tool produced a download, text = {text|regex} appears (optionally scoped by id), change = the control/region {id} changes, idle = nothing on the page changes for idle_ms. Optional timeout_s (1-120).';

export function parseWaitFor(args: Args): ParsedWait {
  const text = str(args, "text");
  const regexSource = str(args, "regex");
  const id = str(args, "id");
  let kind = str(args, "until") as WaitKind | "";
  if (!kind) kind = text || regexSource ? "text" : id ? "change" : "";
  if (!kind || !WAIT_KINDS.includes(kind)) return { ok: false, error: USAGE };

  const timeoutS = num(args, "timeout_s");
  const timeoutMs = timeoutS === null ? DEFAULT_WAIT_FOR_MS : Math.max(1000, Math.min(MAX_WAIT_FOR_MS, Math.floor(timeoutS * 1000)));
  const idleRaw = num(args, "idle_ms");
  const idleMs = idleRaw === null ? DEFAULT_IDLE_MS : Math.max(200, Math.min(30_000, Math.floor(idleRaw)));
  const cond: WaitCondition = { kind, idleMs, timeoutMs, ...(id ? { id } : {}) };

  if (kind === "text") {
    if (!text && !regexSource) return { ok: false, error: 'until "text" needs {"text": string} or {"regex": string}.' };
    if (regexSource) {
      try {
        cond.regex = new RegExp(regexSource, "i");
      } catch {
        return { ok: false, error: `Invalid regex: ${regexSource}` };
      }
    } else cond.text = text;
  }
  if (kind === "change" && !id) return { ok: false, error: 'until "change" needs {"id": string} (a control or region id from the latest snapshot).' };
  return { ok: true, cond };
}

/** The thing being waited for, as a phrase: "Waiting for <phrase> (12 s)". */
export function describeWait(cond: WaitCondition, label?: string | null): string {
  const scope = cond.id ? ` in ${label ? `“${label}”` : cond.id}` : "";
  switch (cond.kind) {
    case "new_file":
      return "a file to be produced";
    case "text":
      return `${cond.regex ? `/${cond.regex.source}/` : `“${(cond.text ?? "").slice(0, 40)}”`} to appear${scope}`;
    case "change":
      return `${label ? `“${label}”` : (cond.id ?? "the page")} to change`;
    case "busy_done":
      return "the page to finish working";
    case "idle":
      return "the page to go quiet";
  }
}

export function waitingLabel(cond: WaitCondition, elapsedMs: number, label?: string | null): string {
  return `Waiting for ${describeWait(cond, label)} (${Math.floor(elapsedMs / 1000)} s)`;
}

/** What the DOM side saw at one instant. */
export interface WaitObservation {
  elapsedMs: number;
  /** ms since the last relevant DOM mutation (the wait start counts as one). */
  sinceMutationMs: number;
  /** Fetches still in flight. */
  inflight: number;
  /** Visible busy indicators: status lines, unfinished <progress>, aria-busy, disabled "Working…" buttons. */
  busy: string[];
  /** Text/value of the scoped control or region, the whole page when no id; null when the id is gone. */
  scope: string | null;
  /** Ids of files produced so far this session. */
  fileIds: string[];
}

export interface WaitVerdict {
  met: boolean;
  /** Plain-language reason it is met (or why it returned early). */
  reason?: string;
}

/** Stateful because several conditions are transitions (appeared, then went away), not levels. */
export class WaitEvaluator {
  private baselineScope: string | null | undefined;
  private baselineFiles: Set<string> | undefined;
  private seenBusy = false;
  private goneSince: number | null = null;

  readonly cond: WaitCondition;

  constructor(cond: WaitCondition) {
    this.cond = cond;
  }

  check(obs: WaitObservation): WaitVerdict {
    const c = this.cond;
    switch (c.kind) {
      case "new_file": {
        this.baselineFiles ??= new Set(obs.fileIds);
        const fresh = obs.fileIds.filter((f) => !this.baselineFiles?.has(f));
        return fresh.length ? { met: true, reason: `produced ${fresh.join(", ")}` } : { met: false };
      }
      case "text": {
        if (obs.scope === null) return { met: false };
        const hit = c.regex ? c.regex.test(obs.scope) : obs.scope.toLowerCase().includes((c.text ?? "").toLowerCase());
        return hit ? { met: true, reason: obs.elapsedMs < 400 ? "already on the page" : "appeared" } : { met: false };
      }
      case "change": {
        if (this.baselineScope === undefined) {
          this.baselineScope = obs.scope;
          return { met: false };
        }
        if (obs.scope === this.baselineScope) return { met: false };
        return { met: true, reason: obs.scope === null ? "it disappeared from the page" : "changed" };
      }
      case "busy_done": {
        if (obs.busy.length) {
          this.seenBusy = true;
          this.goneSince = null;
          return { met: false };
        }
        if (!this.seenBusy) {
          return obs.elapsedMs >= BUSY_GRACE_MS ? { met: true, reason: "no busy indicator was showing (nothing to wait for)" } : { met: false };
        }
        this.goneSince ??= obs.elapsedMs;
        return obs.elapsedMs - this.goneSince >= BUSY_GONE_MS ? { met: true, reason: "the busy indicator went away" } : { met: false };
      }
      case "idle":
        return obs.sinceMutationMs >= c.idleMs && obs.inflight === 0 ? { met: true, reason: `quiet for ${c.idleMs} ms` } : { met: false };
    }
  }
}

/** Text that marks a status line or button as "still working" (as opposed to a finished notice). */
export const BUSY_TEXT = /…|\.\.\.|\b(loading|working|running|processing|converting|compressing|recogni[sz]ing|starting|uploading|downloading|please wait|in progress)\b|\b\d{1,3}\s?%/i;
