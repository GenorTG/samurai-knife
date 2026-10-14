// Line-wrap logic (text:wrap). Found by the 2026-10-10 browser walkthrough: indentation destroyed, emoji split mid surrogate pair.
// Oracle: Python textwrap on generated prose (break_on_hyphens=False, expand_tabs=False, replace_whitespace=False, drop_whitespace=True).
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/line_wrap.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { textWidth, wrapLine, wrapText } from "../src/lib/line-wrap.ts";

const noLoneSurrogate = (s) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

test("indentation of the first row survives, also for a line that needs wrapping", () => {
  const code = "def f(x):\n    if x:\n        return 1\n    return 0";
  assert.equal(wrapText(code, 80), code);
  assert.deepEqual(wrapLine("    alpha beta gamma delta", 14), ["    alpha beta", "gamma delta"]);
});

test("runs of spaces inside a line that fits are kept; trailing whitespace is dropped", () => {
  assert.equal(wrapText("a  b   c    d  ", 80), "a  b   c    d");
  assert.equal(wrapText("x = [1,  2,\t3]", 80), "x = [1,  2,\t3]");
});

test("blank lines and paragraph boundaries are preserved", () => {
  assert.equal(wrapText("one\n\n   \ntwo", 20), "one\n\n\ntwo");
});

test("emoji are never split mid surrogate pair or ZWJ sequence", () => {
  const out = wrapText("😀😀😀😀😀😀😀", 3);
  assert.equal(out, "😀😀😀\n😀😀😀\n😀");
  assert.ok(noLoneSurrogate(out));
  const family = "👨‍👩‍👧‍👦";
  const rows = wrapText(family.repeat(5), 2).split("\n");
  assert.deepEqual(rows, [family.repeat(2), family.repeat(2), family]);
  assert.equal(textWidth(family), 1);
  assert.ok(noLoneSurrogate(wrapText("a😀b".repeat(9), 4)));
});

test("a long word starts its own row, is cut by character, and later words follow its last piece", () => {
  assert.deepEqual(wrapLine("ab Supercalifragilistic cd", 10), ["ab", "Supercalif", "ragilistic", "cd"]);
});

test("no output row is wider than the width unless an indent could not be shrunk", () => {
  for (const line of ["    deeply indented words that keep going", "         x".padEnd(40, "y")]) {
    for (const row of wrapLine(line, 12)) assert.ok(textWidth(row) <= 12, row);
  }
});

function pythonWrap(lines, width) {
  const script = [
    "import json,sys,textwrap",
    "d=json.load(sys.stdin)",
    "print(json.dumps([textwrap.wrap(l,d['w'],break_long_words=True,break_on_hyphens=False,expand_tabs=False,replace_whitespace=False,drop_whitespace=True) or [''] for l in d['lines']]))",
  ].join("\n");
  const run = spawnSync("python3", ["-I", "-c", script], { input: JSON.stringify({ lines, w: width }), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test("prose lines (no word longer than the width) match python textwrap", () => {
  let seed = 12345;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const words = ["a", "an", "the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog", "keeps", "running", "far", "away,", "again.", "x=1;", "wrapper"];
  const lines = [];
  for (let i = 0; i < 300; i++) {
    const indent = " ".repeat(rand(3) * rand(4));
    const body = Array.from({ length: 1 + rand(24) }, () => words[rand(words.length)] + " ".repeat(1 + (rand(5) === 0 ? rand(3) : 0))).join("").trimEnd();
    lines.push(indent + body);
  }
  for (const width of [10, 14, 20, 37, 80]) {
    const want = pythonWrap(lines, width);
    lines.forEach((line, i) => {
      // A line that fits is returned untouched by design (textwrap would also collapse nothing there, so both agree except trailing spaces).
      assert.deepEqual(wrapLine(line, width), want[i], `width ${width}: ${JSON.stringify(line)}`);
    });
  }
});
