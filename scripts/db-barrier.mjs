// Preloaded through scripts/peer-address.mjs when KNIFE_DB_URL is set (docs/DB-POSTGRES.md "Commit barrier"). Every HTTP
// request runs inside an AsyncLocalStorage context; a core-store write made while handling it registers its commit there
// (src/lib/db/barrier.ts). The response's first bytes on the wire are then held until those commits settle:
// committed -> the held bytes go out unchanged; failed -> they are dropped and the client gets a plain
// 503 {"error":"storage_unavailable"} (no Set-Cookie, no body of the answer that was not saved), then the connection
// closes. So a client is never told "saved", or handed a session, that is not in the database.
//
// The hold sits on OutgoingMessage#_writeRaw, the one path every byte of a response (status line, headers, body) takes,
// below whatever wraps res.write/res.writeHead per request (Next's compression, the security headers): holding those
// public methods instead would double the implicit headers. A response that starts writing with nothing pending passes
// straight through (one length check, the original method restored), which is every read: reads come from the
// in-process cache. Plain .mjs, no dependencies (preload rule).
import http from "node:http";
import https from "node:https";
import { AsyncLocalStorage } from "node:async_hooks";

const KEY = Symbol.for("samurai-knife.db.barrier.v1");
const state = (globalThis[KEY] ??= { als: new AsyncLocalStorage(), held: 0, failed: 0 });
const FAILED_BODY = JSON.stringify({ error: "storage_unavailable", message: "The change could not be saved. Try again in a moment." });

async function settled(commits) {
  let seen = 0;
  let failure = null;
  while (seen < commits.pending.length) {
    const batch = commits.pending.slice(seen);
    seen = commits.pending.length;
    for (const result of await Promise.allSettled(batch)) {
      if (result.status === "rejected") failure ??= result.reason;
    }
  }
  return failure;
}

function install(response, commits) {
  const raw = response._writeRaw;
  if (typeof raw !== "function") return;
  let queue = null;
  const release = async () => {
    state.held += 1;
    const failure = await settled(commits);
    const calls = queue;
    queue = null;
    response._writeRaw = raw;
    if (failure) {
      state.failed += 1;
      const head = [
        "HTTP/1.1 503 Service Unavailable",
        "Content-Type: application/json; charset=utf-8",
        "Cache-Control: no-store",
        "X-Content-Type-Options: nosniff",
        "Retry-After: 2",
        `Content-Length: ${Buffer.byteLength(FAILED_BODY)}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n");
      const callbacks = calls.map(([, , callback]) => callback).filter((callback) => typeof callback === "function");
      raw.call(response, head + FAILED_BODY, "utf8", () => {
        for (const callback of callbacks) callback();
        response.socket?.end();
      });
      return;
    }
    for (const [data, encoding, callback, rest] of calls) raw.call(response, data, encoding, callback, ...rest);
  };
  response._writeRaw = function held(data, encoding, callback, ...rest) {
    if (queue === null) {
      if (commits.pending.length === 0) {
        response._writeRaw = raw;
        return raw.call(this, data, encoding, callback, ...rest);
      }
      queue = [];
      void release();
    }
    queue.push([data, encoding, callback, rest]);
    return true;
  };
}

if (process.env.KNIFE_DB_URL?.trim()) {
  for (const Server of [http.Server, https.Server]) {
    const original = Server.prototype.emit;
    if (original.knifeDbBarrier) continue;
    const patched = function emit(event, request, response, ...rest) {
      if (event === "request" && response && typeof response._writeRaw === "function") {
        const commits = { pending: [] };
        install(response, commits);
        return state.als.run(commits, () => original.call(this, event, request, response, ...rest));
      }
      return original.call(this, event, request, response, ...rest);
    };
    patched.knifeDbBarrier = true;
    Server.prototype.emit = patched;
  }
}
