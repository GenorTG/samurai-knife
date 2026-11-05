// Repetition inside one assistant run (src/lib/agent-client/repeat-guard.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { REPEAT_STOP, REPEAT_WARN, createRepeatGuard } from "../src/lib/agent-client/repeat-guard.ts";

const BIG = "x".repeat(500);
const reads = createRepeatGuard.bind(null, (name) => name === "page_snapshot");

test("an identical read-only result becomes a pointer to the first one", () => {
  const g = reads();
  assert.equal(g.check("a", "page_snapshot", "{}", BIG).content, BIG);
  const second = JSON.parse(g.check("b", "page_snapshot", "{}", BIG).content);
  assert.equal(second.ok, true);
  assert.equal(second.unchanged, true);
  assert.equal(second.same_as, "a");
});

test("a changed result resets it, and argument order does not matter", () => {
  const g = reads();
  g.check("a", "page_snapshot", '{"x":1,"y":2}', BIG);
  assert.equal(JSON.parse(g.check("b", "page_snapshot", '{"y":2,"x":1}', BIG).content).same_as, "a");
  assert.equal(g.check("c", "page_snapshot", '{"x":1,"y":2}', `${BIG}!`).content, `${BIG}!`);
  assert.equal(JSON.parse(g.check("d", "page_snapshot", '{"x":1,"y":2}', `${BIG}!`).content).same_as, "c");
  assert.equal(g.check("e", "page_snapshot", '{"x":2,"y":2}', BIG).content, BIG, "other arguments, another call");
});

test("short results and acting tools keep their result until the guard speaks", () => {
  const g = reads();
  g.check("a", "page_snapshot", "{}", "short");
  assert.equal(g.check("b", "page_snapshot", "{}", "short").content, "short");
  g.check("c", "click", '{"id":"k"}', BIG);
  assert.equal(g.check("d", "click", '{"id":"k"}', BIG).content, BIG);
});

test("repeating is refused at REPEAT_WARN and ends the run at REPEAT_STOP", () => {
  const g = reads();
  let last;
  for (let i = 1; i <= REPEAT_STOP; i += 1) {
    last = g.check(`c${i}`, "click", '{"id":"k"}', BIG);
    if (i < REPEAT_WARN) assert.equal(last.content, BIG);
    else assert.match(JSON.parse(last.content).error, /Stop repeating/);
    assert.equal(last.stop, i === REPEAT_STOP);
  }
});

test("waiting tools may repeat: the same answer means not yet", () => {
  const g = reads();
  for (let i = 0; i < 10; i += 1) {
    const r = g.check(`w${i}`, "wait_for", '{"until":"busy_done"}', BIG);
    assert.equal(r.content, BIG);
    assert.equal(r.stop, false);
  }
});

test("reset forgets", () => {
  const g = reads();
  g.check("a", "page_snapshot", "{}", BIG);
  g.reset();
  assert.equal(g.check("b", "page_snapshot", "{}", BIG).content, BIG);
});
