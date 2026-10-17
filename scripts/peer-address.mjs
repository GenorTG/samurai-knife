// Preloaded into the Next server by scripts/serve.mjs (NODE_OPTIONS --import). Stamps the TCP peer address of every request
// into `x-knife-peer`, replacing anything the client sent, so src/lib/accounts/network.ts can tell whether forwarded headers
// came from a trusted reverse proxy (route handlers never see the socket). No dependencies. With
// KNIFE_SECURITY_HEADERS_INSTALL=1 (serve.mjs, public mode) it also installs scripts/security-headers.mjs; with
// KNIFE_OFFICE_PUBLIC_URL, the office editor proxy (scripts/office-proxy.mjs).
import http from "node:http";
import https from "node:https";

const HEADER = "x-knife-peer";

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
