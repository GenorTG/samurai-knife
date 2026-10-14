// Sentence splitting (reading-grade:sentences / grade). Found by the 2026-10-10 browser walkthrough: "$3.50", "5 p.m.", "v1.2.3" split into 9 sentences.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/writing_sentences.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSentences, gradeText } from "../src/lib/writing.ts";

const split = (text) => analyzeSentences(text).rows.map((row) => row.text);

test("decimals, times, versions, titles and dated months do not end a sentence", () => {
  const text = "Dr. Smith paid $3.50 at 5 p.m. on Jan. 5. See v1.2.3 now.";
  assert.deepEqual(split(text), ["Dr. Smith paid $3.50 at 5 p.m. on Jan. 5.", "See v1.2.3 now."]);
  assert.equal(analyzeSentences(text).total, 2);
  assert.equal(gradeText(text).sentenceCount, 2, "reading-grade counts with the same splitter");
});

test("each abbreviation on its own", () => {
  for (const [text, want] of [
    ["Mr. Jones met Mrs. Lee and Ms. Park. Prof. Wu agreed.", 2],
    ["Visit St. Mary now. It is nice.", 2],
    ["Cats vs. dogs is a debate. Nobody wins.", 2],
    ["Use fruit, e.g. apples, or nuts, i.e. almonds. Done.", 2],
    ["Meet at 9 a.m. or 5 p.m. tomorrow. Bring lunch.", 2],
    ["We left on Sept. 12. We came back on Dec. 3. Fun.", 3],
    ["Pi is 3.14159. Round it.", 2],
  ]) assert.equal(analyzeSentences(text).total, want, text);
});

test("ordinary prose keeps splitting exactly as before", () => {
  assert.deepEqual(split("Short one? Yes! Wait... what"), ["Short one?", "Yes!", "Wait...", "what"]);
  assert.deepEqual(split("Missing space.After a mark!Another one"), ["Missing space.", "After a mark!", "Another one"]);
  assert.deepEqual(split("Really?!!! Yes ,it is."), ["Really?!!!", "Yes ,it is."]);
  assert.deepEqual(split("He said \"stop.\""), ["He said \"stop.", "\""]);
  assert.deepEqual(split("May. Not a month abbreviation without a day. Also Jan. alone ends."), ["May.", "Not a month abbreviation without a day.", "Also Jan.", "alone ends."]);
  assert.deepEqual(split("... leading dots. Then text."), ["leading dots.", "Then text."].map((t) => t));
  assert.equal(analyzeSentences("").total, 0);
});

test("grade: the sentence estimate ignores decimal points", () => {
  assert.equal(gradeText("It costs 3.50 today and 4.75 tomorrow.").sentenceCount, 1);
  assert.equal(gradeText("No end punctuation here").sentenceCount, 1);
});

test("prose from the e2e fragment pool splits identically to the previous regex", () => {
  const pool = [
    "Short sentences help.", "A longer sentence can include several words and clauses, which may make it harder to scan quickly.",
    "Really?!!! Yes ,it is.", "Double  spaces here .", "Missing space.After a mark!Another one", "The cat didn't sit; it's fine",
    "He said (quietly) \"stop.\"", "No end punctuation here", "...", "?? odd", "Wait... what",
  ];
  let seed = 7;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let i = 0; i < 200; i++) {
    const text = Array.from({ length: 1 + rand(8) }, () => pool[rand(pool.length)]).join(rand(2) ? " " : "\n");
    const old = (text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? []).map((s) => s.trim()).filter(Boolean);
    assert.deepEqual(split(text), old, JSON.stringify(text));
  }
});
