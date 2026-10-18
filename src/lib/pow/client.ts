import { WorkerPool } from "../workers/pool";
import { WorkerUnavailableError } from "../workers/errors";
import { searchNonce } from "./solve";
import type { PowChallenge, PowForm, PowSolution, PowTasks } from "./types";

/**
 * Browser side of the sign-in proof-of-work: fetch a challenge, solve it in a Web Worker (lazy, one worker, started on
 * the first protected submit, never at page load), fall back to slices on the main thread when workers are missing.
 */

let pool: WorkerPool<PowTasks> | null = null;
const SOLVE_TIMEOUT_MS = 120_000;

async function solveInline(c: string, bits: number, signal?: AbortSignal): Promise<string> {
  const slice = 50_000;
  for (let start = 0; start < Number.MAX_SAFE_INTEGER; start += slice) {
    if (signal?.aborted) throw new DOMException("The operation was cancelled.", "AbortError");
    const found = searchNonce(c, bits, start, slice);
    if (found !== null) return String(found);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("no nonce found");
}

export async function solveChallenge(c: string, bits: number, signal?: AbortSignal): Promise<string> {
  pool ??= new WorkerPool<PowTasks>({ size: 1, create: () => new Worker(new URL("./pow.worker.ts", import.meta.url)) });
  try {
    return await pool.call("solve", { c, bits }, { signal, timeoutMs: SOLVE_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof WorkerUnavailableError) return solveInline(c, bits, signal);
    throw error;
  }
}

/**
 * A fresh challenge for `form`, solved. `bits`: the difficulty a 428 asked for (the server never issues less than its own
 * requirement). Throws on network errors (callers show a message).
 */
export async function fetchSolution(form: PowForm, signal?: AbortSignal, bits?: number): Promise<PowSolution> {
  const hint = typeof bits === "number" && Number.isInteger(bits) ? `&bits=${bits}` : "";
  const response = await fetch(`/api/account/challenge?form=${form}${hint}`, { credentials: "same-origin", cache: "no-store", signal });
  const body = (await response.json().catch(() => null)) as PowChallenge | null;
  if (!response.ok || !body || typeof body.c !== "string" || typeof body.bits !== "number") throw new Error(`challenge request failed (${response.status})`);
  return { c: body.c, nonce: await solveChallenge(body.c, body.bits, signal) };
}
