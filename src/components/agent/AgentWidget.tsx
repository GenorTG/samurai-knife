"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { cx } from "@/lib/format";
import { usePathname } from "next/navigation";
import { AGENT_EVENTS, type AgentOpenDetail } from "@/lib/agent-client/bridge";
import { WIDGET_ATTR } from "@/lib/agent-client/dom-bridge";
import { answerWait, isWaiting, useInteraction } from "@/lib/agent-client/interaction";
import { findTool, canonicalSlug } from "@/lib/registry";
import { ChatIcon, CloseIcon, DockIcon, GearIcon, SendIcon, StopIcon, TrashIcon } from "./icons";
import { FeedbackLayer } from "./FeedbackLayer";
import { InteractionCards, TrustModeSwitch } from "./InteractionCards";
import { QueuePanel } from "./QueuePanel";
import { LoginView } from "./LoginView";
import { SettingsView } from "./SettingsView";
import { GoalsView } from "./GoalsView";
import { MIN_HEIGHT, MIN_WIDTH, loadPrefs, savePrefs, subscribePrefs, type UiPrefs } from "./storage";
import { formatTokens } from "@/lib/usage";
import { starterPrompts } from "./starters";
import { Transcript } from "./Transcript";
import { useAgent } from "./useAgent";
import { useT } from "@/lib/i18n/react";

const noopSubscribe = () => () => {};

/** Client-only gate: nothing is rendered on the server or during hydration, so there is nothing to mismatch. */
export function AgentWidget() {
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  return mounted ? <WidgetShell /> : null;
}

function IconButton({
  label,
  onClick,
  children,
  disabled,
  hideBelow,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  /** Hide the button under the lg breakpoint (features that need a wide screen). */
  hideBelow?: "lg";
}) {
  return (
    <button
      autoComplete="off"
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "grid size-8 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-40",
        hideBelow === "lg" && "max-lg:hidden",
      )}
    >
      {children}
    </button>
  );
}

function WidgetShell() {
  const { t } = useT();
  const [prefs, setPrefs] = useState<UiPrefs>(loadPrefs);
  const [chatId, setChatId] = useState("default");
  const [settingsRequested, setSettingsRequested] = useState(false);
  const [goalsRequested, setGoalsRequested] = useState(false);
  const [draft, setDraft] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const wantFocus = useRef(false);

  const agent = useAgent({ active: prefs.open, chatId, onNeedSettings: () => setSettingsRequested(true) });
  const { account, switchChat } = agent;
  const pathname = usePathname();
  const interaction = useInteraction(chatId);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [wide, setWide] = useState(false);

  // Docking only exists on desktop widths; below that the panel floats.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  const docked = prefs.open && prefs.dock && wide;

  // Reserve room for the docked panel so the page reflows beside it (live view).
  useEffect(() => {
    document.documentElement.style.setProperty("--sk-dock", docked ? `${prefs.width}px` : "0px");
    return () => {
      document.documentElement.style.removeProperty("--sk-dock");
    };
  }, [docked, prefs.width]);

  // Shell → widget: open the panel, optionally with a prompt to send; stop a run.
  const { stop: stopRun } = agent;
  useEffect(() => {
    const onOpen = (event: Event) => {
      const prompt = (event as CustomEvent<AgentOpenDetail>).detail?.prompt?.trim();
      wantFocus.current = true;
      setPrefs((p) => (p.open ? p : { ...p, open: true }));
      setSettingsRequested(false);
      if (prompt) setPendingPrompt(prompt);
    };
    window.addEventListener(AGENT_EVENTS.open, onOpen);
    window.addEventListener(AGENT_EVENTS.stop, stopRun);
    return () => {
      window.removeEventListener(AGENT_EVENTS.open, onOpen);
      window.removeEventListener(AGENT_EVENTS.stop, stopRun);
    };
  }, [stopRun]);

  const providerOk = account.kind === "ready" && account.account.provider !== null;
  const { send: sendMessage, busy: agentBusy } = agent;
  useEffect(() => {
    if (!pendingPrompt || !providerOk || agentBusy) return;
    sendMessage(pendingPrompt);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingPrompt(null);
  }, [pendingPrompt, providerOk, agentBusy, sendMessage]);

  const suggestions = useMemo(() => {
    const match = /^\/tools\/([^/]+)/.exec(pathname);
    const tool = match ? findTool(canonicalSlug(match[1])) : undefined;
    return starterPrompts(tool, t);
  }, [pathname, t]);

  useEffect(() => {
    savePrefs(prefs);
  }, [prefs]);

  useEffect(() => subscribePrefs((updated) => {
    setPrefs((current) => current.chatIds.length === updated.chatIds.length && current.chatIds.every((id, index) => id === updated.chatIds[index])
      ? current
      : { ...current, chatIds: updated.chatIds });
  }), []);

  const selectChat = useCallback((id: string) => {
    if (agent.busy || !prefs.chatIds.includes(id)) return;
    switchChat(id);
    setChatId(id);
    setDraft("");
  }, [agent.busy, prefs.chatIds, switchChat]);

  const createChat = useCallback(() => {
    if (agent.busy || prefs.chatIds.length >= 50) return;
    const id = crypto.randomUUID().replaceAll("-", "");
    setPrefs((current) => ({ ...current, chatIds: [...current.chatIds, id] }));
    switchChat(id);
    setChatId(id);
    setDraft("");
  }, [agent.busy, prefs.chatIds.length, switchChat]);

  const firstRun = account.kind === "ready" && account.account.provider === null;
  const view: "chat" | "goals" | "settings" | "login" | "loading" | "error" =
    account.kind === "ready" ? (firstRun || settingsRequested ? "settings" : goalsRequested ? "goals" : "chat") : account.kind;

  const setOpen = useCallback((open: boolean) => setPrefs((p) => (p.open === open ? p : { ...p, open })), []);

  const close = useCallback(() => {
    const hadFocus = panelRef.current?.contains(document.activeElement) ?? false;
    setOpen(false);
    if (hadFocus) launcherRef.current?.focus();
  }, [setOpen]);

  // Move focus into the panel when the user opens it or the view swaps; never steal focus on page load.
  useEffect(() => {
    if (!prefs.open || !wantFocus.current) return;
    const panel = panelRef.current;
    const active = document.activeElement;
    if (panel && active && panel.contains(active) && active !== panel) return;
    const target =
      panel?.querySelector<HTMLElement>("[data-agent-autofocus]") ??
      composerRef.current ??
      panel?.querySelector<HTMLElement>("button");
    target?.focus({ preventScroll: true });
  }, [prefs.open, view]);

  function onPanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    wantFocus.current = true;
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  }

  function submit() {
    if (!draft.trim() || account.kind !== "ready") return;
    if (isWaiting(chatId)) {
      answerWait("message", draft.trim(), chatId);
      setDraft("");
      return;
    }
    agent.send(draft); // queues itself when a run is active or another tab holds the conversation
    setDraft("");
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  /* ----------------------------------------------------------------- resize */
  const drag = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  function onResizeDown(event: PointerEvent<HTMLButtonElement>) {
    drag.current = { x: event.clientX, y: event.clientY, w: prefs.width, h: prefs.height };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function onResizeMove(event: PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (!d) return;
    const width = Math.max(MIN_WIDTH, Math.min(900, d.w + (d.x - event.clientX)));
    const height = Math.max(MIN_HEIGHT, Math.min(1200, d.h + (d.y - event.clientY)));
    setPrefs((p) => ({ ...p, width: Math.round(width), height: Math.round(height) }));
  }
  function onResizeUp(event: PointerEvent<HTMLButtonElement>) {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function onResizeKey(event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.shiftKey ? 80 : 24;
    const dw = event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
    const dh = event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
    if (!dw && !dh) return;
    event.preventDefault();
    setPrefs((p) => ({
      ...p,
      width: Math.max(MIN_WIDTH, Math.min(900, p.width + dw)),
      height: Math.max(MIN_HEIGHT, Math.min(1200, p.height + dh)),
    }));
  }

  const panelStyle = { "--aw": `${prefs.width}px`, "--ah": `${prefs.height}px` } as CSSProperties;
  // Tokens spent in this conversation (sum of the per-turn footers kept in the transcript).
  const chatTokens = agent.messages.reduce((sum, m) => (m.role === "notice" && m.level === "usage" && m.usage ? sum + m.usage.promptTokens + m.usage.completionTokens : sum), 0);
  const subtitle =
    account.kind === "ready"
      ? `${account.account.displayName}${account.account.provider ? ` · ${account.account.provider.model}` : ` · ${t("no model yet")}`}${chatTokens > 0 ? ` · ${t("{tokens} tokens", { tokens: formatTokens(chatTokens) })}` : ""}`
      : t("Assistant");
  const providerReady = account.kind === "ready" && account.account.provider !== null;
  const queueing = agent.busy && !interaction.wait;
  const lines = Math.min(5, Math.max(1, draft.split("\n").length));

  return (
    <div {...{ [WIDGET_ATTR]: "" }} className="contents">
      <FeedbackLayer />
      {prefs.open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-label={t("Toolbox assistant")}
          onKeyDown={onPanelKeyDown}
          onPointerDown={() => {
            wantFocus.current = true;
          }}
          style={panelStyle}
          data-agent-docked={docked ? "" : undefined}
          className={cx(
            "fixed z-50 flex flex-col overflow-hidden border border-ai/30 bg-bg shadow-pop",
            docked
              ? "top-14 right-0 bottom-0 w-[min(var(--aw),50vw)] rounded-none border-y-0 border-r-0"
              : [
                  "sk-pop right-4 bottom-20 rounded-2xl",
                  "h-[min(var(--ah),calc(100dvh-6.5rem))] w-[min(var(--aw),calc(100vw-2rem))]",
                  "max-sm:right-2 max-sm:w-[calc(100vw-1rem)]",
                ].join(" "),
          )}
        >
          <button
            autoComplete="off"
            type="button"
            aria-label={t("Resize assistant panel (drag, or use arrow keys)")}
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
            onKeyDown={onResizeKey}
            className="absolute top-0 left-0 z-10 size-4 cursor-nwse-resize touch-none rounded-br-md text-faint hover:text-ai max-sm:hidden"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M3 9l6-6M3 13L13 3" />
            </svg>
          </button>

          {/* Narrow panels (the default 400px) put the controls on a second row so the title is never squeezed. */}
          <header className="@container border-b border-line bg-surface px-3 py-2.5 pl-5">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 @[34rem]:grid-cols-[minmax(0,1fr)_auto_auto]">
            <div className="col-start-1 row-start-1 min-w-0">
              <h2 className="flex items-center gap-1.5 truncate text-sm font-semibold text-ink">
                <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-ai" />
                {t("Assistant")}
              </h2>
              <p className="truncate text-xs text-faint" title={subtitle}>
                {subtitle}
              </p>
            </div>
            {account.kind === "ready" ? (
              <div className="col-span-2 row-start-2 flex items-center justify-end gap-2 @[34rem]:col-span-1 @[34rem]:col-start-2 @[34rem]:row-start-1">
                <IconButton label={view === "goals" ? t("Back to chat") : t("Goals")} onClick={() => { setSettingsRequested(false); setGoalsRequested(view !== "goals"); }}>
                  <span aria-hidden="true">☷</span>
                </IconButton>
                <select
                  aria-label={t("Assistant conversation")}
                  value={chatId}
                  disabled={agent.busy}
                  onChange={(event) => selectChat(event.currentTarget.value)}
                  className="sk-input max-w-28 px-2 py-1 text-xs"
                >
                  {prefs.chatIds.map((id, index) => <option key={id} value={id}>{t("Chat {number}", { number: index + 1 })}</option>)}
                </select>
                {chatId !== "default" ? (
                  <IconButton label={t("Exit conversation")} onClick={() => selectChat("default")} disabled={agent.busy}>
                    <span aria-hidden="true">↩</span>
                  </IconButton>
                ) : null}
                <IconButton label={t("New conversation")} onClick={createChat} disabled={agent.busy || prefs.chatIds.length >= 50}>
                  <span aria-hidden="true">＋</span>
                </IconButton>
                <IconButton
                  label={docked ? t("Float assistant over the page") : t("Dock assistant beside the page")}
                  onClick={() => setPrefs((p) => ({ ...p, dock: !p.dock }))}
                  hideBelow="lg"
                >
                  <DockIcon docked={docked} />
                </IconButton>
                <IconButton label={t("Clear conversation")} onClick={agent.clear} disabled={agent.messages.length === 0}>
                  <TrashIcon />
                </IconButton>
                <IconButton
                  label={view === "settings" ? t("Back to chat") : t("Settings")}
                  onClick={() => setSettingsRequested(view !== "settings")}
                >
                  <GearIcon />
                </IconButton>
              </div>
            ) : null}
            <div className="col-start-2 row-start-1 flex @[34rem]:col-start-3">
              <IconButton label={t("Close assistant")} onClick={close}>
                <CloseIcon />
              </IconButton>
            </div>
            </div>
          </header>

          {view === "loading" ? <p className="p-4 text-sm text-muted">{t("Loading…")}</p> : null}
          {view === "error" && account.kind === "error" ? (
            <div className="space-y-3 p-4">
              <p className="text-sm text-danger">{t("Could not load your account:")}{" "} {account.message}</p>
              <button
                autoComplete="off"
                type="button"
                data-agent-autofocus
                onClick={() => void agent.refreshAccount()}
                className="cursor-pointer rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink hover:bg-raised"
              >
                {t("Retry")}
              </button>
            </div>
          ) : null}
          {view === "login" && account.kind === "login" ? <LoginView accounts={account.accounts} onLogin={agent.login} /> : null}
          {view === "settings" && account.kind === "ready" ? (
            <SettingsView
              key={account.account.id}
              account={account.account}
              firstRun={firstRun}
              onSaved={async () => {
                setSettingsRequested(true);
                await agent.refreshAccount();
              }}
              onBack={() => setSettingsRequested(false)}
              onLogout={agent.logout}
            />
          ) : null}
          {view === "goals" ? <GoalsView onContinue={(goalId, goalTitle) => {
            setSettingsRequested(false);
            setGoalsRequested(false);
            agent.send(`Resume saved goal "${goalTitle}" (id: ${goalId}). Read its current checkpoint with knife_goal_list and continue from the saved next action; do not ask me to restate the goal.`);
          }} /> : null}
          {view === "chat" ? (
            <>
              <TrustModeSwitch chatId={chatId} />
              <Transcript
                messages={agent.messages}
                activity={agent.activity}
                providerReady={providerReady}
                suggestions={suggestions}
                onPick={(text) => agent.send(text)}
              />
              <InteractionCards onStop={agent.stop} chatId={chatId} />
              <QueuePanel onSendNow={agent.sendNow} chatId={chatId} />
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
                className="flex items-end gap-2 border-t border-line bg-surface p-2.5"
              >
                <textarea
                  ref={composerRef}
                  value={draft}
                  rows={lines}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onComposerKeyDown}
                  aria-label={t("Message the assistant")}
                  aria-describedby="sk-ai-notice"
                  placeholder={queueing ? t("Queue a message…") : t("Ask for something…")}
                  className="sk-input max-h-32 min-h-10 min-w-0 flex-1 resize-none px-3 py-2.5 text-sm leading-snug"
                />
                {queueing ? (
                  <button
                    autoComplete="off"
                    type="button"
                    onClick={agent.stop}
                    aria-label={t("Stop")}
                    className="inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-lg border border-danger/40 bg-surface px-3 text-sm text-danger hover:bg-danger/10"
                  >
                    <StopIcon />
                    {t("Stop")}
                  </button>
                ) : null}
                <button
                  autoComplete="off"
                  type="submit"
                  aria-label={queueing ? t("Queue message") : t("Send")}
                  title={queueing ? t("Queue this message; it is sent when the run ends") : undefined}
                  disabled={!draft.trim()}
                  className="grid size-10 cursor-pointer place-items-center rounded-lg bg-accent text-accent-fg shadow-xs transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <SendIcon />
                </button>
              </form>
              {/* AI Act art. 50(1)/(5): say it is an AI system, clearly, at the first interaction (legal/terms.*.md "AI assistant"). */}
              <p id="sk-ai-notice" className="bg-surface px-3 pb-2 text-[11px] leading-snug text-faint">
                {t("You are chatting with an AI system; replies can be wrong.")}{" "}
                <a href="/terms#ai" className="whitespace-nowrap underline underline-offset-2 hover:text-ink">
                  {t("How it works")}
                </a>
              </p>
            </>
          ) : null}
        </div>
      ) : null}

      <button
        autoComplete="off"
        ref={launcherRef}
        type="button"
        aria-label={prefs.open ? t("Close assistant") : t("Open assistant")}
        aria-expanded={prefs.open}
        onClick={() => {
          wantFocus.current = true;
          setOpen(!prefs.open);
        }}
        className={cx(
          docked && "hidden",
          "fixed right-4 bottom-4 z-50 grid size-12 cursor-pointer place-items-center rounded-full border shadow-pop transition-[filter,background-color,transform] hover:scale-105 max-sm:right-2",
          prefs.open
            ? "border-line-strong bg-surface text-ink hover:bg-raised"
            : "border-transparent bg-ai text-accent-fg shadow-[0_0_0_2px_var(--c-bg),0_0_0_3px_var(--c-ai)] hover:brightness-110",
        )}
      >
        {prefs.open ? <CloseIcon /> : <ChatIcon size={22} />}
        {agent.busy && !prefs.open ? (
          <span aria-hidden="true" className="absolute top-0.5 right-0.5 size-2.5 animate-pulse rounded-full bg-good" />
        ) : null}
      </button>
    </div>
  );
}
