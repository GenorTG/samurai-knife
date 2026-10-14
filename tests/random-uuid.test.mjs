import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { createUuidV4 } from "../src/lib/random-uuid.ts";

test("creates RFC 9562 v4 UUIDs when randomUUID is unavailable", () => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
  });

  assert.equal(typeof crypto.randomUUID, "undefined");

  const first = createUuidV4();
  const second = createUuidV4();
  const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  assert.match(first, uuidV4Pattern);
  assert.match(second, uuidV4Pattern);
  assert.notEqual(first, second);
});
