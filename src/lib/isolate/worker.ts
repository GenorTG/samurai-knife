/**
 * Worker-thread entry of the server isolate pool (`server.ts` starts it with `new Worker(new URL("./worker.ts", ...))`,
 * which Turbopack bundles as its own `[worker thread]` chunk). Serves `ISOLATE_HANDLERS` one request at a time over the
 * shared worker protocol (`src/lib/workers/runtime.ts`); posts "ready" once loaded.
 */
import { parentPort } from "node:worker_threads";
import { serveTasks } from "../workers/runtime";
import { ISOLATE_HANDLERS, type IsolateTasks } from "./tasks";

const port = parentPort;
if (port) {
  serveTasks<IsolateTasks>(ISOLATE_HANDLERS, {
    set onmessage(listener: ((event: { data: unknown }) => void) | null) {
      port.removeAllListeners("message");
      if (listener) port.on("message", (data: unknown) => listener({ data }));
    },
    get onmessage() {
      return null;
    },
    postMessage: (message: unknown) => port.postMessage(message),
  });
}
