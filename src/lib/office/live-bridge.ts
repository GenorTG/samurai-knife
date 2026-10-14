import { LIVE_PROTOCOL, parseHello, parsePortMessage, type LiveCommand, type LiveEditor, type LiveHello } from "./live-protocol";

/**
 * Browser end of the live-editing channel to the editor plugin (protocol: live-protocol.ts, contract docs/SIDECARS.md).
 * One bridge per open editor. It accepts a plugin `hello` only when ALL hold:
 *   - event.origin is the sidecar's public origin,
 *   - the token equals this session's token (minted server-side per editor config),
 *   - event.source is a frame nested in OUR editor iframe (source.parent === editor iframe window),
 * then hands the plugin a private MessagePort; commands and answers never touch window messaging again.
 * The active bridge is registered module-wide so the assistant's doc_live_* tools and page snapshots can find it.
 */

export type LiveState =
  | { state: "connecting"; since: number }
  | { state: "connected"; editor: LiveEditor | "unknown"; viewMode: boolean; title: string; plugin: string; commands: string[]; since: number }
  | { state: "unavailable"; reason: string };

export interface LiveCallResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  ms?: number;
}

/** The subset of Window the bridge uses (a fake in unit tests). */
export interface BridgeWindow {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export interface LiveBridgeOptions {
  token: string;
  /** Origin of the sidecar's public URL (where the editor and the plugin are served from). */
  sidecarOrigin: string;
  docId: string;
  docName: string;
  /** The editor iframe DocsAPI created; looked up on each hello (it is created after the bridge starts). */
  editorFrame: () => { contentWindow: unknown } | null;
  win?: BridgeWindow;
  /** No hello by then -> unavailable (old sidecar container without the plugin, or plugins disabled). */
  connectTimeoutMs?: number;
  pingEveryMs?: number;
  pongTimeoutMs?: number;
  /** MessageChannel factory (tests inject Node's). */
  channel?: () => MessageChannel;
}

interface Pending {
  resolve: (result: LiveCallResult) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export class OfficeLiveBridge {
  readonly docId: string;
  readonly docName: string;
  private readonly options: LiveBridgeOptions;
  private readonly win: BridgeWindow;
  private status: LiveState = { state: "connecting", since: Date.now() };
  private port: MessagePort | null = null;
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(state: LiveState) => void>();
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(options: LiveBridgeOptions) {
    this.options = options;
    this.docId = options.docId;
    this.docName = options.docName;
    const fallback = typeof window === "undefined" ? null : (window as BridgeWindow);
    const win = options.win ?? fallback;
    if (!win) throw new Error("OfficeLiveBridge needs a window");
    this.win = win;
    this.onWindowMessage = this.onWindowMessage.bind(this);
  }

  start(): void {
    this.win.addEventListener("message", this.onWindowMessage);
    this.armConnectTimeout();
  }

  stop(): void {
    this.stopped = true;
    this.win.removeEventListener("message", this.onWindowMessage);
    this.clearTimers();
    this.port?.close();
    this.port = null;
    this.failPending("the editor was closed");
    this.listeners.clear();
  }

  get state(): LiveState {
    return this.status;
  }

  get connected(): boolean {
    return this.status.state === "connected";
  }

  subscribe(listener: (state: LiveState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Exposed for tests; the window listener calls it. */
  onWindowMessage(event: MessageEvent): void {
    if (this.stopped || event.origin !== this.options.sidecarOrigin) return;
    const hello = parseHello(event.data, this.options.token);
    if (!hello) return;
    const frame = this.options.editorFrame();
    const source = event.source as { parent?: unknown; postMessage?: (message: unknown, targetOrigin: string, transfer: Transferable[]) => void } | null;
    // The plugin frame is a child of the editor frame, which is the iframe this page created.
    if (!frame || !frame.contentWindow || !source || source.parent !== frame.contentWindow || typeof source.postMessage !== "function") return;
    this.adopt(hello, source as { postMessage: (message: unknown, targetOrigin: string, transfer: Transferable[]) => void });
  }

  private adopt(hello: LiveHello, source: { postMessage: (message: unknown, targetOrigin: string, transfer: Transferable[]) => void }): void {
    const channel = this.options.channel ? this.options.channel() : new MessageChannel();
    this.port?.close();
    this.failPending("the editor plugin reconnected");
    this.port = channel.port1;
    this.port.onmessage = (event: MessageEvent) => this.onPortMessage(event);
    source.postMessage({ protocol: LIVE_PROTOCOL, kind: "welcome", token: this.options.token }, this.options.sidecarOrigin, [channel.port2]);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.setState({ state: "connected", editor: hello.editor, viewMode: hello.viewMode, title: hello.title, plugin: hello.plugin, commands: hello.commands, since: Date.now() });
    this.startPing();
  }

  private onPortMessage(event: MessageEvent): void {
    const msg = parsePortMessage(event.data);
    if (!msg) return;
    if (msg.kind === "pong") {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
      return;
    }
    const waiting = this.pending.get(msg.id);
    if (!waiting) return;
    this.pending.delete(msg.id);
    waiting.cleanup();
    waiting.resolve({ ok: msg.ok, data: msg.data, error: msg.error, ms: msg.ms });
  }

  /** Runs one plugin command. Never throws: failures come back as {ok:false, error}. */
  call(cmd: LiveCommand, args: Record<string, unknown>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<LiveCallResult> {
    const port = this.port;
    if (!port || this.status.state !== "connected") {
      const why = this.status.state === "unavailable" ? this.status.reason : "the editor plugin is not connected yet";
      return Promise.resolve({ ok: false, error: why });
    }
    if (options.signal?.aborted) return Promise.resolve({ ok: false, error: "Stopped by the user." });
    const id = `q${++this.seq}`;
    const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    return new Promise<LiveCallResult>((resolve) => {
      const onAbort = () => finish({ ok: false, error: "Stopped by the user (the editor may still finish this command)." });
      const finish = (result: LiveCallResult) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        entry.cleanup();
        resolve(result);
      };
      const entry: Pending = {
        resolve,
        timer: setTimeout(() => finish({ ok: false, error: `the editor did not answer within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs),
        cleanup: () => {
          clearTimeout(entry.timer);
          options.signal?.removeEventListener("abort", onAbort);
        },
      };
      this.pending.set(id, entry);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      port.postMessage({ protocol: LIVE_PROTOCOL, kind: "request", id, cmd, args });
    });
  }

  private setState(next: LiveState): void {
    this.status = next;
    for (const listener of this.listeners) listener(next);
  }

  private armConnectTimeout(): void {
    const ms = this.options.connectTimeoutMs ?? 45_000;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (this.status.state === "connecting") {
        this.setState({
          state: "unavailable",
          reason: "the assistant plugin did not connect (restart the office service on the Sidecar services page to install it)",
        });
      }
    }, ms);
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const every = this.options.pingEveryMs ?? 15_000;
    const wait = this.options.pongTimeoutMs ?? 8_000;
    this.pingTimer = setInterval(() => {
      if (!this.port || this.pongTimer || this.pending.size > 0) return;
      this.port.postMessage({ protocol: LIVE_PROTOCOL, kind: "ping", id: `p${++this.seq}` });
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        // Lost (editor reloaded or crashed): wait for the plugin's next hello.
        this.port?.close();
        this.port = null;
        this.failPending("the editor plugin stopped answering");
        this.setState({ state: "connecting", since: Date.now() });
        this.armConnectTimeout();
      }, wait);
    }, every);
  }

  private failPending(error: string): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.cleanup();
      entry.resolve({ ok: false, error });
    }
  }

  private clearTimers(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.connectTimer = this.pingTimer = this.pongTimer = null;
  }
}

/* ------------------------------------------------------------------------------------------- active bridge */

let active: OfficeLiveBridge | null = null;
const activeListeners = new Set<() => void>();

/** The editor on this page registers its bridge; null when it closes. */
export function setActiveLiveBridge(bridge: OfficeLiveBridge | null): void {
  active = bridge;
  // Debug handle for the browser console and the real-editor e2e (tests/office_live_e2e.py): window.knifeOfficeLive.call(...).
  if (typeof window !== "undefined") (window as unknown as { knifeOfficeLive?: OfficeLiveBridge | null }).knifeOfficeLive = bridge;
  for (const listener of activeListeners) listener();
}

export function activeLiveBridge(): OfficeLiveBridge | null {
  return active;
}

export function onActiveLiveBridgeChange(listener: () => void): () => void {
  activeListeners.add(listener);
  return () => activeListeners.delete(listener);
}

/** Editor type of a connected bridge, else null (decides which doc_live_* tools the model sees). */
export function connectedLiveEditor(): LiveEditor | null {
  const state = active?.state;
  return state?.state === "connected" && state.editor !== "unknown" ? state.editor : null;
}
