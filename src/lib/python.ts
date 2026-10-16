import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { childEnv, PYTHON_ENV_KEYS } from "./child-env";
import { isJobCancelled, isQueueFull, pythonQueue, type JobHandle, type PyLane } from "./work-queue";

/**
 * The Python lane. Server tools run as a one-shot script inside
 * `server/py/venv` — no daemon, no port, no state between calls.
 *
 * Contract: the script gets a JSON request on stdin and prints exactly one
 * JSON object on stdout. Anything on stderr is treated as a log line.
 */

/**
 * Paths are assembled at runtime on purpose. Turbopack constant-folds
 * `path.join(process.cwd(), "literal")` into a real file reference, which turns
 * the target into a build asset — and a venv is full of symlinks that resolve
 * outside the project root, so the build panics. Deriving the interpreter path
 * from `os.homedir()`/env keeps it a plain runtime string, and the venv lives
 * beside the repo (`../samurai-knife-py`) rather than inside it.
 */
function pythonBin(): string {
  const fromEnv = process.env.KNIFE_PYTHON?.trim();
  if (fromEnv) return fromEnv;
  const pyHome = process.env.KNIFE_PY_HOME?.trim() || path.join(os.homedir(), "work", "samurai-knife-py");
  return path.join(pyHome, "venv", "bin", "python");
}

export const PY_BIN = pythonBin();
export const PY_SCRIPTS_DIR = path.join(process.cwd(), "server", "py", "scripts");

/**
 * A script response. Artifact verbs (`file`/`mime`/`bytes`) live at the top
 * level, not under `data`, so the whole payload has to survive the bridge.
 */
export type PythonPayload<T> = { ok?: boolean; data?: T; error?: string } & Record<string, unknown>;

export type PythonRunOptions = {
  /** Run-time limit (queue wait excluded). The whole process group is killed when it expires. */
  timeoutMs?: number;
  /** Cap on stdout+stderr bytes; the process group is killed beyond it. */
  maxBytes?: number;
  /** `light` (default): small and fast, e.g. sql. `heavy`: big file work, e.g. pdf. */
  lane?: PyLane;
  /** Aborts the job: a queued one is dropped, a running one has its process group killed. */
  signal?: AbortSignal;
  label?: string;
};

export interface PythonRunResult<T> {
  ok: boolean;
  data?: T;
  /** Complete response payload, including top-level artifact fields. */
  payload?: PythonPayload<T>;
  error?: string;
  /** The job was cancelled (caller abort) rather than failing on its own. */
  cancelled?: boolean;
  logs: string[];
  ms: number;
}

const KILL_GRACE_MS = 1_500;

interface ChildOutcome {
  stderr: string;
  /** Output cap exceeded. */
  overflow: boolean;
  spawnError?: Error;
}

/**
 * Run the interpreter in its own process group (`detached`) so an abort/timeout can take down the whole tree, not
 * just the direct child. Resolves only once the child has exited: the caller may delete the scratch dir afterwards.
 */
function runChild(args: string[], maxBytes: number, signal: AbortSignal): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    const child = spawn(PY_BIN, args, {
      cwd: PY_SCRIPTS_DIR,
      // Never the server's own environment (keys, SMTP credentials): see child-env.ts.
      env: childEnv(PYTHON_ENV_KEYS, { PYTHONDONTWRITEBYTECODE: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const group = child.pid;
    let bytes = 0;
    let overflow = false;
    let exited = false;
    let spawnError: Error | undefined;
    const stderr: Buffer[] = [];
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const killGroup = (sig: NodeJS.Signals) => {
      if (group === undefined) return;
      try {
        process.kill(-group, sig);
      } catch {
        // ESRCH: already gone
      }
    };
    const stop = () => {
      if (exited) return;
      killGroup("SIGTERM");
      killTimer ??= setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    };
    const onData = (keep: boolean) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (keep && bytes <= maxBytes) stderr.push(chunk);
      if (bytes > maxBytes && !overflow) {
        overflow = true;
        stop();
      }
    };
    child.stdout.on("data", onData(false));
    child.stderr.on("data", onData(true));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", () => {
      exited = true;
      if (killTimer) clearTimeout(killTimer);
      // Anything the script left behind in its group (it exited, its children may not have).
      killGroup("SIGKILL");
      signal.removeEventListener("abort", stop);
      resolve({ stderr: Buffer.concat(stderr).toString("utf8"), overflow, spawnError });
    });
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

async function execute<T>(scriptName: string, request: unknown, maxBytes: number, signal: AbortSignal): Promise<PythonRunResult<T>> {
  const script = path.join(PY_SCRIPTS_DIR, scriptName);
  const started = Date.now();
  const logs: string[] = [];
  let dir: string | null = null;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "knife-"));
    const inPath = path.join(dir, "request.json");
    const outPath = path.join(dir, "response.json");
    await fs.writeFile(inPath, JSON.stringify(request), "utf8");
    if (signal.aborted) throw signal.reason;

    const run = await runChild([script, inPath, outPath], maxBytes, signal);
    if (signal.aborted) throw signal.reason;
    if (run.stderr.trim()) logs.push(...run.stderr.trim().split("\n"));
    if (run.spawnError) throw run.spawnError;

    // A non-zero exit is normal for a handled ToolError: the script still writes a readable message to the
    // response file. Prefer that over a raw "Command failed: <argv>" text, which leaks paths and helps nobody.
    const rescued = await readResponse<T>(outPath);
    if (rescued) return shape(rescued, logs, started);
    return {
      ok: false,
      error: run.overflow ? `The script printed more than ${maxBytes} bytes.` : "The script produced no response.",
      logs,
      ms: Date.now() - started,
    };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, logs, ms: Date.now() - started };
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Enqueue a script run on its lane and return the queue handle (state, position, cancel) — for callers that
 * report progress. `handle.promise` rejects with JobCancelledError / JobTimeoutError; QueueFullError is thrown.
 */
export function startPythonScript<T = unknown>(
  scriptName: string,
  request: unknown,
  { timeoutMs = 120_000, maxBytes = 64 * 1024 * 1024, lane = "light", signal, label }: PythonRunOptions = {},
): JobHandle<PythonRunResult<T>> {
  return pythonQueue().submit(lane, ({ signal: jobSignal }) => execute<T>(scriptName, request, maxBytes, jobSignal), {
    signal,
    timeoutMs,
    label: label ?? scriptName,
  });
}

/** Result contract unchanged; a timeout or caller abort comes back as `{ ok: false, error, cancelled? }`. */
export async function runPythonScript<T = unknown>(
  scriptName: string,
  request: unknown,
  options: PythonRunOptions = {},
): Promise<PythonRunResult<T>> {
  const started = Date.now();
  try {
    return await startPythonScript<T>(scriptName, request, options).promise;
  } catch (error) {
    if (isQueueFull(error)) throw error;
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      cancelled: isJobCancelled(error) || undefined,
      logs: [],
      ms: Date.now() - started,
    };
  }
}

function parsed<T>(raw: string): PythonPayload<T> {
  return JSON.parse(raw) as PythonPayload<T>;
}

async function readResponse<T>(file: string): Promise<PythonPayload<T> | null> {
  try {
    return parsed<T>(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function shape<T>(payload: PythonPayload<T>, logs: string[], started: number): PythonRunResult<T> {
  return {
    ok: payload.ok ?? true,
    data: payload.data,
    payload,
    error: payload.error,
    logs,
    ms: Date.now() - started,
  };
}

/** Create a scratch directory the python side may write output files into. */
export async function makeScratchDir(prefix = "knife-out-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function readArtifact(dir: string, name: string): Promise<Buffer> {
  return fs.readFile(path.join(dir, name));
}

export async function disposeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
