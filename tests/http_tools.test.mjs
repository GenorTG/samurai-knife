// cURL building (Web workbench cURL tab). Found by the 2026-10-10 browser walkthrough.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/http_tools.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { buildCurlCommand } from "../src/lib/curl-command.ts";

test("curl: HEAD never carries a body (--data-raw would turn it into a POST)", () => {
  const head = buildCurlCommand({ method: "HEAD", url: "https://x.test/", headers: "", body: "payload" });
  assert.equal(head.command, "curl --head 'https://x.test/'");
  assert.equal(head.bodyDropped, true);
  assert.equal(buildCurlCommand({ method: "HEAD", url: "https://x.test/", headers: "", body: "" }).bodyDropped, false);
  const post = buildCurlCommand({ method: "POST", url: "https://x.test/", headers: "A: b", body: "it's" });
  assert.equal(post.command, "curl --request 'POST' 'https://x.test/' \\\n  --header 'A: b' \\\n  --data-raw 'it'\\''s'");
  assert.equal(post.bodyDropped, false);
});
