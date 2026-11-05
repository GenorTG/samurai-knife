// Context management of the assistant (src/lib/agent-client/context.ts): what the model receives of a long chat and how
// the stored transcript is bounded. Regression: a 10-round tool-heavy turn followed by "tak tak." used to reach the model
// as the single message "tak tak." (the trim snapped forward to the next user message and dropped the previous answer).
import { test } from "node:test";
import { clipToolResult } from "../src/lib/agent-client/loop.ts";
import { clipJsonText } from "../src/lib/json-clip.ts";
import assert from "node:assert/strict";
import {
  CONTEXT_CHARS,
  MAX_STORED_MESSAGES,
  RUN_TOOL_CHARS,
  SUMMARY_SENT_CHARS,
  buildContext,
  capTranscript,
  extendsTranscript,
  pickTranscript,
  repairTranscript,
  summarySection,
  toWire,
  turnNote,
  unchangedResult,
  withTurnNote,
} from "../src/lib/agent-client/context.ts";

const PROPOSAL = "Raport gotowy.\n1. Popraw nagłówki.\n2. Dodaj opisy.\nZrobić to wszystko…?";

test("large JSON tool results stay valid and preserve checks when compacted", () => {
  const original = JSON.stringify({
    work: { head: "abc123" },
    pull: { number: 12 },
    checks: { state: "failure", runs: [{ name: "CI", conclusion: "failure" }] },
    compare: { commits: Array.from({ length: 60 }, (_, i) => ({ sha: String(i), message: "commit ".repeat(50) })), files: Array.from({ length: 60 }, (_, i) => ({ path: `src/${i}.tsx`, patch: "diff ".repeat(200) })) },
  });
  const clipped = clipToolResult(original);
  assert.ok(clipped.length <= 12_000);
  const parsed = JSON.parse(clipped);
  assert.equal(parsed.checks.state, "failure");
  assert.equal(parsed.checks.runs[0].name, "CI");
  assert.equal(parsed.work.head, "abc123");
});

test("JSON clipping: knife_site_changes with 60 commits fits 6 kB, keeps checks.state, marks omitted items, terminates on short strings", () => {
  const changes = JSON.stringify({
    work: { branch: "knife/x", head: "f".repeat(40) },
    pull: { number: 7, title: "Update", url: "https://github.com/o/r/pull/7" },
    compare: { aheadBy: 60, commits: Array.from({ length: 60 }, (_, i) => ({ sha: String(i).padStart(40, "0"), message: `fix: step ${i} `.repeat(12) })) },
    checks: { state: "pending", items: [{ name: "Vercel", state: "pending" }], previewUrl: "" },
  });
  const clipped = clipJsonText(changes, 6000);
  assert.ok(clipped.length < 6000, `${clipped.length}`);
  const parsed = JSON.parse(clipped);
  assert.equal(parsed.checks.state, "pending");
  assert.ok(parsed.compare.commits.some((c) => typeof c === "string" && /items omitted/.test(c)));
  const many = JSON.stringify({ rows: Array.from({ length: 20_000 }, (_, i) => ({ i, k: "abc" })), tail: { state: "ok" } });
  const started = Date.now();
  const small = JSON.parse(clipJsonText(many, 20_000));
  assert.ok(Date.now() - started < 3000, "bulk thinning stays fast");
  assert.equal(small.tail.state, "ok");
  // Only short strings and no arrays: no growth loop, a bounded error instead.
  const flat = JSON.stringify(Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, "x".repeat(150)])));
  assert.match(JSON.parse(clipJsonText(flat, 2000)).error, /could not be compacted/);
  assert.match(clipJsonText("plain ".repeat(5000), 1000), /truncated, 30000 chars total/);
});

test("malformed persisted tool arguments are repaired before provider replay", () => {
  const repaired = repairTranscript([
    { role: "user", content: "write this" },
    { role: "assistant", content: null, tool_calls: [{ id: "truncated", type: "function", function: { name: "knife_site_write", arguments: '{"path":"index.html","content":"cut' } }] },
  ]);
  assert.equal(repaired[1].tool_calls[0].function.arguments, "{}");
  assert.equal(toWire(repaired)[1].tool_calls[0].function.arguments, "{}");
});

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

test("a failed turn's request and reason reach the next model context", () => {
  const context = buildContext([
    { role: "user", content: "finish the website fixes" },
    { role: "notice", level: "error", content: "Model request failed: network timeout" },
    { role: "user", content: "back to work!" },
  ]);
  assert.ok(context.messages.some((message) => message.role === "assistant" && message.content.includes("previous turn ended: Model request failed: network timeout") && message.content.includes("unfinished request: finish the website fixes")));
});

test("a short follow-up after a tool-heavy turn still carries the previous answer", () => {
  const transcript = [...toolTurn("t1", 10, 12_000, PROPOSAL), { role: "user", content: "tak tak." }];
  const context = buildContext(transcript);
  const roles = context.messages.map((m) => m.role);
  assert.equal(roles[0], "user");
  assert.equal(context.messages.at(-1).content, "tak tak.");
  assert.ok(context.messages.some((m) => m.role === "assistant" && m.content === PROPOSAL), "previous answer kept verbatim");
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
  for (let i = 0; i < 50; i += 1) transcript.push(...toolTurn(`t${i}`, 3, 4_000, `answer ${i}`));
  transcript.push({ role: "user", content: "and now?" });
  const context = buildContext(transcript);
  const size = context.messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  assert.ok(size <= CONTEXT_CHARS + 2_000, `bounded (${size})`);
  assert.ok(context.summary.length <= SUMMARY_SENT_CHARS);
  assert.ok(context.messages.some((m) => m.content === "answer 49"));
  assert.ok(context.summary && context.summary.includes("t0 request"), "oldest turns live on in the summary");
  assert.match(summarySection(context.summary), /Earlier in this conversation/);
});

test("earlier turns stay byte-identical while the running turn grows (the cached prefix)", () => {
  const earlier = [];
  for (let i = 0; i < 6; i += 1) earlier.push(...toolTurn(`t${i}`, 2, 2_000, `answer ${i}`));
  const start = [...earlier, { role: "user", content: "now" }];
  const before = buildContext(start);
  const grown = buildContext([...start, ...toolTurn("x", 3, 20_000, "partial").slice(1)]);
  assert.deepEqual(grown.messages.slice(0, before.messages.length), before.messages);
  assert.equal(grown.summary, before.summary);
});

test("a previous turn too big to send whole keeps its question and answer, without a notice", () => {
  const context = buildContext([...toolTurn("big", 4, 8_000, "the answer"), { role: "user", content: "ok" }]);
  assert.deepEqual(context.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(context.messages[1].content, "the answer");
  assert.equal(context.shortened, false, "routine compaction says nothing; only turns that left the messages do");
});

const runningTurn = (results, size) => {
  const out = [{ role: "user", content: "go" }];
  for (let i = 0; i < results; i += 1) {
    out.push({ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "knife_site_read", arguments: JSON.stringify({ path: `f${i}`, pad: i === 0 ? "z".repeat(5_000) : "" }) } }] });
    out.push({ role: "tool", tool_call_id: `c${i}`, content: JSON.stringify({ ok: true, new_files: i === 0 ? [{ id: "f1" }] : undefined, text: "r".repeat(size) }) });
  }
  return out;
};
const results = (messages) => messages.filter((m) => m.role === "tool");

test("a small running turn is sent whole, however many rounds", () => {
  const wire = toWire(runningTurn(30, 1_000));
  assert.ok(results(wire).every((m) => m.content.length > 1_000));
});

test("a big running turn shortens older results, newest stay whole, in steps", () => {
  const big = Math.ceil(RUN_TOOL_CHARS / 8);
  const wire = toWire(runningTurn(15, big));
  const r = results(wire);
  assert.equal(r.filter((m) => m.content.includes('"shortened"')).length, 8, "(15 - 6) rounded down to a step of 4");
  assert.ok(r.slice(-6).every((m) => !m.content.includes('"shortened"')));
  assert.ok(JSON.parse(r[0].content).new_files, "a produced file stays known");
  const calls = wire.filter((m) => m.role === "assistant");
  assert.match(calls[0].tool_calls[0].function.arguments, /omitted/, "long arguments of an old call go too");
  JSON.parse(calls[0].tool_calls[0].function.arguments);
  // Same boundary one round later: the prefix up to there is unchanged.
  const next = toWire(runningTurn(16, big));
  assert.deepEqual(results(next).slice(0, 8), r.slice(0, 8));
});

test("a result an \"unchanged\" points at is never shortened or dropped", () => {
  const turn = runningTurn(15, Math.ceil(RUN_TOOL_CHARS / 8));
  turn.at(-1).content = unchangedResult("c0");
  const r = results(toWire(turn));
  assert.ok(!r[0].content.includes('"shortened"'));
  const snap = [
    { role: "user", content: "go" },
    { role: "assistant", content: null, tool_calls: [{ id: "s1", type: "function", function: { name: "page_snapshot", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "s1", content: JSON.stringify({ ok: true, controls: ["a"] }) },
    { role: "assistant", content: null, tool_calls: [{ id: "s2", type: "function", function: { name: "page_snapshot", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "s2", content: unchangedResult("s1") },
  ];
  assert.match(toWire(snap)[2].content, /controls/, "the snapshot it points at is not slimmed away");
});

test("the turn note goes on the turn's first user message, once, and not into the transcript", () => {
  const first = { role: "user", content: "hello" };
  const transcript = [{ role: "user", content: "old" }, { role: "assistant", content: "a" }, first, { role: "assistant", content: "b" }];
  const note = turnNote({ pathname: "/tools/json", accountName: "genor", recentActions: Array.from({ length: 30 }, (_, i) => `step ${i}`), summary: "- User: x" });
  assert.match(note, /not written by the user/);
  assert.match(note, /\/tools\/json/);
  assert.match(note, /step 29/);
  assert.doesNotMatch(note, /step 21\b/, "only the newest lines");
  assert.match(note, /Earlier in this conversation/);
  const wire = withTurnNote(toWire(transcript), first, note);
  assert.equal(wire.filter((m) => m.content?.includes("not written by the user")).length, 1);
  assert.equal(wire[2].content, `hello\n\n${note}`);
  assert.equal(first.content, "hello");
  assert.equal(withTurnNote(toWire(transcript), { role: "user", content: "gone" }, "N").at(-2).content, "hello\n\nN");
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
