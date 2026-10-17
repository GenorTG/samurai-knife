/**
 * The global budget for password hashing (scrypt at N=2^17 costs ~128 MiB and a few hundred ms of a libuv thread). Every
 * async hash or verify in the server runs through `withHashSlot`: at most KNIFE_SCRYPT_CONCURRENCY run at once (default
 * 2), at most KNIFE_SCRYPT_QUEUE wait (default 32), anything beyond is refused at once with `HashBusyError` (routes answer
 * 503 + Retry-After). Threat: unauthenticated requests (login, register, reset) turning into unbounded CPU/memory work
 * and starving the libuv pool that fs, DNS and zlib share. The queue is FIFO; a waiter never waits longer than the
 * queue ahead of it.
 */

export class HashBusyError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds = 5) {
    super("The server is busy checking passwords. Try again in a few seconds.");
    this.name = "HashBusyError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw >= min && raw <= max ? raw : fallback;
}

interface GateState {
  running: number;
  waiting: (() => void)[];
}

const KEY = Symbol.for("samurai-knife.hash-gate.v1");

function state(): GateState {
  const g = globalThis as unknown as Record<symbol, GateState | undefined>;
  const current = g[KEY];
  if (current && typeof current.running === "number" && Array.isArray(current.waiting)) return current;
  const fresh: GateState = { running: 0, waiting: [] };
  g[KEY] = fresh;
  return fresh;
}

export function hashGateStats(): { running: number; waiting: number; concurrency: number; queue: number } {
  const s = state();
  return { running: s.running, waiting: s.waiting.length, concurrency: concurrency(), queue: queueCap() };
}

const concurrency = () => envInt("KNIFE_SCRYPT_CONCURRENCY", 2, 1, 16);
const queueCap = () => envInt("KNIFE_SCRYPT_QUEUE", 32, 0, 1_000);

/** Runs `fn` when a slot is free; throws HashBusyError (without running it) when the queue is full. */
export async function withHashSlot<T>(fn: () => Promise<T>): Promise<T> {
  const s = state();
  if (s.running >= concurrency()) {
    if (s.waiting.length >= queueCap()) throw new HashBusyError(Math.max(1, Math.ceil((s.waiting.length + s.running) / concurrency())));
    await new Promise<void>((resolve) => s.waiting.push(resolve));
  } else {
    s.running += 1;
  }
  try {
    return await fn();
  } finally {
    const next = s.waiting.shift();
    // The slot passes straight to the next waiter (running stays the same), so nobody can jump the queue.
    if (next) next();
    else s.running -= 1;
  }
}
