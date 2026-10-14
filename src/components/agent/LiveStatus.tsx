"use client";

import { useMemo, useSyncExternalStore } from "react";
import { cx } from "@/lib/format";
import { getFeedback, getServerFeedback, subscribeFeedback } from "@/lib/agent-client/feedback";
import { useRuntime } from "@/lib/agent-client/runtime-store";
import type { TranscriptMessage } from "@/lib/agent-client/types";
import { InlineBold } from "./InlineBold";
import { describeCall } from "./summarize";

/**
 * Live part of the transcript: what the current model round is doing that the committed
 * messages do not show yet (streamed draft, announced tool calls, status line). Anything
 * already committed to `messages` is skipped so a step is never rendered twice.
 */
export function LiveStatus({ messages }: { messages: TranscriptMessage[] }) {
  const activity = useRuntime((s) => s.activity);
  const fb = useSyncExternalStore(subscribeFeedback, getFeedback, getServerFeedback);
  const committed = useMemo(() => {
    const ids = new Set<string>();
    const answered = new Set<string>();
    let lastAssistant = "";
    for (const m of messages) {
      if (m.role === "tool") answered.add(m.tool_call_id);
      else if (m.role === "assistant") {
        lastAssistant = m.content?.trim() ?? "";
        for (const call of m.tool_calls ?? []) ids.add(call.id);
      }
    }
    // Labels of committed rows that are still running: a status line repeating one adds nothing.
    const runningLabels = new Set<string>();
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const call of m.tool_calls ?? []) {
        if (!answered.has(call.id)) runningLabels.add(describeCall(call.function.name, call.function.arguments));
      }
    }
    return { ids, lastAssistant, runningLabels };
  }, [messages]);
  if (!fb.active && !activity) return null;
  const draft = fb.draft.trim() === committed.lastAssistant ? "" : fb.draft;
  const steps = fb.steps.filter((step) => !committed.ids.has(step.id));
  const status =
    fb.phase === "stopping"
      ? "Stopping…"
      : fb.phase === "thinking" && fb.reasoningChars > 0
        ? `Thinking… (${fb.reasoningChars.toLocaleString("en-US")} chars of reasoning)`
        : activity;
  const showStatus = status && !committed.runningLabels.has(status);
  return (
    <div className="space-y-1.5" data-agent-live="" data-agent-phase={fb.phase}>
      {draft ? (
        <p
          data-agent-draft=""
          className="max-w-[94%] rounded-xl rounded-bl-sm border border-line bg-surface px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap text-ink"
        >
          <InlineBold text={draft} />
        </p>
      ) : null}
      {steps.map((step) => (
        <div
          key={step.id}
          data-agent-step={step.name}
          data-status={step.status}
          className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-raised/50 px-2.5 py-1.5 text-xs"
        >
          <span
            aria-hidden="true"
            className={cx(
              "size-1.5 shrink-0 rounded-full",
              step.status === "running" ? "animate-pulse bg-accent" : step.status === "ok" ? "bg-good" : "bg-danger",
            )}
          />
          <span className="min-w-0 flex-1 truncate text-muted">{step.label}</span>
        </div>
      ))}
      {showStatus ? (
        <p data-agent-status="" className="flex items-center gap-2 px-1 text-xs text-muted">
          <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-accent" />
          {status}
        </p>
      ) : null}
    </div>
  );
}
