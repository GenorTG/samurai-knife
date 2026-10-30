import type { NoticeMessage, SummaryNotice, ToolMessage, TranscriptMessage, WireMessage } from "./types";

/**
 * Context management for the assistant (docs/ARCHITECTURE.md "Assistant context"): what the model sees of a long chat,
 * and how the stored transcript is bounded. Pure functions, shared by the loop and the widget's storage.
 *
 * Rules:
 *  - the running turn (the last user message and everything after it) is always sent whole;
 *  - earlier turns are sent whole while they fit, then compacted to their user message + final answer (tool calls and
 *    tool output dropped), then summarised (excerpts) into the system prompt;
 *  - the previous turn's final answer is never dropped, whatever its size (a short follow-up like "yes" refers to it);
 *  - the stored transcript keeps at most MAX_STORED_MESSAGES / MAX_STORED_CHARS; what falls off becomes one stored
 *    summary notice at the top (level "summary"), shown as "Older messages summarised" and fed to the model.
 */

export const MAX_STORED_MESSAGES = 200;
/** Bounds the server PUT body (4 MiB) with room for JSON escaping and multi-byte text. */
export const MAX_STORED_CHARS = 1_200_000;
export const CONTEXT_MESSAGES = 80;
export const CONTEXT_CHARS = 120_000;
/** Longest stored / sent summary; the newest lines win. */
export const SUMMARY_CHARS = 8_000;
const USER_EXCERPT = 240;
const ANSWER_EXCERPT = 400;

const OMITTED_SNAPSHOT = JSON.stringify({
  ok: true,
  omitted: "Older page snapshot dropped to save context. Call page_snapshot for the current page.",
});

export function isSummaryNotice(message: TranscriptMessage): message is SummaryNotice {
  return message.role === "notice" && message.level === "summary";
}

const interruptedResult = (id: string): ToolMessage => ({
  role: "tool",
  tool_call_id: id,
  content: JSON.stringify({ ok: false, error: "No result recorded (the run was interrupted)." }),
});

/** Make tool_calls / tool results pair up exactly, as providers require. */
export function repairTranscript(messages: TranscriptMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role === "tool") continue; // orphan: real ones are consumed below
    out.push(m);
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const results = new Map<string, ToolMessage>();
    let j = i + 1;
    while (j < messages.length) {
      const next = messages[j];
      if (next.role !== "tool") break;
      results.set(next.tool_call_id, next);
      j += 1;
    }
    for (const call of m.tool_calls) out.push(results.get(call.id) ?? interruptedResult(call.id));
    i = j - 1;
  }
  return out;
}

function sizeOf(m: TranscriptMessage): number {
  const base = m.content?.length ?? 0;
  return m.role === "assistant" ? base + JSON.stringify(m.tool_calls ?? []).length : base;
}

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Split at user messages: [prefix before the first user message, ...turns each starting with a user message]. */
function splitTurns<T extends TranscriptMessage>(messages: T[]): { prefix: T[]; turns: T[][] } {
  const prefix: T[] = [];
  const turns: T[][] = [];
  for (const m of messages) {
    if (m.role === "user") turns.push([m]);
    else if (turns.length > 0) turns[turns.length - 1].push(m);
    else prefix.push(m);
  }
  return { prefix, turns };
}

/** The turn's written answer: the last assistant text without tool calls, else the last assistant text at all. */
function finalAnswer(turn: TranscriptMessage[]): string | null {
  const texts = turn.filter((m): m is Extract<TranscriptMessage, { role: "assistant" }> => m.role === "assistant" && Boolean(m.content?.trim()));
  const plain = texts.filter((m) => !m.tool_calls?.length);
  return (plain.at(-1) ?? texts.at(-1))?.content ?? null;
}

/** One line per turn: what the user asked and how the answer began. */
function summaryLines(turns: TranscriptMessage[][]): string[] {
  return turns.map((turn) => {
    const user = turn[0]?.role === "user" ? oneLine(turn[0].content, USER_EXCERPT) : "";
    const answer = finalAnswer(turn);
    return `- User: ${user}${answer ? ` → Assistant: ${oneLine(answer, ANSWER_EXCERPT)}` : " → (no written answer)"}`;
  });
}

/** Join summary parts and keep the newest lines within SUMMARY_CHARS. */
function boundSummary(parts: string[]): string {
  const lines = parts.flatMap((part) => part.split("\n")).filter((line) => line.trim());
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (size + lines[i].length + 1 > SUMMARY_CHARS) break;
    kept.unshift(lines[i]);
    size += lines[i].length + 1;
  }
  return kept.join("\n");
}

/* ------------------------------------------------------------ stored transcript */

/**
 * Bound the stored transcript (count and size). Never returns an empty transcript for a non-empty one: what falls off
 * the front is folded into one summary notice at the top, and a single turn longer than the bound keeps its user message.
 */
export function capTranscript(messages: TranscriptMessage[], max = MAX_STORED_MESSAGES, maxChars = MAX_STORED_CHARS): TranscriptMessage[] {
  const total = messages.reduce((sum, m) => sum + sizeOf(m), 0);
  if (messages.length <= max && total <= maxChars) return messages;
  const room = Math.max(2, max - 1); // one slot for the summary notice
  let start = messages.length;
  let chars = 0;
  while (start > 0 && messages.length - start < room && chars + sizeOf(messages[start - 1]) <= maxChars) {
    start -= 1;
    chars += sizeOf(messages[start]);
  }
  let cut = start;
  while (cut < messages.length && messages[cut].role !== "user") cut += 1;
  let kept: TranscriptMessage[];
  let dropped: TranscriptMessage[];
  if (cut < messages.length) {
    kept = messages.slice(cut);
    dropped = messages.slice(0, cut);
  } else {
    // The running turn alone is over the bound: keep its user message and the newest whole rounds.
    const lastUser = messages.map((m) => m.role).lastIndexOf("user");
    let tail = Math.max(start, lastUser + 1, messages.length - (room - 1));
    while (tail < messages.length && messages[tail].role === "tool") tail += 1; // never an orphaned tool result
    kept = lastUser >= 0 ? [messages[lastUser], ...messages.slice(tail)] : messages.slice(tail);
    dropped = messages.slice(0, Math.max(0, lastUser));
  }
  const previous = dropped.filter(isSummaryNotice);
  const droppedTurns = splitTurns(dropped.filter((m) => !isSummaryNotice(m))).turns;
  if (droppedTurns.length === 0 && previous.length === 0) return kept;
  const summarised = previous.reduce((sum, n) => sum + (n.summarised ?? 0), 0) + droppedTurns.length;
  const content = boundSummary([...previous.map((n) => n.content), ...summaryLines(droppedTurns)]);
  const notice: SummaryNotice = { role: "notice", level: "summary", content, summarised };
  return [notice, ...kept.filter((m) => !isSummaryNotice(m))];
}

/* ------------------------------------------------------------- model context */

export interface ModelContext {
  /** Wire messages after the system prompt: starts with a user message. */
  messages: WireMessage[];
  /** Older conversation the model gets as text (stored summary + turns that did not fit), or null. */
  summary: string | null;
  /** Earlier turns were shortened (compacted or summarised) for this call. */
  shortened: boolean;
}

function slimSnapshots(wire: WireMessage[]): WireMessage[] {
  const names = new Map<string, string>();
  for (const m of wire) if (m.role === "assistant") for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name);
  const carriesSnapshot = (m: WireMessage): boolean =>
    m.role === "tool" &&
    (names.get(m.tool_call_id) === "page_snapshot" || (names.get(m.tool_call_id) === "open_tool" && m.content.includes('"snapshot":')));
  let lastSnapshot = -1;
  wire.forEach((m, i) => {
    if (carriesSnapshot(m)) lastSnapshot = i;
  });
  return wire.map((m, i): WireMessage => {
    if (m.role !== "tool" || !carriesSnapshot(m) || i === lastSnapshot) return m;
    if (names.get(m.tool_call_id) === "page_snapshot") return { ...m, content: OMITTED_SNAPSHOT };
    try {
      const body = JSON.parse(m.content) as Record<string, unknown>;
      body.snapshot = "omitted (older page snapshot)";
      return { ...m, content: JSON.stringify(body) };
    } catch {
      return m;
    }
  });
}

/** A past turn reduced to its user message and its written answer (tool calls and their output dropped). */
function compactTurn(turn: WireMessage[]): WireMessage[] {
  const answer = finalAnswer(turn);
  return [turn[0], { role: "assistant", content: answer ?? "(This turn ended without a written answer.)" }];
}

/** What the model receives: the running turn whole, earlier turns whole / compacted / summarised (see the file comment). */
export function buildContext(transcript: TranscriptMessage[]): ModelContext {
  const stored = transcript.filter(isSummaryNotice).map((n) => n.content);
  const wire = slimSnapshots(repairTranscript(transcript).filter((m): m is WireMessage => m.role !== "notice"));
  const { turns } = splitTurns(wire);
  if (turns.length === 0) return { messages: wire, summary: stored.length ? boundSummary(stored) : null, shortened: false };
  const current = turns[turns.length - 1];
  let chars = current.reduce((sum, m) => sum + sizeOf(m), 0);
  let count = current.length;
  const kept: WireMessage[][] = [];
  let compact = false;
  let index = turns.length - 2;
  for (; index >= 0; index -= 1) {
    const turn = turns[index];
    const forced = index === turns.length - 2; // the previous answer is always sent
    if (!compact) {
      const size = turn.reduce((sum, m) => sum + sizeOf(m), 0);
      if (count + turn.length <= CONTEXT_MESSAGES && chars + size <= CONTEXT_CHARS) {
        kept.unshift(turn);
        chars += size;
        count += turn.length;
        continue;
      }
      compact = true;
    }
    const short = compactTurn(turn);
    const size = short.reduce((sum, m) => sum + sizeOf(m), 0);
    if (forced || (count + short.length <= CONTEXT_MESSAGES && chars + size <= CONTEXT_CHARS)) {
      kept.unshift(short);
      chars += size;
      count += short.length;
      continue;
    }
    break;
  }
  const summarisedTurns = index >= 0 ? turns.slice(0, index + 1) : [];
  const parts = [...stored, ...(summarisedTurns.length ? summaryLines(summarisedTurns) : [])];
  return {
    messages: [...kept.flat(), ...current],
    summary: parts.length ? boundSummary(parts) : null,
    shortened: compact || summarisedTurns.length > 0,
  };
}

/** Wire messages for the model (see buildContext; the summary goes into the system prompt). */
export function toWire(transcript: TranscriptMessage[]): WireMessage[] {
  return buildContext(transcript).messages;
}

/** The system-prompt section that carries the summary of older messages. */
export function summarySection(summary: string | null): string {
  if (!summary) return "";
  return `\n\n## Earlier in this conversation\nOlder messages of this chat are not shown in full; the toolbox kept this summary (user requests and how your answers began, oldest first). Use it for context; ask the user if you need a detail that is missing.\n${summary}`;
}

export type { NoticeMessage };

/* --------------------------------------------------------- local vs server copy */

const keyOf = (m: TranscriptMessage): string => JSON.stringify([
  m.role,
  m.content,
  m.role === "assistant" ? m.tool_calls ?? null : null,
  m.role === "tool" ? m.tool_call_id : null,
  m.role === "notice" ? m.level : null,
]);

/**
 * `longer` holds everything of `shorter` and more after it (summary notices ignored: two copies may be capped at
 * different points). Compares the tail of `shorter` (up to 24 messages) against `longer`.
 */
export function extendsTranscript(longer: TranscriptMessage[], shorter: TranscriptMessage[]): boolean {
  const a = longer.filter((m) => !isSummaryNotice(m)).map(keyOf);
  const b = shorter.filter((m) => !isSummaryNotice(m)).map(keyOf);
  if (b.length === 0) return a.length > 0;
  const tail = b.slice(-24);
  for (let end = a.length - 2; end >= 0; end -= 1) {
    let matched = 0;
    while (matched < tail.length && end - matched >= 0 && a[end - matched] === tail[tail.length - 1 - matched]) matched += 1;
    if (matched === tail.length) return true;
    // `longer` was capped further back than `shorter`: the match runs into its start.
    if (end - matched < 0 && matched >= Math.min(4, tail.length)) return true;
  }
  return false;
}

/**
 * Which copy of a chat to continue from: the one that extends the other (a failed save during a restart leaves the
 * server behind; another browser leaves this one behind); when they diverge, `preferred` wins.
 */
export function pickTranscript(local: TranscriptMessage[], remote: TranscriptMessage[], preferred: "local" | "remote"): { messages: TranscriptMessage[]; from: "local" | "remote" } {
  if (extendsTranscript(local, remote)) return { messages: local, from: "local" };
  if (extendsTranscript(remote, local)) return { messages: remote, from: "remote" };
  if (local.length === 0) return { messages: remote, from: "remote" };
  if (remote.length === 0) return { messages: local, from: "local" };
  return preferred === "local" ? { messages: local, from: "local" } : { messages: remote, from: "remote" };
}
