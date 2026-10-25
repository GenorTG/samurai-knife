"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CraftReply } from "@/lib/craft/live";

/**
 * The Smart Knife side of the Craft bridge (sidecars/craft/knife-bridge/bridge.js, docs/SIDECARS.md "Craft files"): a
 * hidden iframe of ours on the craft origin, a MessagePort to it, the account check that must finish before the app
 * loads, then the app's Save and Open requests. Every message from the port is untrusted (app code shares the craft
 * origin with the bridge): types, sizes and names are checked here, and files only ever go to the app after the person
 * picked them in our own chooser. The assistant's calls into the app (`agentCall`) go the same way and come back as
 * plain JSON, matched by id.
 */

export type BridgeState = { kind: "connecting" } | { kind: "ready"; wiped: boolean } | { kind: "failed"; message: string };

export interface SaveRequest {
  name: string;
  mime: string;
  bytes: ArrayBuffer;
}

export interface OpenRequest {
  id: number;
  accept: string;
  multiple: boolean;
}

export interface PickedFile {
  name: string;
  mime: string;
  bytes: ArrayBuffer;
  lastModified?: number;
}

const MAX_SAVE = 50 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 20_000;
/** The bridge gives up after 60 s; this only catches a bridge that never answers. */
const AGENT_TIMEOUT_MS = 70_000;

type Pending = { resolve: (reply: CraftReply) => void; timer: ReturnType<typeof setTimeout>; method: string };

export function useCraftBridge(options: {
  origin: string;
  accountTag: string;
  onSave: (request: SaveRequest) => void;
  onTooBig: (name: string, size: number) => void;
  onOpen: (request: OpenRequest) => void;
}) {
  const { origin, accountTag } = options;
  const frame = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  const handlers = useRef(options);
  const [state, setState] = useState<BridgeState>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);
  const pending = useRef(new Map<number, Pending>());
  const nextId = useRef(1);

  const settleAll = useCallback((error: string) => {
    for (const [id, entry] of pending.current) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error });
      pending.current.delete(id);
    }
  }, []);

  useEffect(() => {
    handlers.current = options;
  });

  // Each (re)connect starts from a fresh frame load (`attempt` is in its key).
  useEffect(() => {
    const timer = setTimeout(() => {
      setState((current) => (current.kind === "connecting" ? { kind: "failed", message: "The Craft apps' file bridge did not answer." } : current));
    }, CONNECT_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
      port.current?.close();
      port.current = null;
      settleAll("the Craft app was closed");
    };
  }, [attempt, origin, settleAll]);

  const onBridgeLoad = useCallback(() => {
    const target = frame.current?.contentWindow;
    if (!target) return;
    port.current?.close();
    settleAll("the Craft bridge reconnected");
    const channel = new MessageChannel();
    port.current = channel.port1;
    channel.port1.onmessage = (event: MessageEvent) => {
      const message = event.data as Record<string, unknown> | null;
      if (!message || typeof message !== "object") return;
      switch (message.type) {
        case "hello":
          channel.port1.postMessage({ type: "account", tag: accountTag });
          break;
        case "account-ok":
          setState({ kind: "ready", wiped: message.wiped === true });
          break;
        case "save": {
          const bytes = message.bytes;
          if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > MAX_SAVE) return;
          handlers.current.onSave({ name: String(message.name ?? "untitled").slice(0, 400), mime: String(message.mime ?? "").slice(0, 200), bytes });
          break;
        }
        case "save-too-big":
          handlers.current.onTooBig(String(message.name ?? "file").slice(0, 400), Number(message.size) || 0);
          break;
        case "open":
          if (!Number.isInteger(message.id)) return;
          handlers.current.onOpen({ id: message.id as number, accept: String(message.accept ?? "").slice(0, 500), multiple: message.multiple === true });
          break;
        case "agent-result": {
          const id = message.id;
          const entry = typeof id === "number" ? pending.current.get(id) : undefined;
          if (!entry) return;
          pending.current.delete(id as number);
          clearTimeout(entry.timer);
          // readFile's bytes are the only binary result: an ArrayBuffer up to the save limit, nothing else passes. Other
          // answers may carry a `bytes` field of their own (VectorCraft's export reports its size there): plain JSON.
          const result = message.result as { bytes?: unknown } | null;
          if (entry.method === "readFile" && message.ok === true && !(result && typeof result === "object" && result.bytes instanceof ArrayBuffer && result.bytes.byteLength <= MAX_SAVE)) {
            entry.resolve({ ok: false, error: "the app sent an invalid file" });
            break;
          }
          entry.resolve(message.ok === true ? { ok: true, result: message.result } : { ok: false, error: String(message.error ?? "the app reported an error").slice(0, 500) });
          break;
        }
        case "error":
          setState((current) => (current.kind === "connecting" ? { kind: "failed", message: String(message.message ?? "bridge error").slice(0, 300) } : current));
          break;
      }
    };
    // Only to the craft origin: if the frame shows anything else (an error page), nothing is sent.
    target.postMessage({ type: "knife-bridge:hello" }, origin, [channel.port2]);
  }, [origin, accountTag, settleAll]);

  /** After each load of the app frame (an app may reload itself, e.g. with ?webgl). */
  const attach = useCallback(() => port.current?.postMessage({ type: "attach" }), []);

  const deliver = useCallback((id: number, files: PickedFile[]) => {
    port.current?.postMessage({ type: "files", id, files }, files.map((file) => file.bytes));
  }, []);

  const cancel = useCallback((id: number) => port.current?.postMessage({ type: "cancel", id }), []);

  /** Call the app's agent API (`window.<app>[method](...args)`) through the bridge; never rejects. */
  const agentCall = useCallback((method: string, args: unknown[] = [], signal?: AbortSignal, transfer: Transferable[] = []): Promise<CraftReply> => {
    const target = port.current;
    if (!target) return Promise.resolve({ ok: false, error: "the Craft bridge is not connected" });
    if (signal?.aborted) return Promise.resolve({ ok: false, error: "Stopped by the user." });
    const id = nextId.current++;
    return new Promise<CraftReply>((resolve) => {
      const done = (reply: CraftReply) => {
        if (!pending.current.delete(id)) return;
        clearTimeout(timer);
        resolve(reply);
      };
      const timer = setTimeout(() => done({ ok: false, error: "the Craft app did not answer" }), AGENT_TIMEOUT_MS);
      pending.current.set(id, { resolve, timer, method });
      signal?.addEventListener("abort", () => done({ ok: false, error: "Stopped by the user." }), { once: true });
      target.postMessage({ type: "agent", id, method, args }, transfer);
    });
  }, []);

  const retry = useCallback(() => {
    setState({ kind: "connecting" });
    setAttempt((value) => value + 1);
  }, []);

  return { frame, state, attempt, onBridgeLoad, attach, deliver, cancel, retry, agentCall };
}
