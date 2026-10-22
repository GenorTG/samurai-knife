/**
 * The workflow JavaScript sandbox (docs/WORKFLOWS.md "Rules"): QuickJS compiled to WebAssembly. User code (Code node,
 * expressions) sees only the ECMAScript built-ins plus what a session injects as JSON, and a `console` that appends to a
 * capped log; there is no `require`, `process`, network, timer, file or host object to reach. Data leaves as JSON text.
 *
 * Limits per session: heap, stack, and one wall-clock deadline (the interrupt handler stops a busy loop). A session that
 * hit a limit, or any engine-level failure, poisons the WASM instance: it is dropped without being freed (QuickJS can
 * assert while freeing a runtime that ran out of memory or stack) and the next session gets a new instance. The worker
 * process around this is the second wall (permission model, heap cap, kill on timeout).
 */
import variant from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";

export interface SandboxLimits {
  memoryBytes: number;
  stackBytes: number;
  timeoutMs: number;
  maxLogLines: number;
  maxLogLineChars: number;
  /** Largest JSON result accepted back from the sandbox. */
  maxOutputBytes: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 256 * 1024,
  timeoutMs: 10_000,
  maxLogLines: 200,
  maxLogLineChars: 2000,
  maxOutputBytes: 32 * 1024 * 1024,
};

export type SandboxErrorKind = "timeout" | "memory" | "stack" | "code" | "output";

/** `message` is safe to show the workflow's owner (it is their code's error or a limit). */
export class SandboxError extends Error {
  readonly kind: SandboxErrorKind;
  readonly line?: number;
  constructor(kind: SandboxErrorKind, message: string, line?: number) {
    super(message);
    this.name = "SandboxError";
    this.kind = kind;
    this.line = line;
  }
}

let current: Promise<QuickJSWASMModule> | null = null;

function wasmModule(): Promise<QuickJSWASMModule> {
  current ??= newQuickJSWASMModuleFromVariant(variant);
  return current;
}

/** Drop the current instance; the next session instantiates a fresh one. */
function poison(): void {
  current = null;
}

const PRELUDE = `
(() => {
  const fmt = (v) => {
    if (typeof v === "string") return v;
    try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch { return String(v); }
  };
  const log = (...a) => __hostLog(a.map(fmt).join(" "));
  globalThis.console = { log, info: log, warn: log, error: log, debug: log };
  globalThis.__ser = (v) => (v === undefined ? "u" : "j" + JSON.stringify(v));
})();
`;

export class Sandbox {
  readonly logs: string[] = [];
  private readonly runtime: QuickJSRuntime;
  private readonly ctx: QuickJSContext;
  private readonly limits: SandboxLimits;
  private broken = false;
  private disposed = false;
  /** The time limit the current deadline came from (for the error message). */
  private limitMs: number;

  constructor(runtime: QuickJSRuntime, ctx: QuickJSContext, limits: SandboxLimits) {
    this.runtime = runtime;
    this.ctx = ctx;
    this.limits = limits;
    this.limitMs = limits.timeoutMs;
  }

  /** A fresh deadline from now (per evaluation: each expression of a node gets its own time). */
  setDeadline(ms: number): void {
    this.limitMs = ms;
    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + ms));
  }

  /** Makes `globalThis[name]` a deep copy of `value` (JSON round trip). */
  setJson(name: string, value: unknown): void {
    const text = JSON.stringify(value === undefined ? null : value);
    const str = this.ctx.newString(text);
    this.ctx.setProp(this.ctx.global, "__tmp", str);
    str.dispose();
    this.exec(`globalThis[${JSON.stringify(name)}] = JSON.parse(globalThis.__tmp); delete globalThis.__tmp;`);
  }

  /** Runs a script for its side effects (definitions); throws SandboxError. */
  exec(source: string): void {
    const handle = this.evalHandle(source);
    handle.dispose();
  }

  /**
   * Runs a script and returns its completion value as plain data. A promise result is settled first (async code works;
   * nothing can settle it later, since there are no timers or I/O, so a still-pending promise is an error).
   */
  run(source: string): unknown {
    const handle = this.evalHandle(source);
    let value = handle;
    try {
      const state = this.ctx.getPromiseState(handle);
      if (state.type === "pending") {
        this.drainJobs();
        const settled = this.ctx.getPromiseState(handle);
        if (settled.type === "pending") throw new SandboxError("code", "The code returned a promise that never settles (no timers or network exist in the sandbox).");
        value = this.unwrapSettled(settled);
      } else if (state.type === "fulfilled" && state.notAPromise) {
        if (state.value !== handle && state.value.alive) state.value.dispose();
      } else {
        value = this.unwrapSettled(state);
      }
      return this.serialize(value);
    } finally {
      if (value !== handle) value.dispose();
      handle.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.broken) return poison();
    try {
      this.ctx.dispose();
      this.runtime.dispose();
    } catch {
      poison();
    }
  }

  private unwrapSettled(state: ReturnType<QuickJSContext["getPromiseState"]>): QuickJSHandle {
    if (state.type === "fulfilled") return state.value;
    if (state.type === "rejected") {
      const error = this.describe(state.error);
      state.error.dispose();
      throw error;
    }
    throw new SandboxError("code", "unsettled promise");
  }

  private drainJobs(): void {
    for (let round = 0; round < 10_000; round += 1) {
      const result = this.runtime.executePendingJobs(-1);
      if (result.error) {
        const error = this.describe(result.error);
        result.error.dispose();
        throw error;
      }
      if (result.value === 0 || !this.runtime.hasPendingJob()) return;
    }
  }

  private evalHandle(source: string): QuickJSHandle {
    if (this.disposed || this.broken) throw new SandboxError("code", "sandbox already closed");
    let result: ReturnType<QuickJSContext["evalCode"]>;
    try {
      result = this.ctx.evalCode(source, "code.js");
    } catch (error) {
      // An exception out of the WASM itself (host stack exhausted, abort): this instance is unusable.
      this.broken = true;
      const message = error instanceof Error ? error.message : String(error);
      if (/call stack/i.test(message)) throw new SandboxError("stack", "The code recursed too deeply.");
      throw new SandboxError("memory", "The sandbox stopped: the code used too much memory or stack.");
    }
    if (result.error) {
      const error = this.describe(result.error);
      result.error.dispose();
      throw error;
    }
    return result.value;
  }

  private serialize(value: QuickJSHandle): unknown {
    const ser = this.ctx.getProp(this.ctx.global, "__ser");
    try {
      const out = this.ctx.callFunction(ser, this.ctx.undefined, value);
      if (out.error) {
        const error = this.describe(out.error);
        out.error.dispose();
        if (error.kind === "code") throw new SandboxError("output", `The result is not plain data: ${error.message}`);
        throw error;
      }
      const text = this.ctx.getString(out.value);
      out.value.dispose();
      if (text.length > this.limits.maxOutputBytes) throw new SandboxError("output", `The result is larger than ${Math.round(this.limits.maxOutputBytes / 1048576)} MB.`);
      return text === "u" ? undefined : (JSON.parse(text.slice(1)) as unknown);
    } finally {
      ser.dispose();
    }
  }

  private describe(handle: QuickJSHandle): SandboxError {
    const dumped: unknown = this.ctx.dump(handle);
    const record = dumped && typeof dumped === "object" ? (dumped as { name?: unknown; message?: unknown; stack?: unknown }) : null;
    const name = typeof record?.name === "string" ? record.name : "";
    const message = typeof record?.message === "string" ? record.message : typeof dumped === "string" ? dumped : JSON.stringify(dumped) ?? "error";
    if (name === "InternalError" || message === "interrupted") {
      this.broken = true;
      if (message === "interrupted") return new SandboxError("timeout", `The code ran longer than ${this.limitMs / 1000} s.`);
      if (/out of memory/i.test(message)) return new SandboxError("memory", `The code used more than ${Math.round(this.limits.memoryBytes / 1048576)} MB.`);
      if (/stack overflow/i.test(message)) return new SandboxError("stack", "The code recursed too deeply.");
      return new SandboxError("code", message);
    }
    if (/out of memory/i.test(message)) {
      this.broken = true;
      return new SandboxError("memory", `The code used more than ${Math.round(this.limits.memoryBytes / 1048576)} MB.`);
    }
    const stack = typeof record?.stack === "string" ? record.stack : "";
    const line = /code\.js:(\d+)/.exec(stack)?.[1];
    return new SandboxError("code", name && name !== "Error" ? `${name}: ${message}` : message, line ? Number(line) : undefined);
  }

  /** @internal host side of console.* */
  pushLog(line: string): void {
    if (this.logs.length >= this.limits.maxLogLines) return;
    const cut = line.length > this.limits.maxLogLineChars ? `${line.slice(0, this.limits.maxLogLineChars)}…` : line;
    this.logs.push(this.logs.length === this.limits.maxLogLines - 1 ? "… (more log lines dropped)" : cut);
  }
}

/** One fresh runtime + context with the prelude; dispose it when done. */
export async function openSandbox(overrides: Partial<SandboxLimits> = {}): Promise<Sandbox> {
  const limits = { ...DEFAULT_SANDBOX_LIMITS, ...overrides };
  const quickjs = await wasmModule();
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.timeoutMs));
  const ctx = runtime.newContext();
  const sandbox = new Sandbox(runtime, ctx, limits);
  const hostLog = ctx.newFunction("__hostLog", (line) => {
    sandbox.pushLog(ctx.typeof(line) === "string" ? ctx.getString(line) : String(ctx.dump(line)));
  });
  ctx.setProp(ctx.global, "__hostLog", hostLog);
  hostLog.dispose();
  sandbox.exec(PRELUDE);
  return sandbox;
}
