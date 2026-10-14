// data: URI decoded size (url:url). The old tool showed 6 for "SGVsbG8=" (real 5) and 13 for "hello%20world" (real 11).
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/data_uri.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { dataUriByteLength } from "../src/lib/data-uri.ts";

test("base64: padding is not data", () => {
  for (const [payload, bytes] of [["SGVsbG8=", 5], ["SGVsbG8", 5], ["SGk=", 2], ["SGk", 2], ["SGVs", 3], ["QQ==", 1], ["QQ", 1], ["", 0]]) {
    assert.equal(dataUriByteLength(payload, true), bytes, payload);
    assert.equal(dataUriByteLength(payload, true), Buffer.from(payload, "base64").length, `${payload} vs Buffer`);
  }
  assert.equal(dataUriByteLength("SGVs\nbG8%3D", true), 5, "line breaks and an escaped = are ignored");
});

test("plain payloads: a percent escape is one byte, other characters are their UTF-8 bytes", () => {
  assert.equal(dataUriByteLength("hello%20world", false), 11);
  assert.equal(dataUriByteLength("%E2%9C%93", false), 3);
  assert.equal(dataUriByteLength("ü", false), 2);
  assert.equal(dataUriByteLength("100%", false), 4, "a stray % stays literal");
  assert.equal(dataUriByteLength("%zz%41", false), 4);
});
