// Draft handling for numeric inputs (NumberField): typing 1.5 or 40 key by key must not be clamped away mid-edit.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/number_draft.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { commitDraftValue, liveDraftValue } from "../src/lib/number-draft.ts";

const wrap = { min: 10, max: 240, integer: true, fallback: 80 };
const ratio = { min: 1.05, max: 2, fallback: 1.25 };

test("live: every prefix of 1.5 / 40 / 1.618 parses and the final prefix is the intended value", () => {
  assert.deepEqual(["1", "1.", "1.5"].map((t) => liveDraftValue(t, ratio)), [1.05, 1.05, 1.5]);
  assert.equal(liveDraftValue("1.618", ratio), 1.618);
  assert.deepEqual(["4", "40"].map((t) => liveDraftValue(t, wrap)), [10, 40]);
});

test("live: blank or half-typed text publishes nothing", () => {
  for (const t of ["", "  ", "-", "e", "1e"]) assert.equal(liveDraftValue(t, wrap), null, JSON.stringify(t));
});

test("commit: documented clamps and the blank fallback", () => {
  assert.equal(commitDraftValue("5", wrap), 10);
  assert.equal(commitDraftValue("999", wrap), 240);
  assert.equal(commitDraftValue("", wrap), 80);
  assert.equal(commitDraftValue("abc", wrap), 80);
  assert.equal(commitDraftValue("40.9", wrap), 40);
  assert.equal(commitDraftValue("", { min: 8, max: 64 }), 8);
  assert.equal(commitDraftValue("", ratio), 1.25);
});

test("unbounded sides stay free (offsets can be negative)", () => {
  const free = { min: -Infinity, max: Infinity, fallback: 0 };
  assert.equal(liveDraftValue("-5", free), -5);
  assert.equal(liveDraftValue("-", free), null);
  assert.equal(commitDraftValue("", free), 0);
});
