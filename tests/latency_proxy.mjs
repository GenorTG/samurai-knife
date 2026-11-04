// A tiny toxiproxy-like TCP proxy that adds network latency (docs/DB-POSTGRES.md "Measuring"): every chunk is delivered
// `rtt/2` ms later in each direction, in order, so one request/response round trip costs `rtt` ms more, like the WAN hop
// between the app host and the VPS primary (~35 ms). Bandwidth is not limited. No dependencies.
//
//   node tests/latency_proxy.mjs --listen 127.0.0.1:3433 --target 127.0.0.1:3432 --rtt 35
//   import { startLatencyProxy } from "./latency_proxy.mjs"; const proxy = await startLatencyProxy({ ... }); proxy.setRtt(0)
import net from "node:net";

/**
 * @param {{ listenHost?: string, listenPort?: number, targetHost: string, targetPort: number, rttMs: number }} options
 * @returns {Promise<{ port: number, setRtt(ms: number): void, close(): Promise<void>, connections(): number }>}
 */
export function startLatencyProxy({ listenHost = "127.0.0.1", listenPort = 0, targetHost, targetPort, rttMs }) {
  let oneWay = rttMs / 2;
  const sockets = new Set();
  const pipe = (from, to) => {
    let lastAt = 0;
    from.on("data", (chunk) => {
      // In-order delivery: a chunk never overtakes the one before it.
      const at = Math.max(Date.now() + oneWay, lastAt);
      lastAt = at;
      const send = () => {
        if (!to.destroyed) to.write(chunk);
      };
      const wait = at - Date.now();
      if (wait <= 0) send();
      else setTimeout(send, wait);
    });
    from.on("end", () => setTimeout(() => to.end(), Math.max(0, lastAt - Date.now())));
    from.on("error", () => to.destroy());
    from.on("close", () => to.destroy());
  };
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, targetHost);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    sockets.add(client);
    sockets.add(upstream);
    client.on("close", () => sockets.delete(client));
    upstream.on("close", () => sockets.delete(upstream));
    pipe(client, upstream);
    pipe(upstream, client);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => {
      resolve({
        port: server.address().port,
        setRtt(ms) {
          oneWay = ms / 2;
        },
        connections: () => sockets.size / 2,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const [listenHost, listenPort] = (value("--listen") ?? "127.0.0.1:0").split(":");
  const [targetHost, targetPort] = (value("--target") ?? "").split(":");
  if (!targetHost || !targetPort) {
    console.error("usage: node tests/latency_proxy.mjs --listen HOST:PORT --target HOST:PORT --rtt MS");
    process.exit(2);
  }
  const proxy = await startLatencyProxy({ listenHost, listenPort: Number(listenPort), targetHost, targetPort: Number(targetPort), rttMs: Number(value("--rtt") ?? 35) });
  console.log(JSON.stringify({ port: proxy.port, pid: process.pid }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void proxy.close().then(() => process.exit(0)));
}
