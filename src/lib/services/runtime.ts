import { spawn } from "node:child_process";

/**
 * Container runtime detection and command runner. Docker (compose v2 plugin) first, then Podman (`podman compose`).
 * Never sudo: when the daemon socket is not accessible the result carries the exact command the owner runs once.
 */

export type RuntimeKind = "docker" | "podman";

export type RuntimeInfo =
  | { ok: true; kind: RuntimeKind; engineVersion: string; composeVersion: string }
  | { ok: false; reason: "missing" | "no-compose" | "daemon"; message: string; hint: string };

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Called with each complete stderr/stdout line as it arrives. */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
}

export function run(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    const out = { stdout: "", stderr: "" };
    const partial = { stdout: "", stderr: "" };
    const feed = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      // Keep the tail only: pull logs can be long.
      out[stream] = (out[stream] + text).slice(-200_000);
      if (!options.onLine) return;
      partial[stream] += text;
      const lines = partial[stream].split(/\r?\n/);
      partial[stream] = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) options.onLine(line, stream);
    };
    child.stdout.on("data", (chunk: Buffer) => feed("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => feed("stderr", chunk));
    const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs) : null;
    const onAbort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      out.stderr += error.message;
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      for (const stream of ["stdout", "stderr"] as const) {
        if (options.onLine && partial[stream].trim()) options.onLine(partial[stream], stream);
      }
      resolve({ code, ...out });
    });
  });
}

const INSTALL_HINT =
  "Install Docker Engine with the compose plugin (https://docs.docker.com/engine/install/) or Podman with podman-compose, then reload this page. Samurai Knife never runs sudo.";

async function probe(kind: RuntimeKind): Promise<RuntimeInfo | null> {
  const compose = await run(kind, ["compose", "version", "--short"], { timeoutMs: 15_000 });
  if (compose.code === null && /ENOENT/.test(compose.stderr)) return null;
  if (compose.code !== 0) {
    return {
      ok: false,
      reason: "no-compose",
      message: `${kind} is installed but "${kind} compose" is not available.`,
      hint: kind === "docker"
        ? "Install the compose v2 plugin (Debian/Ubuntu: the docker-compose-plugin package from Docker's repository), then reload."
        : "Install podman-compose (pip install podman-compose or your distro package), then reload.",
    };
  }
  const engine = await run(kind, kind === "docker" ? ["info", "--format", "{{.ServerVersion}}"] : ["info", "--format", "{{.Version.Version}}"], { timeoutMs: 20_000 });
  if (engine.code !== 0) {
    const denied = /permission denied/i.test(engine.stderr);
    return {
      ok: false,
      reason: "daemon",
      message: denied ? `The ${kind} socket is not accessible to this user.` : `The ${kind} engine is not running: ${engine.stderr.trim().split("\n").pop() ?? ""}`,
      hint: denied
        ? `Run once yourself: sudo usermod -aG ${kind} ${process.env.USER ?? "$USER"} (then log in again and restart the app).`
        : kind === "docker" ? "Start it yourself: sudo systemctl start docker" : "Start it yourself: systemctl --user start podman.socket",
    };
  }
  return { ok: true, kind, engineVersion: engine.stdout.trim(), composeVersion: compose.stdout.trim() };
}

let cached: { at: number; info: RuntimeInfo } | null = null;

export async function detectRuntime(fresh = false): Promise<RuntimeInfo> {
  if (!fresh && cached && Date.now() - cached.at < 60_000) return cached.info;
  const preferred = process.env.KNIFE_CONTAINER_RUNTIME?.trim();
  const order: RuntimeKind[] = preferred === "podman" ? ["podman", "docker"] : ["docker", "podman"];
  let firstProblem: RuntimeInfo | null = null;
  for (const kind of order) {
    const info = await probe(kind);
    if (info?.ok) {
      cached = { at: Date.now(), info };
      return info;
    }
    if (info && !firstProblem) firstProblem = info;
  }
  const info: RuntimeInfo = firstProblem ?? { ok: false, reason: "missing", message: "No container runtime found (docker or podman).", hint: INSTALL_HINT };
  cached = { at: Date.now(), info };
  return info;
}
