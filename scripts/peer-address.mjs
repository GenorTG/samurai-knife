// Preloaded into the Next server by scripts/serve.mjs (NODE_OPTIONS --import). Stamps the TCP peer address of every request
// into `x-knife-peer`, replacing anything the client sent, so src/lib/accounts/network.ts can tell whether forwarded headers
// came from a trusted reverse proxy (route handlers never see the socket). No dependencies. With
// KNIFE_SECURITY_HEADERS_INSTALL=1 (serve.mjs, public mode) it also installs scripts/security-headers.mjs; with
// KNIFE_OFFICE_PUBLIC_URL, the office editor proxy (scripts/office-proxy.mjs); with KNIFE_CRAFT_PUBLIC_URL, the ArtCraft
// proxy (scripts/craft-proxy.mjs); always, last, the abuse guard and the Node server timeouts (scripts/abuse-guard.mjs).
import http from "node:http";
import https from "node:https";

const HEADER = "x-knife-peer";

// libuv's pool (fs.promises, dns.lookup, zlib, scrypt) is 4 threads by default; serve.mjs sets 16 for the child, this
// covers servers started another way. Read when the pool is first used, which has not happened yet in a preload.
process.env.UV_THREADPOOL_SIZE ||= "16";

for (const Server of [http.Server, https.Server]) {
  const original = Server.prototype.emit;
  if (original.knifePeer) continue;
  const patched = function emit(event, request, ...rest) {
    if (event === "request" && request && request.headers) {
      const peer = request.socket?.remoteAddress;
      if (peer) request.headers[HEADER] = peer;
      else delete request.headers[HEADER];
    }
    return original.call(this, event, request, ...rest);
  };
  patched.knifePeer = true;
  Server.prototype.emit = patched;
}

if (process.env.KNIFE_SECURITY_HEADERS_INSTALL === "1") await import("./security-headers.mjs");
// Last, so it wraps the others: requests for the office host (KNIFE_OFFICE_PUBLIC_URL) never get the app's headers.
await import("./office-proxy.mjs");
// Same for the ArtCraft host (KNIFE_CRAFT_PUBLIC_URL).
await import("./craft-proxy.mjs");
// Very last, so it wraps every hook above: refused requests never reach the office proxy, the headers or Next.
await import("./abuse-guard.mjs");
