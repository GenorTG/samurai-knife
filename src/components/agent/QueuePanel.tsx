"use client";

import { useState } from "react";
import { cx } from "@/lib/format";
import { cancelQueued, clearQueue, editQueued, resumeQueue } from "@/lib/agent-client/message-queue";
import { useRuntime } from "@/lib/agent-client/runtime-store";
import { useT } from "@/lib/i18n/react";

const chipButton = "inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md px-2 text-[11px] text-muted hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Everything the run state says about the conversation that is not in the transcript, pinned above the
 * composer: another tab holds the conversation, the queue is paused, messages are on their way into the
 * running turn, and the queued messages themselves (cancel, edit, send now).
 */
export function QueuePanel({ onSendNow, chatId = "default" }: { onSendNow: (id: string) => void; chatId?: string }) {
  const { t } = useT();
  const queue = useRuntime((s) => s.queue);
  const steering = useRuntime((s) => s.steering);
  const paused = useRuntime((s) => s.paused);
  const lock = useRuntime((s) => s.lock);
  const remoteActivity = useRuntime((s) => s.remoteActivity);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  if (lock !== "other" && queue.length === 0 && steering.length === 0) return null;

  const save = (): void => {
    if (editing) editQueued(editing.id, editing.text, chatId);
    setEditing(null);
  };

  return (
    <div className="space-y-1.5 border-t border-line bg-surface px-3 py-2" data-agent-queue-panel="">
      {lock === "other" ? (
        <p role="status" data-agent-lock="" className="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-xs text-ink">
          <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-warn" />
          <span className="min-w-0 flex-1">
            {t("Another tab is running this conversation.")}
            {remoteActivity ? <span className="text-muted"> {remoteActivity}</span> : null} {" "}{t("New messages wait in the queue.")}
          </span>
        </p>
      ) : null}

      {paused && queue.length > 0 ? (
        <div role="status" data-agent-queue-paused={paused} className="flex flex-wrap items-center gap-2 rounded-lg border border-line-strong bg-raised/60 px-2.5 py-1.5 text-xs text-ink">
          <span className="min-w-0 flex-1">
            {t("Queue paused")}{paused === "stopped" ? t(" (you stopped the run)") : t(" (the run failed)")}{t(": {queue} waiting.", { queue: queue.length })}
          </span>
          <button autoComplete="off" type="button" onClick={() => resumeQueue(chatId)} className="rounded-md bg-accent px-2 py-1 font-semibold text-accent-fg hover:brightness-110">
            {t("Resume")}
          </button>
          <button autoComplete="off" type="button" onClick={() => clearQueue(chatId)} className="rounded-md border border-line-strong px-2 py-1 text-ink hover:bg-raised">
            {t("Clear")}
          </button>
        </div>
      ) : null}

      {steering.map((m) => (
        <p key={m.id} data-agent-steering="" className="flex items-center gap-2 rounded-lg border border-ai/40 bg-ai/8 px-2.5 py-1.5 text-xs">
          <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-ai" />
          <span className="min-w-0 flex-1 truncate text-ink" title={m.text}>
            {m.text}
          </span>
          <span className="shrink-0 text-faint">{t("joins the run at its next step")}</span>
        </p>
      ))}

      {queue.length > 0 ? (
        <ul aria-label={t("Queued messages")} className="max-h-32 space-y-1 overflow-y-auto">
          {queue.map((m, index) => (
            <li
              key={m.id}
              data-agent-queued={index + 1}
              className={cx("flex items-center gap-1 rounded-lg border bg-raised/50 px-2 py-1 text-xs", paused ? "border-line" : "border-line-strong")}
            >
              <span className="shrink-0 font-mono text-[10px] text-faint">{index + 1}</span>
              {editing?.id === m.id ? (
                <>
                  <input
                    autoFocus
                    aria-label={t("Edit queued message")}
                    value={editing.text}
                    onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        save();
                      } else if (e.key === "Escape") {
                        e.stopPropagation();
                        setEditing(null);
                      }
                    }}
                    className="sk-input min-w-0 flex-1 px-2 py-1 text-xs"
                  />
                  <button autoComplete="off" type="button" onClick={save} className={chipButton}>
                    {t("Save")}
                  </button>
                  <button autoComplete="off" type="button" onClick={() => setEditing(null)} className={chipButton}>
                    {t("Back")}
                  </button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-ink" title={m.text}>
                    {m.text}
                  </span>
                  <button
                    autoComplete="off"
                    type="button"
                    onClick={() => onSendNow(m.id)}
                    disabled={lock === "other"}
                    title={lock === "other" ? t("Another tab is running this conversation") : t("Deliver this message to the assistant now, without waiting for the run to end")}
                    className={chipButton}
                  >
                    {t("Send now")}
                  </button>
                  <button autoComplete="off" type="button" onClick={() => setEditing({ id: m.id, text: m.text })} className={chipButton}>
                    {t("Edit")}
                  </button>
                  <button autoComplete="off" type="button" onClick={() => cancelQueued(m.id, chatId)} aria-label={t("Cancel queued message")} title={t("Remove from the queue")} className={chipButton}>
                    ✕
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
