"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { clearAccountStorage } from "@/lib/client-account";
import { fetchAccount, fetchConversation, login as apiLogin, logout as apiLogout, resetConversation, saveConversation } from "@/lib/agent-client/api";
import { clearArtifacts } from "@/lib/agent-client/artifacts";
import { stopRequested } from "@/lib/agent-client/feedback";
import { repairTranscript, runAgentTurn, type LoopOutcome } from "@/lib/agent-client/loop";
import { extendsTranscript, pickTranscript } from "@/lib/agent-client/context";
import {
  attachQueue,
  clearQueue,
  enqueue,
  moveToSteering,
  nextQueued,
  pauseQueue,
  reclaimSteering,
  takeQueued,
  takeSteeringTexts,
} from "@/lib/agent-client/message-queue";
import { announceRun, runHeldElsewhere, runningChatCount, subscribeRunAnnouncements, tryAcquireRun } from "@/lib/agent-client/run-lock";
import { runtimeFor, setForegroundChat, useRuntime } from "@/lib/agent-client/runtime-store";
import type { AccountChoice, AccountInfo, TranscriptMessage } from "@/lib/agent-client/types";
import { appendChat, clearChat, clearLegacyChat, readChat, readLegacyChat, replaceChat, saveChat, subscribeChat } from "./storage";

export type AccountState =
  | { kind: "loading" }
  | { kind: "ready"; account: AccountInfo }
  | { kind: "login"; accounts: AccountChoice[] }
  | { kind: "error"; message: string };

export interface AgentController {
  account: AccountState;
  messages: TranscriptMessage[];
  /** A turn of the SELECTED chat is running or starting in THIS tab. */
  busy: boolean;
  /** Chats of this tab with a running turn (the selected one included). */
  runningChats: readonly string[];
  activity: string | null;
  /** Run now when idle; otherwise queue (a run is active here, another tab holds the conversation, or the queue is draining). */
  send: (text: string) => void;
  /** Queued chip: steer it into the running turn at the next round boundary, or run it now when idle. */
  sendNow: (id: string) => void;
  stop: () => void;
  clear: () => void;
  switchChat: (chatId: string) => void;
  refreshAccount: () => Promise<void>;
  login: (id: string, password: string) => Promise<string | null>;
  logout: () => Promise<void>;
}

const LOCK_POLL_MS = 1500;
/** Chats of one account that may run at once (all tabs of this browser); more wait in their chat's queue. */
export const MAX_RUNNING_CHATS = 3;

/** Per-chat bookkeeping of this tab: a chat keeps its run, journal and save chain when the user looks at another. */
interface ChatRun {
  abort: AbortController | null;
  /** The running (or starting) turn is being discarded by Clear: no "Stopped." notice, no queue pause. */
  discard: boolean;
  actions: string[];
  /** The server copy of this chat is loaded (nothing to save into before, or right after a Clear). */
  loaded: boolean;
  persist: Promise<void>;
}

/**
 * Owns the account session, one chat's transcript and the running agent turn.
 * Run state lives in the runtime store; this hook is the orchestrator around it:
 *  - one turn per chat across tabs (run-lock.ts), the other tab queues; different chats may run concurrently;
 *  - a message sent during a run is queued (message-queue.ts) and drained in order when the run ends
 *    normally; Stop pauses the queue instead of firing the next message;
 *  - the transcript is a shared append-only log (storage.ts): this tab shows what other tabs append.
 * `onNeedSettings` fires when the model provider is missing.
 */
export function useAgent(options: { active: boolean; chatId?: string; onNeedSettings: () => void }): AgentController {
  const { active, onNeedSettings } = options;
  const chatId = options.chatId ?? "default";
  const selectedChatId = useRef(chatId);
  useLayoutEffect(() => {
    selectedChatId.current = chatId;
  }, [chatId]);
  const router = useRouter();
  const [account, setAccount] = useState<AccountState>({ kind: "loading" });
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);

  const accountIdRef = useRef<string | null>(null);
  const scopeIdRef = useRef<string | null>(null);
  const chatsRef = useRef(new Map<string, ChatRun>());
  const chatRun = useCallback((id: string): ChatRun => {
    let entry = chatsRef.current.get(id);
    if (!entry) {
      entry = { abort: null, discard: false, actions: [], loaded: false, persist: Promise.resolve() };
      chatsRef.current.set(id, entry);
    }
    return entry;
  }, []);
  const [runningSet, setRunningSet] = useState<readonly string[]>([]);
  const markRunning = useCallback((id: string, on: boolean) => {
    setRunningSet((current) => (on ? (current.includes(id) ? current : [...current, id]) : current.filter((c) => c !== id)));
  }, []);
  /** Chats with a message queued while MAX_RUNNING_CHATS were busy: tried again when one finishes. */
  const waitingForSlot = useRef<string[]>([]);
  const requested = useRef(false);
  const loadedChatId = useRef(chatId);
  const needSettings = useRef(onNeedSettings);
  useEffect(() => {
    needSettings.current = onNeedSettings;
  }, [onNeedSettings]);

  // The selected chat is the foreground one: the shell's pill, status line and page cues follow it.
  useLayoutEffect(() => setForegroundChat(chatId), [chatId]);
  const run = useRuntime((s) => s.run, chatId);
  const lock = useRuntime((s) => s.lock, chatId);
  const paused = useRuntime((s) => s.paused, chatId);
  const queueLength = useRuntime((s) => s.queue.length, chatId);
  const activity = useRuntime((s) => s.activity, chatId);
  const busy = runningSet.includes(chatId);
  const accountId = account.kind === "ready" ? account.account.id : null;
  const localChatScope = account.kind === "ready"
    ? `${account.account.id}:chat:${chatId}`
    : null;

  const applyAccount = useCallback((info: AccountInfo) => {
    const scopeId = `${info.id}:chat:${chatId}`;
    accountIdRef.current = info.id;
    if (scopeIdRef.current !== scopeId) {
      scopeIdRef.current = scopeId;
      // A chat running in the background keeps its own journal and server state.
      const entry = chatRun(chatId);
      if (!entry.abort) {
        entry.actions = [];
        entry.loaded = false;
      }
      setMessages(readChat(scopeId));
    }
    setAccount({ kind: "ready", account: info });
  }, [chatId, chatRun]);

  const refreshAccount = useCallback(async () => {
    const requestedChatId = chatId;
    const result = await fetchAccount();
    if (result.ok) {
      if (selectedChatId.current !== requestedChatId) return;
      const info = result.value;
      applyAccount(info);
      if (info.provider) {
        const scopeId = `${info.id}:chat:${chatId}`;
        const local = readChat(scopeId);
        const remote = await fetchConversation(requestedChatId);
        if (selectedChatId.current !== requestedChatId) return;
        if (remote.ok) {
          const entry = chatRun(requestedChatId);
          // A run in this tab owns the transcript until it ends; it reconciles at the next turn start.
          if (entry.abort) return;
          entry.actions = remote.value.actions;
          entry.loaded = true;
          // Continue from the copy that holds the most: the server one, unless this browser has more after it (a save
          // that failed during a restart) or an older release left it under a provider-scoped key.
          const remoteMessages = remote.value.messages as TranscriptMessage[];
          const legacy = readLegacyChat(info.id, requestedChatId);
          const localBest = pickTranscript(local, legacy, "local");
          const chosen = pickTranscript(localBest.messages, remoteMessages, "remote");
          if (chosen.messages.length === 0) {
            setMessages([]);
            return;
          }
          saveChat(scopeId, chosen.messages);
          setMessages(chosen.messages);
          if (chosen.from === "local" && extendsTranscript(chosen.messages, remoteMessages)) {
            const saved = await saveConversation({ version: 1, messages: chosen.messages, actions: chatRun(requestedChatId).actions }, requestedChatId);
            if (saved.ok) clearLegacyChat(info.id, requestedChatId);
          } else clearLegacyChat(info.id, requestedChatId);
        }
      }
      return;
    }
    const f = result.failure;
    if (f.kind === "login_required") setAccount({ kind: "login", accounts: f.accounts });
    else setAccount({ kind: "error", message: f.kind === "error" ? f.message : "Unexpected response." });
  }, [applyAccount, chatId, chatRun]);

  useEffect(() => {
    if (loadedChatId.current === chatId) return;
    loadedChatId.current = chatId;
    // Each chat has its own store and bookkeeping: switching never touches the chat left behind (it may still run).
    if (account.kind === "ready") queueMicrotask(() => void refreshAccount());
  }, [account.kind, chatId, localChatScope, refreshAccount]);

  const switchChat = useCallback((nextChatId: string) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(nextChatId)) return;
    const info = account.kind === "ready" ? account.account : null;
    const scopeId = info ? `${info.id}:chat:${nextChatId}` : null;
    selectedChatId.current = nextChatId;
    setMessages(scopeId ? readChat(scopeId) : []);
  }, [account]);

  // Transcript + journal only: the taint flag is the server's (/api/agent/chat).
  const enqueueConversationSave = useCallback((forChat: string, history: TranscriptMessage[], actions: string[]): Promise<void> => {
    const entry = chatRun(forChat);
    const pending = entry.persist.then(async () => {
      // No server copy loaded yet for this chat (or it was just cleared): nothing to save into.
      if (entry.loaded) await saveConversation({ version: 1, messages: history, actions }, forChat);
    });
    entry.persist = pending;
    return pending;
  }, [chatRun]);

  // Load the account the first time the panel is shown (never during SSR or hydration).
  useEffect(() => {
    if (!active || requested.current) return;
    requested.current = true;
    void refreshAccount();
  }, [active, refreshAccount]);

  /* ----------------------------------------------- queue + cross-tab wiring */

  // Queue of the signed-in account, kept in sync with other tabs.
  useEffect(() => {
    const detach = attachQueue(accountId, chatId);
    return () => {
      detach();
      attachQueue(null, chatId);
    };
  }, [accountId, chatId]);

  // Transcript: show what other tabs append; a clear elsewhere ends a run here.
  useEffect(() => {
    if (!localChatScope) return;
    const scopeId = localChatScope;
    const viewed = chatId;
    return subscribeChat(scopeId, (removed) => {
      if (removed) {
        const entry = chatRun(viewed);
        entry.actions = [];
        entry.loaded = false;
        if (entry.abort) {
          entry.discard = true;
          entry.abort.abort();
        }
        setMessages([]);
      } else {
        setMessages(readChat(scopeId));
      }
    });
  }, [chatId, chatRun, localChatScope]);

  // Another tab's run: announced instantly, double-checked against the lock (a crashed tab never announces its end).
  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    const rt = runtimeFor(chatId);
    void runHeldElsewhere(accountId, chatId).then((held) => {
      if (alive && held && !chatRun(chatId).abort) rt.setLock("other");
    });
    const off = subscribeRunAnnouncements((a) => {
      if (a.accountId !== accountId || a.chatId !== chatId || chatRun(chatId).abort) return;
      if (a.running) rt.setLock("other", a.activity);
      else rt.setLock("free");
    });
    return () => {
      alive = false;
      off();
    };
  }, [accountId, chatId, chatRun]);

  useEffect(() => {
    if (!accountId || lock !== "other") return;
    const rt = runtimeFor(chatId);
    const timer = setInterval(() => {
      void runHeldElsewhere(accountId, chatId).then((held) => {
        if (!held && rt.get().lock === "other") rt.setLock("free");
      });
    }, LOCK_POLL_MS);
    return () => clearInterval(timer);
  }, [accountId, lock, chatId]);

  /* ---------------------------------------------------------------- a turn */

  // The newest startTurn, for runs that end in the background and drain their own chat's queue.
  const startTurnRef = useRef<(forChat: string, text: string, queuedId: string | null, automatic: boolean) => Promise<void>>(async () => {});

  /** A chat whose queue may drain by itself (a background chat after its run, or one that waited for a free slot). */
  const drainChat = useCallback((forChat: string) => {
    if (chatRun(forChat).abort || runtimeFor(forChat).get().lock === "other") return;
    const next = nextQueued(forChat);
    if (next) void startTurnRef.current(forChat, next.text, next.id, true);
  }, [chatRun]);

  const startTurn = useCallback(
    async (forChat: string, text: string, queuedId: string | null, automatic: boolean): Promise<void> => {
      const id = accountIdRef.current;
      const entry = chatRun(forChat);
      if (!id || account.kind !== "ready" || entry.abort) return;
      const rt = runtimeFor(forChat);
      const controller = new AbortController();
      entry.abort = controller;
      markRunning(forChat, true);
      const giveUp = (lease: { release: () => void } | null): void => {
        lease?.release();
        entry.abort = null;
        markRunning(forChat, false);
      };
      // At most MAX_RUNNING_CHATS chats of the account run at once: this one waits in its queue for a free slot.
      if ((await runningChatCount(id)) >= MAX_RUNNING_CHATS) {
        if (!queuedId) enqueue(text, forChat);
        if (!waitingForSlot.current.includes(forChat)) waitingForSlot.current.push(forChat);
        giveUp(null);
        return;
      }
      const lease = await tryAcquireRun(id, forChat);
      if (!lease) {
        // Another tab holds this chat: keep the message (queued) and show the banner.
        rt.setLock("other");
        if (!queuedId) enqueue(text, forChat);
        giveUp(null);
        return;
      }
      if (queuedId && !takeQueued(queuedId, { unlessPaused: automatic }, forChat)) {
        giveUp(lease); // another tab already delivered it, or the queue was paused / cancelled meanwhile
        return;
      }

      rt.setLock("mine");
      announceRun(id, true, null, forChat);
      let lastActivity: string | null = null;
      const offBroadcast = rt.subscribe(() => {
        lease.renew();
        const now = rt.get().activity;
        if (now !== lastActivity) {
          lastActivity = now;
          announceRun(id, true, now, forChat);
        }
      });
      const scopeId = `${id}:chat:${forChat}`;
      // Only the chat on screen updates the visible transcript; a background chat writes to its own stored copy.
      const show = (history: TranscriptMessage[]): void => {
        if (selectedChatId.current === forChat) setMessages(history);
      };

      let outcome: LoopOutcome = "error";
      try {
        await entry.persist;
        const durable = await fetchConversation(forChat);
        if (durable.ok) {
          entry.actions = durable.value.actions;
          entry.loaded = true;
        }
        // Under the lock the stored transcript is ours to repair (a crashed run may have left unpaired tool calls).
        let stored = readChat(scopeId);
        // The server copy is ahead (another browser, or this tab loaded before a turn elsewhere): continue from it.
        if (durable.ok) {
          const chosen = pickTranscript(stored, durable.value.messages as TranscriptMessage[], "local");
          if (chosen.from === "remote" && chosen.messages !== stored) stored = replaceChat(scopeId, chosen.messages);
        }
        const repaired = repairTranscript(stored);
        if (repaired.length !== stored.length) replaceChat(scopeId, repaired);
        const history = appendChat(scopeId, [{ role: "user", content: text }]);
        show(history);
        await enqueueConversationSave(forChat, history, entry.actions);
        outcome = await runAgentTurn({
          chatId: forChat,
          history,
          accountName: account.account.displayName,
          signal: controller.signal,
          recentActions: entry.actions,
          onAction: (action) => {
            if (entry.actions.at(-1) !== action) entry.actions = [...entry.actions, action].slice(-40);
            enqueueConversationSave(forChat, readChat(scopeId), entry.actions);
          },
          navigate: (href) => {
            if (selectedChatId.current === forChat) router.push(href);
          },
          onMessage: (m) => {
            const updated = appendChat(scopeId, [m]);
            show(updated);
            enqueueConversationSave(forChat, updated, entry.actions);
          },
          takeSteering: () => takeSteeringTexts(forChat),
          limits: account.account.assistant,
          isForeground: () => selectedChatId.current === forChat,
        });
        if (outcome === "aborted" && !entry.discard) {
          const stopped = appendChat(scopeId, [{ role: "notice", level: "info", content: "Stopped." }]);
          show(stopped);
          enqueueConversationSave(forChat, stopped, entry.actions);
        }
      } finally {
        offBroadcast();
        // Everything that decides what happens to the queue must be written BEFORE the lock is released.
        reclaimSteering(forChat);
        if (entry.discard) clearQueue(forChat);
        else if (outcome === "aborted") pauseQueue("stopped", forChat);
        else if (outcome === "error" || outcome === "login_required" || outcome === "provider_missing") pauseQueue("failed", forChat);
        entry.discard = false;
        lease.release();
        rt.setLock("free");
        announceRun(id, false, null, forChat);
        entry.abort = null;
        markRunning(forChat, false);
      }
      if (outcome === "login_required") void refreshAccount();
      else if (outcome === "provider_missing") needSettings.current();
      else {
        // A chat in the background drains its own queue; the selected one is drained by the effect below. Then a chat
        // that waited for a free slot gets its turn.
        setTimeout(() => {
          if (selectedChatId.current !== forChat) drainChat(forChat);
          const waiting = waitingForSlot.current.shift();
          if (waiting) drainChat(waiting);
        }, 0);
      }
    },
    [account, chatRun, drainChat, enqueueConversationSave, markRunning, refreshAccount, router],
  );
  useEffect(() => {
    startTurnRef.current = startTurn;
  }, [startTurn]);

  // Drain the selected chat: when idle, not paused and nobody else runs it, its oldest queued message starts the next turn.
  useEffect(() => {
    if (account.kind !== "ready" || busy || run !== "idle" || lock === "other" || paused || queueLength === 0) return;
    // Waiting for a free slot (MAX_RUNNING_CHATS): the run that ends first drains it.
    if (waitingForSlot.current.includes(chatId)) return;
    const next = runtimeFor(chatId).get().queue[0];
    if (next) void startTurn(chatId, next.text, next.id, true);
  }, [account.kind, busy, chatId, run, lock, paused, queueLength, startTurn]);

  const stop = useCallback(() => {
    const entry = chatRun(chatId);
    if (!entry.abort) return;
    stopRequested(chatId);
    entry.abort.abort();
  }, [chatId, chatRun]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || account.kind !== "ready") return;
      const s = runtimeFor(chatId).get();
      const mustQueue = chatRun(chatId).abort !== null || s.lock === "other" || (s.queue.length > 0 && s.paused === null);
      if (mustQueue) enqueue(trimmed, chatId);
      else void startTurn(chatId, trimmed, null, false);
    },
    [account.kind, chatId, chatRun, startTurn],
  );

  const sendNow = useCallback(
    (id: string) => {
      if (chatRun(chatId).abort) {
        moveToSteering(id, chatId); // a turn is running here: delivered at its next model-round boundary
        return;
      }
      const rt = runtimeFor(chatId);
      if (rt.get().lock === "other") return;
      const item = rt.get().queue.find((q) => q.id === id);
      if (item) void startTurn(chatId, item.text, item.id, false);
    },
    [chatId, chatRun, startTurn],
  );

  const clear = useCallback(() => {
    const entry = chatRun(chatId);
    if (entry.abort) {
      entry.discard = true;
      entry.abort.abort();
    }
    const scopeId = scopeIdRef.current;
    if (scopeId) {
      clearChat(scopeId);
      if (accountIdRef.current) clearLegacyChat(accountIdRef.current, chatId);
    }
    entry.actions = [];
    entry.loaded = false;
    entry.persist = entry.persist.then(async () => { await resetConversation(chatId); });
    clearArtifacts();
    clearQueue(chatId);
    setMessages([]);
  }, [chatId, chatRun]);

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

  const abortAll = useCallback(() => {
    for (const entry of chatsRef.current.values()) entry.abort?.abort();
  }, []);

  const logout = useCallback(async () => {
    abortAll();
    // Nothing of this account stays in the browser for the next person (transcript, queue, SQL schema, trust mode).
    clearAccountStorage(accountIdRef.current);
    await apiLogout();
    accountIdRef.current = null;
    scopeIdRef.current = null;
    chatsRef.current.clear();
    setMessages([]);
    await refreshAccount();
  }, [abortAll, refreshAccount]);

  useEffect(() => () => abortAll(), [abortAll]);

  // Reload / tab close mid-run kills the runs like Stop would: keep the queues, but do not let another tab fire them unasked.
  useEffect(() => {
    const onHide = (): void => {
      for (const [id, entry] of chatsRef.current) {
        if (!entry.abort) continue;
        reclaimSteering(id);
        pauseQueue("stopped", id);
      }
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  // A live run (here or in another tab) legitimately has tool calls without a result yet; an idle chat shows them as interrupted.
  const live = busy || lock === "other";
  const shown = useMemo(() => (live ? messages : repairTranscript(messages)), [live, messages]);

  return { account, messages: shown, busy, runningChats: runningSet, activity, send, sendNow, stop, clear, switchChat, refreshAccount, login, logout };
}
