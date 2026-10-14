// Manage the optional docker sidecars from a terminal. Same library and state as the web UI (src/lib/services), and the
// same per-service lock file, so an op started here and one started in the browser never overlap.
//
//   npm run services -- list
//   npm run services -- status <id> [--json] [--memory]
//   npm run services -- install <id> [--port N] [--app-url URL] [--public-url URL] [--idle-minutes N]
//   npm run services -- start <id> | stop <id> | update <id>
//   npm run services -- remove <id> [--purge] [--remove-image]
//   npm run services -- configure <id> [--port N] [--app-url URL|none] [--public-url URL|none] [--idle-minutes N]
//   npm run services -- reap            (one idle-stop pass, as the server does every minute)
//
// Reads .env.local like scripts/serve.mjs (KNIFE_HOST, KNIFE_PORT, KNIFE_DATA_DIR). Never runs sudo.
import { SIDECARS } from "@/lib/services/definitions";
import { configure, install, reapIdle, remove, SidecarError, start, status, stop, update, type OpReporter } from "@/lib/services/manager";
import type { PullProgress } from "@/lib/services/pull-progress";

try {
  process.loadEnvFile(".env.local");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const [command, id, ...rest] = process.argv.slice(2);

function flag(name: string): boolean {
  return rest.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const index = rest.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = rest[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`--${name} needs a value`);
  return value;
}

function intOption(name: string): number | undefined {
  const value = option(name);
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || String(n) !== value) fail(`--${name} must be an integer`);
  return n;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function usage(): never {
  console.error("usage: npm run services -- list | status|install|start|stop|update|remove|configure <id> [options] | reap");
  process.exit(2);
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function reporter(): OpReporter {
  let lastPhase = "";
  let lastPct = -10;
  const tty = process.stdout.isTTY;
  return {
    phase(text, percent) {
      if (text.startsWith("Pulling ") && percent !== undefined) {
        if (tty) process.stdout.write(`\r${text} ${percent}%   `);
        else if (percent - lastPct >= 10 || percent === 100) {
          console.log(`${text} ${percent}%`);
          lastPct = percent;
        }
        lastPhase = text;
        return;
      }
      if (text !== lastPhase) {
        if (tty && lastPhase.startsWith("Pulling ")) process.stdout.write("\n");
        console.log(`- ${text}`);
        lastPhase = text;
      }
    },
    log(line) {
      console.log(`  ${line}`);
    },
    pull(progress: PullProgress) {
      if (tty && progress.totalBytes) process.stdout.write(`\rPulling: ${mb(progress.downloadedBytes)} / ${mb(progress.totalBytes)}, ${progress.layersDone}/${progress.layers} layers, ${progress.percent}%   `);
    },
  };
}

function needId(): string {
  if (!id) usage();
  if (!SIDECARS.some((s) => s.id === id)) fail(`unknown service ${id}; known: ${SIDECARS.map((s) => s.id).join(", ")}`);
  return id;
}

function urlOption(name: string): string | null | undefined {
  const value = option(name);
  return value === "none" ? null : value;
}

async function main(): Promise<void> {
  switch (command) {
    case "list": {
      for (const def of SIDECARS) {
        const s = await status(def.id);
        const state = !s.installed ? "not installed" : s.ready ? `running at ${s.publicUrl}` : s.container.state === "running" ? "starting" : "stopped";
        console.log(`${def.id.padEnd(12)} ${state.padEnd(40)} ${def.image}`);
      }
      return;
    }
    case "status": {
      const s = await status(needId(), { memory: flag("memory") });
      if (flag("json")) {
        console.log(JSON.stringify(s, null, 2));
        return;
      }
      console.log(`${s.name}\n  installed: ${s.installed}\n  container: ${s.container.state}${s.container.status ? ` (${s.container.status})` : ""}\n  ready: ${s.ready}`);
      if (s.state) console.log(`  image: ${s.state.image}\n  public URL: ${s.publicUrl}\n  app URL: ${s.appUrl.url} (${s.appUrl.source})\n  idle stop: ${s.state.idleStopMinutes || "never"} min\n  last start: ${s.state.lastStartMs ? `${(s.state.lastStartMs / 1000).toFixed(1)} s` : "-"}`);
      if (s.memory) console.log(`  memory: ${s.memory.text}`);
      if (!s.runtime.ok) console.log(`  runtime: ${s.runtime.message}\n  hint: ${s.runtime.hint}`);
      for (const w of s.warnings) console.log(`  warning: ${w}`);
      return;
    }
    case "install": {
      const state = await install(needId(), { port: intOption("port"), appUrl: option("app-url"), publicUrl: option("public-url"), idleStopMinutes: intOption("idle-minutes") }, reporter());
      console.log(`installed: ${state.id} on ${state.bindHost}:${state.hostPort}`);
      return;
    }
    case "start":
      await start(needId(), reporter());
      return;
    case "stop":
      await stop(needId(), reporter());
      return;
    case "update": {
      const result = await update(needId(), reporter());
      console.log(result.imageChanged ? "updated to a new image" : "already up to date");
      return;
    }
    case "remove":
      await remove(needId(), { purge: flag("purge"), removeImage: flag("remove-image") }, reporter());
      return;
    case "configure": {
      const result = await configure(needId(), { port: intOption("port"), appUrl: urlOption("app-url"), publicUrl: urlOption("public-url"), idleStopMinutes: intOption("idle-minutes") });
      console.log(result.restartNeeded ? "saved; run stop + start to apply the new port" : "saved");
      return;
    }
    case "reap": {
      const stopped = await reapIdle();
      console.log(stopped.length ? `stopped: ${stopped.join(", ")}` : "nothing idle");
      return;
    }
    default:
      usage();
  }
}

main().catch((error: unknown) => {
  if (error instanceof SidecarError) fail(`${error.message}${error.hint ? `\nhint: ${error.hint}` : ""}`);
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
});
