// Preloaded through scripts/peer-address.mjs. Counts the requests that are someone's work (an agent's MCP calls, the
// assistant, saves, uploads, Python jobs...) so knife-update can wait for a quiet moment before it restarts the server
// (GET /api/system/activity, docs/DEPLOY.md "Updates without breaking work"). Page loads, static files and the
// background polls every open tab makes (presence, UI bridge poll) are not work: an open tab alone never holds an update.
// Plain .mjs, no dependencies; the counters live on globalThis so the route handler (another module graph) reads them.
import http from "node:http";
import https from "node:https";

const KEY = Symbol.for("samurai-knife.activity.v1");
const state = (globalThis[KEY] ??= { inflight: 0, lastWork: 0, started: Date.now() });

/** Background requests every open tab repeats: never work. */
const BACKGROUND = ["/api/ui/presence", "/api/ui/poll", "/api/system/activity", "/api/system/version"];
/** GET routes that are work (long reads an agent waits on, job polls, MCP's SSE stream). */
const WORK_GET = ["/api/mcp", "/api/agent", "/api/jobs", "/api/site", "/api/pdf", "/api/sql", "/api/workflows"];

export function isWork(method, url) {
  const path = String(url ?? "/").split("?")[0];
  if (BACKGROUND.some((p) => path === p || path.startsWith(`${p}/`))) return false;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") return path.startsWith("/api/") || path.startsWith("/tools/");
  return WORK_GET.some((p) => path === p || path.startsWith(`${p}/`));
}

for (const Server of [http.Server, https.Server]) {
  const original = Server.prototype.emit;
  if (original.knifeActivity) continue;
  const patched = function emit(event, request, response, ...rest) {
    if (event === "request" && request && response && isWork(request.method, request.url)) {
      state.inflight += 1;
      state.lastWork = Date.now();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        state.inflight = Math.max(0, state.inflight - 1);
        state.lastWork = Date.now();
      };
      response.once("close", finish);
      response.once("finish", finish);
    }
    return original.call(this, event, request, response, ...rest);
  };
  patched.knifeActivity = true;
  Server.prototype.emit = patched;
}
