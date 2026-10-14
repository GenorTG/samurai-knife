// Multipart decoding + cURL building (http-headers tabs). Found by the 2026-10-10 browser walkthrough.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/http_tools.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { buildCurlCommand } from "../src/lib/curl-command.ts";
import { decodeMultipart } from "../src/lib/multipart.ts";

test("multipart: a part with an empty header block has just its body (CRLF and LF)", () => {
  assert.deepEqual(decodeMultipart("XX", "--XX\r\n\r\njust body\r\n--XX--").parts, [{ headers: "", body: "just body" }]);
  assert.deepEqual(decodeMultipart("XX", "--XX\n\njust body\n--XX--").parts, [{ headers: "", body: "just body" }]);
  assert.deepEqual(decodeMultipart("XX", "--XX  \r\n\r\npadded\r\n--XX--").parts, [{ headers: "", body: "padded" }]);
});

test("multipart: headers, bodies with blank lines, empty bodies, epilogue", () => {
  const input = "pre\r\n--XX\r\nContent-Disposition: form-data; name=\"f\"\r\n\r\nline1\r\n\r\nline3\r\n--XX\r\nContent-Type: text/plain\r\n\r\n\r\n--XX--\r\nepilogue";
  assert.deepEqual(decodeMultipart("XX", input).parts, [
    { headers: "Content-Disposition: form-data; name=\"f\"", body: "line1\r\n\r\nline3" },
    { headers: "Content-Type: text/plain", body: "" },
  ]);
  assert.equal(decodeMultipart("", "x").error, "Enter a boundary.");
  assert.match(decodeMultipart("NOPE", "--XX").error, /not found/);
});

test("curl: HEAD never carries a body (--data-raw would turn it into a POST)", () => {
  const head = buildCurlCommand({ method: "HEAD", url: "https://x.test/", headers: "", body: "payload" });
  assert.equal(head.command, "curl --head 'https://x.test/'");
  assert.equal(head.bodyDropped, true);
  assert.equal(buildCurlCommand({ method: "HEAD", url: "https://x.test/", headers: "", body: "" }).bodyDropped, false);
  const post = buildCurlCommand({ method: "POST", url: "https://x.test/", headers: "A: b", body: "it's" });
  assert.equal(post.command, "curl --request 'POST' 'https://x.test/' \\\n  --header 'A: b' \\\n  --data-raw 'it'\\''s'");
  assert.equal(post.bodyDropped, false);
});
