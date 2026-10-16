import { execFile } from "node:child_process";
import { childEnv, GIT_ENV_KEYS } from "@/lib/child-env";

/**
 * SERVER-ONLY injectable command runner for the showcase gatherers: argv arrays through `execFile` (never a shell string),
 * with a timeout and an output cap; the child is killed on overrun. Tests install a fake with `setRunner`.
 */

export const NOT_FOUND = 127;
export const TIMED_OUT = 124;

export interface RunResult {
  returncode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export type Runner = (argv: string[]) => Promise<RunResult>;

export function runOk(res: RunResult): boolean {
  return res.returncode === 0;
}

export function result(returncode: number, stdout = "", stderr = "", truncated = false): RunResult {
  return { returncode, stdout, stderr, truncated };
}

const STDERR_CAP = 10_000;

export function execRunner(timeoutMs = 30_000, maxOutputBytes = 2_000_000): Runner {
  return (argv) =>
    new Promise<RunResult>((resolve) => {
      const [file, ...args] = argv;
      if (!file) return resolve(result(NOT_FOUND, "", "empty command"));
      const child = execFile(
        file,
        args,
        {
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: maxOutputBytes,
          encoding: "utf8",
          windowsHide: true,
          env: childEnv(GIT_ENV_KEYS, { GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" }),
        },
        (error, stdout, stderr) => {
          const err = stderr.slice(0, STDERR_CAP);
          if (!error) return resolve(result(0, stdout, err));
          const code: unknown = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return resolve(result(NOT_FOUND, "", `command not found: ${file}`));
          if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve(result(0, stdout.slice(0, maxOutputBytes), err, true));
          if (error.killed) return resolve(result(TIMED_OUT, stdout, `timed out after ${timeoutMs / 1000}s: ${file}`));
          resolve(result(typeof code === "number" ? code : 1, stdout, err || error.message.slice(0, STDERR_CAP)));
        },
      );
      child.stdin?.end();
    });
}

let override: Runner | null = null;
const fallback: Runner = execRunner();

export function getRunner(): Runner {
  return override ?? fallback;
}

/** Install a runner (tests inject a fake); `null` restores the `execFile` default. */
export function setRunner(runner: Runner | null): void {
  override = runner;
}
