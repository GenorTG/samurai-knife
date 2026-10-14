import { sha1 } from "@noble/hashes/legacy.js";
import { sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import type { HashName, HashTasks } from "./hash-run";
import { serveTasks } from "./workers/runtime";

// Pure-JS digests (not crypto.subtle): the tailnet origin is plain http, which is not a secure context.
const HASHES = { "SHA-1": sha1, "SHA-256": sha256, "SHA-384": sha384, "SHA-512": sha512 } as const satisfies Record<HashName, { create: () => { update(data: Uint8Array): unknown; digest(): Uint8Array } }>;

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

serveTasks<HashTasks>({
  async hashFile({ file, algorithm }, context) {
    const hasher = HASHES[algorithm].create();
    const reader = file.stream().getReader();
    let read = 0;
    let last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      read += value.byteLength;
      const now = performance.now();
      if (now - last > 120) {
        last = now;
        context.progress({ bytes: read, total: file.size });
      }
    }
    return toHex(hasher.digest());
  },
});
