"use client";

import { useEffect, useRef } from "react";
import { cx } from "@/lib/format";
import {
  answerApproval,
  answerForeground,
  answerWait,
  setTrustMode,
  useInteraction,
  TRUST_MODES,
} from "@/lib/agent-client/interaction";
import { useT } from "@/lib/i18n/react";

/** Four-level trust switch: how much the assistant must ask before it acts. */
export function TrustModeSwitch({ chatId = "default" }: { chatId?: string }) {
  const { t } = useT();
  const { mode } = useInteraction(chatId);
  const current = TRUST_MODES.find((m) => m.id === mode) ?? TRUST_MODES[2];
  return (
    <div className="border-b border-line bg-surface px-3 py-1.5">
      <div role="radiogroup" aria-label={t("Ask before acting")} className="flex items-center gap-1">
        <span className="mr-1 text-[11px] text-faint">{t("Ask before acting:")}</span>
        {TRUST_MODES.map((o) => (
          <button
            autoComplete="off"
            key={o.id}
            type="button"
            role="radio"
            aria-checked={mode === o.id}
            title={t(o.hint)}
            onClick={() => setTrustMode(o.id, chatId)}
            className={cx(
              "rounded-md px-2 py-1 text-xs font-medium transition-colors",
              mode === o.id ? "bg-ai/15 text-ink ring-1 ring-ai/40" : "text-muted hover:bg-raised hover:text-ink",
            )}
          >
            {t(o.label)}
          </button>
        ))}
      </div>
      <p className="mt-0.5 text-[11px] leading-snug text-faint">{t(current.hint)}</p>
    </div>
  );
}

/** Approval and waiting prompts, pinned above the composer so they are never scrolled away. */
export function InteractionCards({ onStop, chatId = "default" }: { onStop: () => void; chatId?: string }) {
  const { t } = useT();
  const { approval, wait, page } = useInteraction(chatId);
  const allowRef = useRef<HTMLButtonElement>(null);
  const hasApproval = approval !== null;

  useEffect(() => {
    if (hasApproval) allowRef.current?.focus({ preventScroll: true });
  }, [hasApproval]);

  if (approval) {
    return (
      <div
        role="alertdialog"
        aria-label={approval.title}
        data-agent-approval={approval.destructive ? "destructive" : ""}
        className={cx(
          "space-y-2 border-t px-3 py-2.5",
          approval.destructive ? "border-danger/50 bg-danger/8" : "border-ai/40 bg-ai/8",
        )}
      >
        <p className={cx("text-sm font-medium", approval.destructive ? "text-danger" : "text-ink")}>
          {approval.destructive ? "⚠ " : ""}
          {approval.title}
        </p>
        <p className="text-xs break-words text-muted">{approval.detail}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            autoComplete="off"
            ref={allowRef}
            type="button"
            onClick={() => answerApproval("allow", chatId)}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg hover:brightness-110"
          >
            {t("Allow")}
          </button>
          <button
            autoComplete="off"
            type="button"
            onClick={() => answerApproval("deny", chatId)}
            className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs text-ink hover:bg-raised"
          >
            {t("Deny")}
          </button>
          {approval.destructive ? null : (
            <button
              autoComplete="off"
              type="button"
              onClick={() => answerApproval("allow_run", chatId)}
              className="ml-auto rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-raised hover:text-ink"
              title={t("Stop asking for the rest of this run. Destructive steps still ask.")}
            >
              {t("Allow rest of this run")}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (page) {
    // A step of this chat that needs the live page, reached while the chat ran in the background.
    return (
      <div role="alertdialog" aria-label={t("This step needs the page")} data-agent-page-step="" className="space-y-2 border-t border-ai/40 bg-ai/8 px-3 py-2.5">
        <p className="text-sm font-medium text-ink">{t("This step needs the page: {label}. Open it now?", { label: page.label })}</p>
        <p className="text-xs text-faint">{t("This chat worked in the background while you were in another chat; only the chat you are looking at may use the page.")}</p>
        <div className="flex items-center gap-1.5">
          <button autoComplete="off" type="button" onClick={() => answerForeground("open", chatId)} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg hover:brightness-110">
            {t("Open")}
          </button>
          <button autoComplete="off" type="button" onClick={() => answerForeground("skip", chatId)} className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs text-ink hover:bg-raised">
            {t("Skip")}
          </button>
        </div>
      </div>
    );
  }

  if (wait) {
    return (
      <div role="status" data-agent-wait="" className="space-y-2 border-t border-ai/40 bg-ai/8 px-3 py-2.5">
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-ai" />
          {t("Waiting for you")}
        </p>
        <p className="text-sm break-words text-muted">{wait.message}</p>
        {wait.targetId ? (
          <p className="text-xs text-faint">
            {t("Use the highlighted control on the page")}{wait.targetLabel ? ` (${wait.targetLabel})` : ""}{t("; I continue by myself once you do. Or reply below.")}
          </p>
        ) : (
          <p className="text-xs text-faint">{t("Reply below or press Continue when you are ready.")}</p>
        )}
        <div className="flex items-center gap-1.5">
          <button
            autoComplete="off"
            type="button"
            onClick={() => answerWait("continue", undefined, chatId)}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg hover:brightness-110"
          >
            {t("Continue")}
          </button>
          <button
            autoComplete="off"
            type="button"
            onClick={onStop}
            className="rounded-lg border border-danger/40 px-3 py-1.5 text-xs text-danger hover:bg-danger/10"
          >
            {t("Cancel run")}
          </button>
        </div>
      </div>
    );
  }
  return null;
}
