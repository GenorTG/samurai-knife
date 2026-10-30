// Context management of the assistant (src/lib/agent-client/context.ts): what the model receives of a long chat and how
// the stored transcript is bounded. Regression: a 10-round tool-heavy turn followed by "tak tak." used to reach the model
// as the single message "tak tak." (the trim snapped forward to the next user message and dropped the previous answer).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_CHARS,
  MAX_STORED_MESSAGES,
  buildContext,
  capTranscript,
  extendsTranscript,
  pickTranscript,
  repairTranscript,
  summarySection,
  toWire,
} from "../src/lib/agent-client/context.ts";

const PROPOSAL = "Raport gotowy.\n1. Popraw nagłówki.\n2. Dodaj opisy.\nZrobić to wszystko…?";

function toolTurn(prefix, rounds, size, answer) {
  const out = [{ role: "user", content: `${prefix} request` }];
  for (let i = 0; i < rounds; i += 1) {
    out.push({ role: "assistant", content: null, tool_calls: [{ id: `${prefix}-c${i}`, type: "function", function: { name: "knife_site_page", arguments: "{}" } }] });
    out.push({ role: "tool", tool_call_id: `${prefix}-c${i}`, content: "x".repeat(size) });
  }
  out.push({ role: "assistant", content: answer });
  out.push({ role: "notice", level: "usage", content: `${rounds} rounds` });
  return out;
}

test("a short follow-up after a tool-heavy turn still carries the previous answer", () => {
  const transcript = [...toolTurn("t1", 10, 12_000, PROPOSAL), { role: "user", content: "tak tak." }];
  const context = buildContext(transcript);
  const roles = context.messages.map((m) => m.role);
  assert.equal(roles[0], "user");
  assert.equal(context.messages.at(-1).content, "tak tak.");
  assert.ok(context.messages.some((m) => m.role === "assistant" && m.content === PROPOSAL), "previous answer kept verbatim");
  assert.equal(context.shortened, true);
  // The old turn is compacted, never cut mid-way: no orphan tool results, every assistant tool call answered.
  assert.deepEqual(repairTranscript(context.messages), context.messages);
});

test("small chats are sent whole and unchanged", () => {
  const transcript = [...toolTurn("a", 2, 100, "first"), ...toolTurn("b", 1, 100, "second"), { role: "user", content: "next" }];
  const context = buildContext(transcript);
  assert.equal(context.shortened, false);
  assert.equal(context.summary, null);
  assert.equal(context.messages.length, transcript.filter((m) => m.role !== "notice").length);
});

test("older turns degrade whole -> compact -> summary, newest first", () => {
  const transcript = [];
  for (let i = 0; i < 30; i += 1) transcript.push(...toolTurn(`t${i}`, 3, 4_000, `answer ${i}`));
  transcript.push({ role: "user", content: "and now?" });
  const context = buildContext(transcript);
  const size = context.messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  assert.ok(size <= CONTEXT_CHARS + 20_000, `bounded (${size})`);
  assert.ok(context.messages.some((m) => m.content === "answer 29"));
  assert.ok(context.summary && context.summary.includes("t0 request"), "oldest turns live on in the summary");
  assert.match(summarySection(context.summary), /Earlier in this conversation/);
});

test("a huge previous answer is never dropped", () => {
  const huge = "y".repeat(CONTEXT_CHARS * 2);
  const transcript = [...toolTurn("t1", 2, 10, huge), { role: "user", content: "ok" }];
  const wire = toWire(transcript);
  assert.ok(wire.some((m) => m.content === huge));
});

test("capTranscript folds what falls off into one stored summary notice", () => {
  const transcript = [];
  for (let i = 0; i < 60; i += 1) transcript.push(...toolTurn(`t${i}`, 1, 10, `answer ${i}`));
  const capped = capTranscript(transcript);
  assert.ok(capped.length <= MAX_STORED_MESSAGES);
  assert.equal(capped[0].role, "notice");
  assert.equal(capped[0].level, "summary");
  assert.ok(capped[0].summarised > 0);
  assert.equal(capped[1].role, "user");
  // Idempotent and the summary reaches the model.
  assert.deepEqual(capTranscript(capped), capped);
  const context = buildContext([...capped, { role: "user", content: "x" }]);
  assert.ok(context.summary.includes("t0 request"));
  // Capping again merges the old summary instead of losing it.
  const more = capTranscript([...capped, ...toolTurn("late", 1, 10, "late answer"), ...toolTurn("later", 30, 10, "z")]);
  assert.equal(more.filter((m) => m.role === "notice" && m.level === "summary").length, 1);
  assert.ok(more[0].content.includes("t0 request") || more[0].summarised > capped[0].summarised);
});

test("a single turn longer than the cap keeps its user message (never an empty transcript)", () => {
  const turn = toolTurn("big", 150, 10, "done");
  const capped = capTranscript(turn);
  assert.ok(capped.length > 0 && capped.length <= MAX_STORED_MESSAGES);
  assert.equal(capped[0].role, "user");
  assert.notEqual(capped[1].role, "tool");
  assert.equal(capped.at(-1).role, "notice");
});

test("capTranscript bounds the size too", () => {
  const transcript = [];
  for (let i = 0; i < 20; i += 1) transcript.push(...toolTurn(`t${i}`, 2, 50_000, `answer ${i}`));
  const capped = capTranscript(transcript);
  const chars = capped.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  assert.ok(chars <= 1_200_000 + 10_000, String(chars));
  assert.equal(capped[0].level, "summary");
});

test("pickTranscript continues from the copy that holds more", () => {
  const base = toolTurn("a", 1, 10, "first");
  const ahead = [...base, { role: "user", content: "second" }, { role: "assistant", content: "second answer" }];
  assert.equal(extendsTranscript(ahead, base), true);
  assert.equal(extendsTranscript(base, ahead), false);
  assert.equal(extendsTranscript(base, base), false);
  assert.equal(pickTranscript(ahead, base, "remote").from, "local", "server lagging after a failed save");
  assert.equal(pickTranscript(base, ahead, "local").from, "remote", "another browser went on");
  const other = [{ role: "user", content: "different" }, { role: "assistant", content: "chat" }];
  assert.equal(pickTranscript(other, base, "remote").from, "remote");
  assert.equal(pickTranscript([], base, "local").from, "remote");
  // A capped copy (summary notice first) still matches the full one it came from.
  const capped = [{ role: "notice", level: "summary", content: "- User: old", summarised: 3 }, ...ahead.slice(3)];
  assert.equal(extendsTranscript([...capped, { role: "user", content: "third" }], ahead), true);
});
