import assert from "node:assert/strict";
import test from "node:test";
import { walkXml } from "../src/lib/office/xml-walk.ts";

test("unclosed office XML tags are scanned in one forward pass", () => {
  const repeats = 100_000;
  const xml = "<w:p>".repeat(repeats);
  let opens = 0;
  const start = performance.now();
  walkXml(xml, { open() { opens += 1; }, close() {}, text() {} });
  const elapsed = performance.now() - start;
  assert.equal(opens, repeats);
  assert.ok(elapsed < 2_000, `linear scan took ${elapsed.toFixed(0)} ms`);
});

test("XML entities decode without interpreting malformed markup", () => {
  const text = [];
  walkXml("<w:t>A&amp;B &#x1F642;</w:t><w:p", { open() {}, close() {}, text(value) { text.push(value); } });
  assert.deepEqual(text, ["A&B 🙂"]);
});
