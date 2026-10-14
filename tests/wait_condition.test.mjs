// Unit tests for the wait_for condition logic (src/lib/agent-client/wait-condition.ts): argument parsing and the
// stateful evaluator, driven by hand-built observations (no DOM).
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/wait_condition.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  BUSY_GONE_MS,
  BUSY_GRACE_MS,
  BUSY_TEXT,
  MAX_WAIT_FOR_MS,
  WaitEvaluator,
  describeWait,
  parseWaitFor,
  waitingLabel,
} from "../src/lib/agent-client/wait-condition.ts";

const obs = (over = {}) => ({ elapsedMs: 0, sinceMutationMs: 0, inflight: 0, busy: [], scope: "", fileIds: [], ...over });
const cond = (args) => {
  const r = parseWaitFor(args);
  assert.ok(r.ok, r.error);
  return r.cond;
};

test("parse: kinds, inference, bounds", () => {
  assert.equal(cond({ until: "busy_done" }).timeoutMs, 60_000);
  assert.equal(cond({ until: "idle", timeout_s: 999 }).timeoutMs, MAX_WAIT_FOR_MS);
  assert.equal(cond({ until: "idle", timeout_s: 0 }).timeoutMs, 1000);
  assert.equal(cond({ until: "idle", idle_ms: 5 }).idleMs, 200);
  assert.equal(cond({ until: "idle" }).idleMs, 1500);
  assert.equal(cond({ text: "done" }).kind, "text");
  assert.equal(cond({ regex: "p\\d+" }).kind, "text");
  assert.equal(cond({ id: "r3" }).kind, "change");
  assert.equal(cond({ until: "text", text: "x", id: "r3" }).id, "r3");
});

test("parse: rejects what cannot be waited for", () => {
  for (const bad of [{}, { until: "forever" }, { until: "text" }, { until: "change" }, { until: "text", regex: "(" }]) {
    const r = parseWaitFor(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.error.length > 10);
  }
});

test("text: substring is case-insensitive, regex matches, already-present is reported", () => {
  const e = new WaitEvaluator(cond({ text: "OCR finished" }));
  assert.equal(e.check(obs({ elapsedMs: 100, scope: "Recognizing page 1 of 2…" })).met, false);
  const hit = e.check(obs({ elapsedMs: 5000, scope: "ocr FINISHED: 1 page" }));
  assert.equal(hit.met, true);
  assert.equal(hit.reason, "appeared");
  assert.equal(new WaitEvaluator(cond({ text: "x" })).check(obs({ elapsedMs: 10, scope: "has x" })).reason, "already on the page");
  const re = new WaitEvaluator(cond({ regex: "page \\d+ of \\d+" }));
  assert.equal(re.check(obs({ scope: "Page 3 of 4: recognizing" })).met, true);
  assert.equal(new WaitEvaluator(cond({ text: "x", id: "r9" })).check(obs({ scope: null })).met, false, "missing scope never matches");
});

test("change: baseline is the first observation; any difference or disappearance counts", () => {
  const e = new WaitEvaluator(cond({ id: "r1" }));
  assert.equal(e.check(obs({ scope: "a" })).met, false);
  assert.equal(e.check(obs({ scope: "a" })).met, false);
  assert.deepEqual(e.check(obs({ scope: "ab" })), { met: true, reason: "changed" });
  const gone = new WaitEvaluator(cond({ id: "r1" }));
  gone.check(obs({ scope: "a" }));
  assert.equal(gone.check(obs({ scope: null })).reason, "it disappeared from the page");
});

test("new_file: only ids that were not there at the start", () => {
  const e = new WaitEvaluator(cond({ until: "new_file" }));
  assert.equal(e.check(obs({ fileIds: ["f1"] })).met, false);
  assert.equal(e.check(obs({ fileIds: ["f1"] })).met, false);
  assert.deepEqual(e.check(obs({ fileIds: ["f1", "f2"] })), { met: true, reason: "produced f2" });
});

test("busy_done: waits through flicker, returns only after the indicator stayed gone", () => {
  const e = new WaitEvaluator(cond({ until: "busy_done" }));
  assert.equal(e.check(obs({ elapsedMs: 0, busy: ["Page 1 of 2: loading"] })).met, false);
  assert.equal(e.check(obs({ elapsedMs: 5000, busy: [] })).met, false, "gone for 0 ms is not enough");
  assert.equal(e.check(obs({ elapsedMs: 5200, busy: ["Page 2 of 2: recognizing"] })).met, false, "flicker resets");
  assert.equal(e.check(obs({ elapsedMs: 9000, busy: [] })).met, false);
  assert.equal(e.check(obs({ elapsedMs: 9000 + BUSY_GONE_MS - 1, busy: [] })).met, false);
  assert.equal(e.check(obs({ elapsedMs: 9000 + BUSY_GONE_MS, busy: [] })).met, true);
});

test("busy_done: nothing ever busy -> returns after the grace period instead of burning the whole timeout", () => {
  const e = new WaitEvaluator(cond({ until: "busy_done" }));
  assert.equal(e.check(obs({ elapsedMs: BUSY_GRACE_MS - 1 })).met, false);
  const v = e.check(obs({ elapsedMs: BUSY_GRACE_MS }));
  assert.equal(v.met, true);
  assert.match(v.reason, /nothing to wait for/);
  const late = new WaitEvaluator(cond({ until: "busy_done" }));
  late.check(obs({ elapsedMs: 900, busy: ["Working…"] }));
  assert.equal(late.check(obs({ elapsedMs: 2000, busy: ["Working…"] })).met, false, "busy that appears inside the grace stays awaited");
});

test("idle: needs quiet DOM and no fetch in flight", () => {
  const e = new WaitEvaluator(cond({ until: "idle", idle_ms: 1000 }));
  assert.equal(e.check(obs({ sinceMutationMs: 999 })).met, false);
  assert.equal(e.check(obs({ sinceMutationMs: 5000, inflight: 1 })).met, false);
  assert.equal(e.check(obs({ sinceMutationMs: 1000 })).met, true);
});

test("labels read as 'Waiting for <condition> (12 s)'", () => {
  assert.equal(waitingLabel(cond({ until: "busy_done" }), 12_400), "Waiting for the page to finish working (12 s)");
  assert.equal(waitingLabel(cond({ text: "OCR finished" }), 3000), "Waiting for “OCR finished” to appear (3 s)");
  assert.equal(describeWait(cond({ id: "r2" }), "OCR text"), "“OCR text” to change");
  assert.equal(describeWait(cond({ until: "new_file" })), "a file to be produced");
});

test("busy text heuristic: progress lines yes, finished notices no", () => {
  for (const busy of ["Recognizing page 1 of 4…", "Page 2 of 4: recognizing text · 37%", "Loading tool…", "Working...", "Converting 40%"]) assert.match(busy, BUSY_TEXT, busy);
  for (const idle of ["OCR finished: 1 page, 84 words.", "Copied", "Ready", "3 files selected"]) assert.doesNotMatch(idle, BUSY_TEXT, idle);
});
