// Unit tests for the assistant run state machine (src/lib/agent-client/runtime-store.ts), no browser.
// node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/agent_runtime_store.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { TRANSITIONS, canTransition, createRuntimeStore, IDLE_RUNTIME } from "../src/lib/agent-client/runtime-store.ts";

const STATES = ["idle", "preparing", "thinking", "tool", "awaiting_approval", "awaiting_user", "summarising", "stopping"];

// The oracle is written out here on purpose, independently of the table in the source.
const LEGAL = new Set([
  "idle>preparing",
  "preparing>thinking", "preparing>stopping", "preparing>idle",
  "thinking>tool", "thinking>summarising", "thinking>stopping", "thinking>idle",
  "tool>thinking", "tool>awaiting_approval", "tool>awaiting_user", "tool>summarising", "tool>stopping", "tool>idle",
  "awaiting_approval>tool", "awaiting_approval>stopping", "awaiting_approval>idle",
  "awaiting_user>tool", "awaiting_user>stopping", "awaiting_user>idle",
  "summarising>stopping", "summarising>idle",
  "stopping>idle",
]);

function fresh() {
  const illegal = [];
  const store = createRuntimeStore({ onIllegal: (from, to) => illegal.push(`${from}>${to}`) });
  return { store, illegal };
}

/** Drive a fresh store into `state` through legal moves only. */
function into(store, state) {
  const path = {
    idle: [],
    preparing: ["preparing"],
    thinking: ["preparing", "thinking"],
    tool: ["preparing", "thinking", "tool"],
    awaiting_approval: ["preparing", "thinking", "tool", "awaiting_approval"],
    awaiting_user: ["preparing", "thinking", "tool", "awaiting_user"],
    summarising: ["preparing", "thinking", "summarising"],
    stopping: ["preparing", "thinking", "stopping"],
  }[state];
  for (const step of path) {
    if (step === "preparing") store.begin();
    else if (step === "awaiting_approval") store.enterAwaiting("awaiting_approval", { title: "t", detail: "d" });
    else if (step === "awaiting_user") store.enterAwaiting("awaiting_user", { message: "m", targetId: null, targetLabel: null });
    else if (step === "stopping") store.stop();
    else assert.equal(store.advance(step), true, `advance to ${step}`);
  }
  assert.equal(store.get().run, state);
}

test("the transition table equals the written-out oracle (all 64 pairs)", () => {
  for (const from of STATES) {
    for (const to of STATES) {
      const expected = from === to || LEGAL.has(`${from}>${to}`);
      assert.equal(canTransition(from, to), expected, `${from} -> ${to}`);
    }
  }
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...STATES].sort());
});

test("every legal pair works on a live store and every illegal one is rejected, reported, and changes nothing", () => {
  for (const from of STATES) {
    for (const to of STATES) {
      if (from === to) continue;
      const { store, illegal } = fresh();
      into(store, from);
      const before = store.get();
      // `advance` drops late events while idle/stopping silently; `stop`/`end`/`enterAwaiting` have their own entry points.
      let ok;
      if (to === "stopping") ok = store.stop();
      else if (to === "idle") ok = (store.end(), true);
      else if (to === "awaiting_approval") ok = store.enterAwaiting("awaiting_approval", { title: "t", detail: "d" });
      else if (to === "awaiting_user") ok = store.enterAwaiting("awaiting_user", { message: "m", targetId: null, targetLabel: null });
      else if (to === "preparing") { store.begin(); ok = store.get().run === "preparing"; }
      else ok = store.advance(to);
      const legal = LEGAL.has(`${from}>${to}`);
      if (to === "preparing" && from !== "idle") {
        // begin() is the one entry point with a recovery: report, reset, start clean.
        assert.deepEqual(illegal, [`${from}>preparing`], `${from}->preparing reported`);
        assert.equal(store.get().run, "preparing");
        continue;
      }
      if (from === "idle" && to !== "preparing" && to !== "idle") {
        assert.equal(ok, false, `${from}->${to} refused`);
        assert.equal(store.get().run, "idle");
      } else if (from === "stopping" && !["idle", "stopping"].includes(to)) {
        assert.equal(ok, false, `stopping->${to} dropped`);
        assert.equal(store.get().run, "stopping");
        assert.deepEqual(illegal, [], "late progress after Stop is silent, not an error");
      } else if (legal) {
        assert.equal(store.get().run, to, `${from}->${to}`);
        assert.deepEqual(illegal, []);
      } else {
        assert.equal(ok, false, `${from}->${to} must be refused`);
        assert.equal(store.get().run, from, `${from}->${to} must leave the state alone`);
        assert.deepEqual(illegal, [`${from}>${to}`]);
        assert.equal(store.get().steps, before.steps);
      }
    }
  }
});

test("a full run: idle -> preparing -> thinking -> tool -> awaiting_approval -> tool -> thinking -> idle", () => {
  const { store, illegal } = fresh();
  const seen = [store.get().run];
  store.subscribe(() => { if (store.get().run !== seen.at(-1)) seen.push(store.get().run); });
  store.begin();
  store.advance("thinking");
  store.appendDraft("hel");
  assert.equal(store.get().writing, true);
  store.stepStarted("c1", "click", "Clicking");
  store.advance("tool");
  assert.equal(store.get().writing, false, "writing is a sub-state of thinking only");
  assert.equal(store.enterAwaiting("awaiting_approval", { title: "Click Delete", detail: "x", destructive: true }), true);
  assert.equal(store.get().approval?.title, "Click Delete");
  store.leaveAwaiting("awaiting_approval");
  assert.equal(store.get().approval, null);
  store.stepFinished("c1", true);
  store.advance("thinking");
  store.end();
  assert.deepEqual(seen, ["idle", "preparing", "thinking", "tool", "awaiting_approval", "tool", "thinking", "idle"]);
  assert.deepEqual(illegal, []);
  assert.equal(store.get().draft, "");
});

test("parking is only possible from a running tool step", () => {
  const { store, illegal } = fresh();
  assert.equal(store.enterAwaiting("awaiting_approval", { title: "t", detail: "d" }), false);
  store.begin();
  store.advance("thinking");
  assert.equal(store.enterAwaiting("awaiting_user", { message: "m", targetId: null, targetLabel: null }), false);
  assert.equal(store.get().wait, null);
  assert.equal(illegal.length, 2);
});

test("Stop while parked: the card goes away at once, the park's later release is a no-op", () => {
  const { store, illegal } = fresh();
  into(store, "awaiting_user");
  assert.notEqual(store.get().wait, null);
  assert.equal(store.stop(), true);
  assert.equal(store.get().run, "stopping");
  assert.equal(store.get().wait, null);
  store.leaveAwaiting("awaiting_user"); // the abort handler of the wait runs afterwards
  assert.equal(store.get().run, "stopping");
  assert.equal(store.advance("thinking"), false); // late stream event
  store.appendDraft("late");
  assert.equal(store.get().draft, "");
  store.end();
  assert.equal(store.get().run, "idle");
  assert.deepEqual(illegal, []);
});

test("begin() on a run that never ended is reported and recovers", () => {
  const { store, illegal } = fresh();
  into(store, "tool");
  store.stepStarted("a", "click", "x");
  store.begin();
  assert.deepEqual(illegal, ["tool>preparing"]);
  assert.equal(store.get().run, "preparing");
  assert.deepEqual(store.get().steps, []);
});

test("summarising comes from thinking or tool and only leaves by stop/end", () => {
  const { store } = fresh();
  into(store, "tool");
  assert.equal(store.advance("summarising"), true);
  assert.equal(store.advance("tool"), false);
  assert.equal(store.get().run, "summarising");
});

test("subscribers are notified once per real change, never for a no-op", () => {
  const { store } = fresh();
  let n = 0;
  store.subscribe(() => { n += 1; });
  store.clearSteps(); // already empty
  store.setActivity(null); // already null
  assert.equal(n, 0);
  store.setActivity("x");
  store.setLock("other", "busy");
  store.setLock("other", "busy");
  assert.equal(n, 2);
  store.setLock("free");
  assert.equal(store.get().remoteActivity, null, "remote activity is dropped with the lock");
});

test("the server snapshot is idle and untouched by any store", () => {
  const { store } = fresh();
  store.begin();
  assert.equal(IDLE_RUNTIME.run, "idle");
  assert.equal(IDLE_RUNTIME.queue.length, 0);
});

test("queue, pause and steering are plain state the store keeps verbatim", () => {
  const { store } = fresh();
  const items = [{ id: "a", text: "one", at: 1 }, { id: "b", text: "two", at: 2 }];
  store.setQueue(items, "stopped");
  assert.deepEqual(store.get().queue.map((q) => q.text), ["one", "two"]);
  assert.equal(store.get().paused, "stopped");
  store.setSteering([items[1]]);
  assert.equal(store.get().steering[0].id, "b");
});
