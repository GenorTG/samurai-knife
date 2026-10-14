// The Diff tool's patch must be a real unified diff: `patch` (the independent oracle) applies it to the left text
// and gets the right text back. Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/diff_patch.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computeDiff, diffSummary } from "../src/lib/diff.ts";

const numbered = (n, from = 1) => Array.from({ length: n }, (_, i) => `line ${from + i}`);
const withNl = (lines) => lines.join("\n") + "\n";

function replaceAt(lines, at, text) {
  const copy = [...lines];
  copy[at] = text;
  return copy;
}

const base = numbered(30);
const CASES = {
  identical: ["a\nb\nc\n", "a\nb\nc\n"],
  "left empty": ["", "a\nb\n"],
  "right empty": ["a\nb\n", ""],
  "both empty": ["", ""],
  "change at first line": [withNl(base), withNl(replaceAt(base, 0, "FIRST"))],
  "change at last line": [withNl(base), withNl(replaceAt(base, 29, "LAST"))],
  "two far-apart changes -> two hunks": [withNl(base), withNl(replaceAt(replaceAt(base, 3, "X"), 25, "Y"))],
  "two near changes -> one hunk": [withNl(base), withNl(replaceAt(replaceAt(base, 10, "X"), 14, "Y"))],
  "changes exactly 6 lines apart merge": [withNl(base), withNl(replaceAt(replaceAt(base, 10, "X"), 17, "Y"))],
  "changes 7 lines apart stay two hunks": [withNl(base), withNl(replaceAt(replaceAt(base, 10, "X"), 18, "Y"))],
  "pure insertion in the middle": [withNl(base), withNl([...base.slice(0, 15), "new a", "new b", ...base.slice(15)])],
  "pure deletion in the middle": [withNl(base), withNl([...base.slice(0, 10), ...base.slice(13)])],
  "insertion at the very top": [withNl(base), withNl(["top", ...base])],
  "unicode and emoji": ["zażółć\n日本語\n🙂 ok\nlast\n", "zażółć\n日本語!\n🙂 ok\nlast\n🙂\n"],
  "content that looks like diff headers": ["--- x\n+++ y\n@@ -1 +1 @@\nkeep\n", "--- x\n+++ z\n@@ -1 +1 @@\n-gone\nkeep\n"],
  "lines that start with the marker characters": ["- a\n+ b\n  c\n\\ d\n", "- a\n+ B\n  c\n\\ d\n\\ e\n"],
  "no newline on both sides": ["a\nb\nc", "a\nB\nc"],
  "no newline only on the left": ["a\nb", "a\nb\n"],
  "no newline only on the right": ["a\nb\n", "a\nb"],
  "no newline, last line changed": ["a\nb", "a\nbb"],
  "no newline, line appended": ["a\nb", "a\nb\nc"],
  "single line without newline": ["one", "two"],
  "blank lines": ["a\n\n\nb\n", "a\n\nb\n\n\n"],
  CRLF: ["a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\nd\r\n"],
  "long file, scattered edits": [withNl(numbered(200)), withNl(numbered(200).map((l, i) => (i % 37 === 0 ? `${l} edited` : l)))],
};

/** Apply `patch` text to `left` with the system `patch` and return the result (or the failure output). */
function applyWithPatch(left, patchText) {
  const dir = mkdtempSync(join(tmpdir(), "knife-diff-"));
  try {
    writeFileSync(join(dir, "left.txt"), left);
    writeFileSync(join(dir, "changes.diff"), patchText);
    const run = spawnSync("patch", ["--force", "--batch", "--no-backup-if-mismatch", "-i", "changes.diff", "left.txt"], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, `patch failed:\n${run.stdout}${run.stderr}\n--- patch ---\n${patchText}`);
    return readFileSync(join(dir, "left.txt"), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [name, [left, right]] of Object.entries(CASES)) {
  test(`patch applies: ${name}`, () => {
    const result = computeDiff(left, right);
    assert.equal(result.ok, true);
    if (left === right) {
      assert.equal(result.patch, "", "identical texts give an empty patch, like diff -u");
      return;
    }
    assert.ok(result.patch.endsWith("\n"), "patch ends with a newline");
    assert.match(result.patch, /^--- left\n\+\+\+ right\n@@ -/);
    assert.equal(applyWithPatch(left, result.patch), right);
  });
}

test("git apply --check accepts the patch", () => {
  const [left, right] = CASES["two far-apart changes -> two hunks"];
  const dir = mkdtempSync(join(tmpdir(), "knife-diff-git-"));
  try {
    const patchText = computeDiff(left, right).patch.replace("--- left", "--- a/f.txt").replace("+++ right", "+++ b/f.txt");
    writeFileSync(join(dir, "f.txt"), left);
    writeFileSync(join(dir, "changes.diff"), patchText);
    const run = spawnSync("git", ["apply", "--check", "changes.diff"], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hunk headers: separate hunks, merged hunks, and 0-length sides", () => {
  const far = computeDiff(withNl(base), withNl(replaceAt(replaceAt(base, 3, "X"), 25, "Y"))).patch;
  assert.equal(far.match(/^@@ /gm)?.length, 2);
  assert.ok(far.includes("@@ -1,7 +1,7 @@"), far);
  assert.ok(far.includes("@@ -23,7 +23,7 @@"), far);
  const near = computeDiff(withNl(base), withNl(replaceAt(replaceAt(base, 10, "X"), 14, "Y"))).patch;
  assert.equal(near.match(/^@@ /gm)?.length, 1);
  assert.ok(near.includes("@@ -8,11 +8,11 @@"), near);
  assert.ok(computeDiff("", "a\nb\n").patch.includes("@@ -0,0 +1,2 @@"));
  assert.ok(computeDiff("a\nb\n", "").patch.includes("@@ -1,2 +0,0 @@"));
  assert.ok(computeDiff("one", "two").patch.includes("@@ -1 +1 @@"));
});

test("no newline markers sit after the right lines", () => {
  const patch = computeDiff("a\nb", "a\nb\n").patch;
  assert.equal(patch, "--- left\n+++ right\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n");
});

test("stats and rows are unchanged by a trailing newline on both sides", () => {
  const withEnd = computeDiff("a\nb\n", "a\nc\n");
  const without = computeDiff("a\nb", "a\nc");
  assert.deepEqual([withEnd.added, withEnd.removed, withEnd.unchanged], [1, 1, 1]);
  assert.deepEqual([without.added, without.removed, without.unchanged], [1, 1, 1]);
});

test("summary words are invariant", () => {
  assert.equal(diffSummary({ added: 2, removed: 2, unchanged: 2 }), "2 added · 2 removed · 2 unchanged");
  assert.equal(diffSummary({ added: 0, removed: 1, unchanged: 0 }), "0 added · 1 removed · 0 unchanged");
  assert.doesNotMatch(diffSummary({ added: 5, removed: 5, unchanged: 5 }), /addeds|removeds|unchangeds/);
});
