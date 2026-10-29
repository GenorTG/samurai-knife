"use client";

import { useEffect, useMemo, useRef } from "react";
import { Notice } from "@/components/ui";
import { cx } from "@/lib/format";
import type { ToolCall, TranscriptMessage } from "@/lib/agent-client/types";
import { InlineBold } from "./InlineBold";
import { LiveStatus } from "./LiveStatus";
import { describeCall, summarizeResult } from "./summarize";
import { useT } from "@/lib/i18n/react";

function prettyJson(text: string, max: number): string {
  let shown = text;
  try {
    shown = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    /* Not JSON: show as is. */
  }
  return shown.length > max ? `${shown.slice(0, max)}\n…[${shown.length - max} more chars]` : shown;
}

function ToolCallRow({ call, result }: { call: ToolCall; result: string | undefined }) {
  const { t } = useT();
  const name = call.function.name;
  const summary = result === undefined ? null : summarizeResult(name, result);
  return (
    <details
      data-agent-step={name}
      data-status={summary === null ? "running" : summary.ok ? "ok" : "error"}
      className="group rounded-lg border border-line bg-raised/50 text-xs"
    >
      <summary className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 select-none">
        <span
          aria-hidden="true"
          className={cx(
            "size-1.5 shrink-0 rounded-full",
            summary === null ? "animate-pulse bg-ai" : summary.ok ? "bg-good" : "bg-danger",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-ink">{describeCall(name, call.function.arguments)}</span>
        <span className="shrink-0 font-mono text-faint">{name}</span>
        <span className="sr-only">{summary === null ? t("running") : summary.ok ? t("succeeded") : t("failed")}</span>
      </summary>
      <div className="space-y-2 border-t border-line px-2.5 py-2">
        {summary ? (
          <p className={cx("break-words", summary.ok ? "text-muted" : "text-danger")}>{summary.text}</p>
        ) : (
          <p className="text-muted">{t("Running…")}</p>
        )}
        <div>
          <div className="sk-label mb-1">{t("Arguments")}</div>
          <pre className="max-h-32 overflow-auto rounded-md border border-line bg-field p-2 font-mono text-[11px] break-words whitespace-pre-wrap text-muted">
            {prettyJson(call.function.arguments || "{}", 1200)}
          </pre>
        </div>
        {result !== undefined ? (
          <div>
            <div className="sk-label mb-1">{t("Result")}</div>
            <pre className="max-h-48 overflow-auto rounded-md border border-line bg-field p-2 font-mono text-[11px] break-words whitespace-pre-wrap text-muted">
              {prettyJson(result, 2000)}
            </pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}

export function Transcript({
  messages,
  activity,
  providerReady,
  suggestions,
  onPick,
}: {
  messages: TranscriptMessage[];
  activity: string | null;
  providerReady: boolean;
  /** Clickable starter prompts for the empty state, tuned to the current page. */
  suggestions: string[];
  onPick: (prompt: string) => void;
}) {
  const { t, tn } = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const results = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of messages) if (m.role === "tool") map.set(m.tool_call_id, m.content);
    return map;
  }, [messages]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, activity]);

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
      className="min-h-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto px-3 py-3"
      role="log"
      aria-live="polite"
      aria-label={t("Conversation")}
    >
      {messages.length === 0 ? (
        <div className="space-y-2 px-1 py-6 text-center text-sm text-faint">
          <p className="text-muted">{t("Ask me to use a tool for you.")}</p>
          {providerReady ? (
            <ul className="flex flex-col items-stretch gap-1.5 pt-2 text-left" aria-label={t("Suggested prompts")}>
              {suggestions.map((text) => (
                <li key={text}>
                  <button
                    autoComplete="off"
                    type="button"
                    onClick={() => onPick(text)}
                    className="w-full cursor-pointer rounded-xl border border-line bg-surface px-3 py-2 text-[13px] text-muted transition-colors hover:border-ai/50 hover:text-ink"
                  >
                    {text}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>{t("Add a model provider in settings first.")}</p>
          )}
        </div>
      ) : null}
      {messages.map((m, i) => {
        if (m.role === "tool") return null;
        if (m.role === "notice" && m.level === "usage") {
          return (
            <p key={i} data-agent-usage className="px-1 text-[11px] text-faint" title={t("Tokens used by this turn (prompt in, completion out)")}>
              {m.content}
            </p>
          );
        }
        if (m.role === "notice" && m.level === "summary") {
          return (
            <details key={i} data-agent-summary className="rounded-lg border border-line bg-raised/50 px-2.5 py-1.5 text-[11px] text-faint">
              <summary className="cursor-pointer select-none">
                {m.summarised
                  ? tn("Older messages summarised ({n} earlier request)", "Older messages summarised ({n} earlier requests)", m.summarised)
                  : t("Older messages summarised")}
              </summary>
              <p className="mt-1 break-words whitespace-pre-wrap">{m.content}</p>
            </details>
          );
        }
        if (m.role === "notice") {
          return (
            <Notice key={i} tone={m.level === "error" ? "error" : "info"}>
              {m.content}
            </Notice>
          );
        }
        if (m.role === "user") {
          return (
            <div key={i} className="flex justify-end">
              <p className="max-w-[88%] rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap text-accent-fg shadow-xs">
                {m.content}
              </p>
            </div>
          );
        }
        return (
          <div key={i} className="space-y-1.5">
            {m.content && m.content.trim() ? (
              <p className="max-w-[94%] rounded-2xl rounded-bl-md border border-line bg-surface px-3.5 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap text-ink">
                <InlineBold text={m.content} />
              </p>
            ) : null}
            {m.tool_calls?.map((call) => (
              <ToolCallRow key={call.id} call={call} result={results.get(call.id)} />
            ))}
          </div>
        );
      })}
      <LiveStatus messages={messages} />
    </div>
  );
}
