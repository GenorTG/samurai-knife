"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchAccount, fetchConversation, login as apiLogin, logout as apiLogout, resetConversation, saveConversation } from "@/lib/agent-client/api";
import { clearArtifacts } from "@/lib/agent-client/artifacts";
import { stopRequested } from "@/lib/agent-client/feedback";
import { repairTranscript, runAgentTurn, type LoopOutcome } from "@/lib/agent-client/loop";
import {
  attachQueue,
  clearQueue,
  enqueue,
  moveToSteering,
  pauseQueue,
  reclaimSteering,
  takeQueued,
  takeSteeringTexts,
} from "@/lib/agent-client/message-queue";
import { announceRun, runHeldElsewhere, subscribeRunAnnouncements, tryAcquireRun } from "@/lib/agent-client/run-lock";
import { runtime, useRuntime } from "@/lib/agent-client/runtime-store";
import type { AccountChoice, AccountInfo, TranscriptMessage } from "@/lib/agent-client/types";
import { appendChat, clearChat, readChat, replaceChat, saveChat, subscribeChat } from "./storage";

export type AccountState =
  | { kind: "loading" }
  | { kind: "ready"; account: AccountInfo }
  | { kind: "login"; accounts: AccountChoice[] }
  | { kind: "error"; message: string };

export interface AgentController {
  account: AccountState;
  messages: TranscriptMessage[];
  /** A turn is running or starting in THIS tab. */
  busy: boolean;
  activity: string | null;
  /** Run now when idle; otherwise queue (a run is active here, another tab holds the conversation, or the queue is draining). */
  send: (text: string) => void;
  /** Queued chip: steer it into the running turn at the next round boundary, or run it now when idle. */
  sendNow: (id: string) => void;
  stop: () => void;
  clear: () => void;
  refreshAccount: () => Promise<void>;
  login: (id: string, password: string) => Promise<string | null>;
  logout: () => Promise<void>;
}

const LOCK_POLL_MS = 1500;

/**
 * Owns the account session, the shared per-account conversation and the running agent turn.
 * Run state lives in the runtime store; this hook is the orchestrator around it:
 *  - one turn per account across tabs (run-lock.ts), the other tab queues;
 *  - a message sent during a run is queued (message-queue.ts) and drained in order when the run ends
 *    normally; Stop pauses the queue instead of firing the next message;
 *  - the transcript is a shared append-only log (storage.ts): this tab shows what other tabs append.
 * `onNeedSettings` fires when the model provider is missing.
 */
export function useAgent(options: { active: boolean; onNeedSettings: () => void }): AgentController {
  const { active, onNeedSettings } = options;
  const router = useRouter();
  const [account, setAccount] = useState<AccountState>({ kind: "loading" });
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [busy, setBusy] = useState(false);

  const accountIdRef = useRef<string | null>(null);
  const scopeIdRef = useRef<string | null>(null);
  const actionsRef = useRef<string[]>([]);
  const responseIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const persistQueueRef = useRef<Promise<void>>(Promise.resolve());
  const abortRef = useRef<AbortController | null>(null);
  /** The running (or starting) turn is being discarded by Clear: no "Stopped." notice, no queue pause. */
  const discardRef = useRef(false);
  const requested = useRef(false);
  const needSettings = useRef(onNeedSettings);
  useEffect(() => {
    needSettings.current = onNeedSettings;
  }, [onNeedSettings]);

  const run = useRuntime((s) => s.run);
  const lock = useRuntime((s) => s.lock);
  const paused = useRuntime((s) => s.paused);
  const queueLength = useRuntime((s) => s.queue.length);
  const activity = useRuntime((s) => s.activity);
  const accountId = account.kind === "ready" ? account.account.id : null;
  const localChatScope = account.kind === "ready"
    ? `${account.account.id}:${encodeURIComponent(account.account.provider?.baseUrl ?? "")}:${encodeURIComponent(account.account.provider?.model ?? "")}`
    : null;

  const applyAccount = useCallback((info: AccountInfo) => {
    const scopeId = `${info.id}:${encodeURIComponent(info.provider?.baseUrl ?? "")}:${encodeURIComponent(info.provider?.model ?? "")}`;
    accountIdRef.current = info.id;
    if (scopeIdRef.current !== scopeId) {
      scopeIdRef.current = scopeId;
      actionsRef.current = [];
      responseIdRef.current = null;
      sessionIdRef.current = null;
      setMessages(readChat(scopeId));
    }
    setAccount({ kind: "ready", account: info });
  }, []);

  const refreshAccount = useCallback(async () => {
    const result = await fetchAccount();
    if (result.ok) {
      const info = result.value;
      applyAccount(info);
      if (info.provider) {
        const scopeId = `${info.id}:${encodeURIComponent(info.provider.baseUrl)}:${encodeURIComponent(info.provider.model)}`;
        const local = readChat(scopeId);
        const remote = await fetchConversation();
        if (remote.ok) {
          actionsRef.current = remote.value.actions;
          responseIdRef.current = remote.value.responseId;
          sessionIdRef.current = remote.value.sessionId;
          if (remote.value.messages.length > 0) {
            const restored = remote.value.messages as TranscriptMessage[];
            saveChat(scopeId, restored);
            setMessages(restored);
          } else if (local.length > 0) {
            const saved = await saveConversation({ version: 1, messages: local, actions: [] });
            if (saved.ok) setMessages(local);
          } else setMessages([]);
        }
      }
      return;
    }
    const f = result.failure;
    if (f.kind === "login_required") setAccount({ kind: "login", accounts: f.accounts });
    else setAccount({ kind: "error", message: f.kind === "error" ? f.message : "Unexpected response." });
  }, [applyAccount]);

  // Transcript + journal only: the continuation (responseId/sessionId) is advanced by /api/agent/chat itself.
  const enqueueConversationSave = useCallback((history: TranscriptMessage[], actions: string[]): Promise<void> => {
    const pending = persistQueueRef.current.then(async () => {
      // No server copy loaded yet for this scope (or it was just cleared): nothing to save into.
      if (sessionIdRef.current) await saveConversation({ version: 1, messages: history, actions });
    });
    persistQueueRef.current = pending;
    return pending;
  }, []);

  // Load the account the first time the panel is shown (never during SSR or hydration).
  useEffect(() => {
    if (!active || requested.current) return;
    requested.current = true;
    void refreshAccount();
  }, [active, refreshAccount]);

  /* ----------------------------------------------- queue + cross-tab wiring */

  // Queue of the signed-in account, kept in sync with other tabs.
  useEffect(() => {
    const detach = attachQueue(accountId);
    return () => {
      detach();
      attachQueue(null);
    };
  }, [accountId]);

  // Transcript: show what other tabs append; a clear elsewhere ends a run here.
  useEffect(() => {
    if (!localChatScope) return;
    const scopeId = localChatScope;
    return subscribeChat(scopeId, (removed) => {
      if (removed) {
        actionsRef.current = [];
        responseIdRef.current = null;
        sessionIdRef.current = null;
        if (abortRef.current) {
          discardRef.current = true;
          abortRef.current.abort();
        }
        setMessages([]);
      } else {
        setMessages(readChat(scopeId));
      }
    });
  }, [localChatScope]);

  // Another tab's run: announced instantly, double-checked against the lock (a crashed tab never announces its end).
  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    void runHeldElsewhere(accountId).then((held) => {
      if (alive && held && !abortRef.current) runtime.setLock("other");
    });
    const off = subscribeRunAnnouncements((a) => {
      if (a.accountId !== accountId || abortRef.current) return;
      if (a.running) runtime.setLock("other", a.activity);
      else runtime.setLock("free");
    });
    return () => {
      alive = false;
      off();
    };
  }, [accountId]);

  useEffect(() => {
    if (!accountId || lock !== "other") return;
    const timer = setInterval(() => {
      void runHeldElsewhere(accountId).then((held) => {
        if (!held && runtime.get().lock === "other") runtime.setLock("free");
      });
    }, LOCK_POLL_MS);
    return () => clearInterval(timer);
  }, [accountId, lock]);

  /* ---------------------------------------------------------------- a turn */

  const startTurn = useCallback(
    async (text: string, queuedId: string | null, automatic: boolean): Promise<void> => {
      const id = accountIdRef.current;
      if (!id || account.kind !== "ready" || abortRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      const lease = await tryAcquireRun(id);
      const giveUp = (): void => {
        lease?.release();
        abortRef.current = null;
        setBusy(false);
      };
      if (!lease) {
        // Another tab holds the conversation: keep the message (queued) and show the banner.
        runtime.setLock("other");
        if (!queuedId) enqueue(text);
        abortRef.current = null;
        setBusy(false);
        return;
      }
      if (queuedId && !takeQueued(queuedId, { unlessPaused: automatic })) {
        giveUp(); // another tab already delivered it, or the queue was paused / cancelled meanwhile
        return;
      }

      runtime.setLock("mine");
      announceRun(id, true, null);
      let lastActivity: string | null = null;
      const offBroadcast = runtime.subscribe(() => {
        lease.renew();
        const now = runtime.get().activity;
        if (now !== lastActivity) {
          lastActivity = now;
          announceRun(id, true, now);
        }
      });

      let outcome: LoopOutcome = "error";
      try {
        await persistQueueRef.current;
        const durable = await fetchConversation();
        if (durable.ok) {
          actionsRef.current = durable.value.actions;
          responseIdRef.current = durable.value.responseId;
          sessionIdRef.current = durable.value.sessionId;
        }
        // Under the lock the stored transcript is ours to repair (a crashed run may have left unpaired tool calls).
        const scopeId = scopeIdRef.current ?? id;
        const stored = readChat(scopeId);
        const repaired = repairTranscript(stored);
        if (repaired.length !== stored.length) replaceChat(scopeId, repaired);
        const history = appendChat(scopeId, [{ role: "user", content: text }]);
        setMessages(history);
        await enqueueConversationSave(history, actionsRef.current);
        outcome = await runAgentTurn({
          history,
          accountName: account.account.displayName,
          signal: controller.signal,
          openClawResponses: account.account.provider?.openClawResponses === true,
          previousResponseId: responseIdRef.current,
          recentActions: actionsRef.current,
          onResponseId: (responseId) => {
            responseIdRef.current = responseId;
          },
          onAction: (action) => {
            if (actionsRef.current.at(-1) !== action) actionsRef.current = [...actionsRef.current, action].slice(-40);
            enqueueConversationSave(readChat(scopeId), actionsRef.current);
          },
          navigate: (href) => router.push(href),
          onMessage: (m) => {
            const updated = appendChat(scopeId, [m]);
            setMessages(updated);
            enqueueConversationSave(updated, actionsRef.current);
          },
          takeSteering: takeSteeringTexts,
        });
        if (outcome === "aborted" && !discardRef.current) {
          const stopped = appendChat(scopeId, [{ role: "notice", level: "info", content: "Stopped." }]);
          setMessages(stopped);
          enqueueConversationSave(stopped, actionsRef.current);
        }
      } finally {
        offBroadcast();
        // Everything that decides what happens to the queue must be written BEFORE the lock is released.
        reclaimSteering();
        if (discardRef.current) clearQueue();
        else if (outcome === "aborted") pauseQueue("stopped");
        else if (outcome === "error" || outcome === "login_required" || outcome === "provider_missing") pauseQueue("failed");
        discardRef.current = false;
        lease.release();
        runtime.setLock("free");
        announceRun(id, false, null);
        abortRef.current = null;
        setBusy(false);
      }
      if (outcome === "login_required") void refreshAccount();
      else if (outcome === "provider_missing") needSettings.current();
    },
    [account, enqueueConversationSave, refreshAccount, router],
  );

  // Drain: when idle, not paused and nobody else runs, the oldest queued message starts the next turn.
  useEffect(() => {
    if (account.kind !== "ready" || busy || run !== "idle" || lock === "other" || paused || queueLength === 0) return;
    const next = runtime.get().queue[0];
    if (next) void startTurn(next.text, next.id, true);
  }, [account.kind, busy, run, lock, paused, queueLength, startTurn]);

  const stop = useCallback(() => {
    if (!abortRef.current) return;
    stopRequested();
    abortRef.current.abort();
  }, []);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || account.kind !== "ready") return;
      const s = runtime.get();
      const mustQueue = abortRef.current !== null || s.lock === "other" || (s.queue.length > 0 && s.paused === null);
      if (mustQueue) enqueue(trimmed);
      else void startTurn(trimmed, null, false);
    },
    [account.kind, startTurn],
  );

  const sendNow = useCallback(
    (id: string) => {
      if (abortRef.current) {
        moveToSteering(id); // a turn is running here: delivered at its next model-round boundary
        return;
      }
      if (runtime.get().lock === "other") return;
      const item = runtime.get().queue.find((q) => q.id === id);
      if (item) void startTurn(item.text, item.id, false);
    },
    [startTurn],
  );

  const clear = useCallback(() => {
    if (abortRef.current) {
      discardRef.current = true;
      abortRef.current.abort();
    }
    const scopeId = scopeIdRef.current;
    if (scopeId) clearChat(scopeId);
    actionsRef.current = [];
    responseIdRef.current = null;
    sessionIdRef.current = null;
    persistQueueRef.current = persistQueueRef.current.then(async () => { await resetConversation(); });
    clearArtifacts();
    clearQueue();
    setMessages([]);
  }, []);

  const login = useCallback(
    async (id: string, password: string): Promise<string | null> => {
      const result = await apiLogin(id, password);
      if (!result.ok) {
        const f = result.failure;
        if (f.kind !== "error") return "Login failed.";
        if (f.message === "email_not_verified") return "Confirm your email address first (open the link we sent you).";
        if (f.message === "account_disabled") return "This account is disabled.";
        if (f.message === "rate_limited") return "Too many attempts. Wait a minute and try again.";
        return f.status === 401 || f.status === 403 ? "Wrong password." : f.message;
      }
      await refreshAccount();
      return null;
    },
    [refreshAccount],
  );

  const logout = useCallback(async () => {
    abortRef.current?.abort();
    await apiLogout();
    accountIdRef.current = null;
    scopeIdRef.current = null;
    actionsRef.current = [];
    responseIdRef.current = null;
    sessionIdRef.current = null;
    setMessages([]);
    await refreshAccount();
  }, [refreshAccount]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Reload / tab close mid-run kills the run like Stop would: keep the queue, but do not let another tab fire it unasked.
  useEffect(() => {
    const onHide = (): void => {
      if (!abortRef.current) return;
      reclaimSteering();
      pauseQueue("stopped");
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  // A live run (here or in another tab) legitimately has tool calls without a result yet; an idle chat shows them as interrupted.
  const live = busy || lock === "other";
  const shown = useMemo(() => (live ? messages : repairTranscript(messages)), [live, messages]);

  return { account, messages: shown, busy, activity, send, sendNow, stop, clear, refreshAccount, login, logout };
}
