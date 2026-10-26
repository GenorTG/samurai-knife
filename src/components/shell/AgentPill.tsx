"use client";

import { useSyncExternalStore } from "react";
import { getFeedback, getServerFeedback, subscribeFeedback } from "@/lib/agent-client/feedback";
import { useInteraction } from "@/lib/agent-client/interaction";
import { openAssistant, stopAssistant } from "@/lib/agent-client/bridge";
import { useT } from "@/lib/i18n/react";

type Kind = "" | "approval" | "wait";

interface PillState {
  text: string;
  kind: Kind;
  destructive: boolean;
  /** Tool calls so far in this run (the compact chip shows it instead of the text). */
  steps: number;
}

/** What the assistant is doing right now, or null while idle. Shared by the pill, the chip and the small-screen strip. */
function usePillState(): PillState | null {
  const fb = useSyncExternalStore(subscribeFeedback, getFeedback, getServerFeedback);
  const { approval, wait } = useInteraction();
  const { t } = useT();
  if (!fb.active) return null;
  const running = [...fb.steps].reverse().find((s) => s.status === "running") ?? fb.steps[fb.steps.length - 1];
  const text = approval
    ? t("Needs your OK: {title}", { title: approval.title })
    : wait
      ? t("Waiting for you: {message}", { message: wait.message })
      : fb.phase === "stopping"
        ? t("Stopping…")
        : running
          ? running.label
          : fb.phase === "writing"
            ? t("Writing a reply…")
            : t("Thinking…");
  return {
    text,
    kind: approval ? "approval" : wait ? "wait" : "",
    destructive: Boolean(approval?.destructive),
    steps: fb.steps.length,
  };
}

function dotClass(s: PillState): string {
  return `size-2 shrink-0 animate-pulse rounded-full ${s.destructive ? "bg-danger" : s.kind ? "bg-warn" : "bg-ai"}`;
}

/**
 * Top-bar live indicator: while the assistant works it shows what it is doing
 * right now (latest step) from anywhere, even with the chat panel closed, with
 * one-click Stop. Clicking the label opens the panel.
 *
 * From `sm` up it is a text pill. Below `sm` there is no room for text beside the
 * brand, search and theme buttons, so the bar keeps only a compact chip (dot, step
 * count, Stop) and the step line moves to `AgentStrip` under the bar.
 */
export function AgentPill() {
  const { t } = useT();
  const s = usePillState();
  if (!s) return null;
  return (
    <>
      <div
        role="status"
        data-agent-pill={s.kind}
        className="sk-rise hidden h-9 max-w-sm items-center gap-1 rounded-lg border border-ai/40 bg-ai/10 pr-1 pl-2.5 text-sm text-ink sm:flex"
      >
        <button
          autoComplete="off"
          type="button"
          onClick={() => openAssistant()}
          title={t("Open the assistant")}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span aria-hidden className={dotClass(s)} />
          <span className="truncate text-[13px]">{s.text}</span>
        </button>
        <button
          autoComplete="off"
          type="button"
          onClick={stopAssistant}
          aria-label={t("Stop the assistant")}
          className="rounded-md px-2 py-1 text-xs font-medium text-danger hover:bg-danger/10"
        >
          {t("Stop")}
        </button>
      </div>
      <div
        data-agent-chip={s.kind}
        className="sk-rise flex h-9 items-center rounded-lg border border-ai/40 bg-ai/10 text-ink sm:hidden"
      >
        <button
          autoComplete="off"
          type="button"
          onClick={() => openAssistant()}
          aria-label={t("Open the assistant ({steps} steps so far)", { steps: s.steps })}
          className="flex h-full items-center gap-1.5 pr-1.5 pl-2.5"
        >
          <span aria-hidden className={dotClass(s)} />
          <span aria-hidden className="min-w-[1ch] font-mono text-[13px] tabular-nums">{s.steps}</span>
        </button>
        <button
          autoComplete="off"
          type="button"
          onClick={stopAssistant}
          aria-label={t("Stop the assistant")}
          title={t("Stop the assistant")}
          className="flex h-full w-9 items-center justify-center rounded-r-lg border-l border-ai/30 text-danger hover:bg-danger/10"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>
      </div>
    </>
  );
}

/** Second row under the top bar below `sm`: the full step line (two lines max); tapping it opens the panel. */
export function AgentStrip() {
  const { t } = useT();
  const s = usePillState();
  if (!s) return null;
  return (
    <button
      autoComplete="off"
      type="button"
      role="status"
      data-agent-strip={s.kind}
      onClick={() => openAssistant()}
      title={t("Open the assistant")}
      className="sk-rise flex w-full items-start gap-2 border-b border-ai/30 bg-ai/10 px-3.5 py-2 text-left text-[13px] leading-snug text-ink sm:hidden"
    >
      <span aria-hidden className={`${dotClass(s)} mt-1.5`} />
      <span className="line-clamp-2 min-w-0 wrap-anywhere">{s.text}</span>
    </button>
  );
}
