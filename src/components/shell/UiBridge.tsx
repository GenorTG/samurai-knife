"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { cx } from "@/lib/format";
import { liveNote, offeredLiveTools, runExternalCall, type ApproveFn } from "@/lib/agent-client/external-call";
import { useT } from "@/lib/i18n/react";

/**
 * Lets agents outside the app (MCP clients) see where this tab is, bring it to a page (`knife_ui_show`) and run one of
 * the page's live tools in it (`knife_ui_call`: the open document, the open Craft app). Reports presence (with the live
 * tools the page offers) on navigation, focus/visibility changes, every 20 s and when those tools change; polls for
 * requests while visible. Renders only the short "opened by …" notice and the approval card for an agent's call, outside
 * <main> (never part of a page snapshot).
 */

const PRESENCE_MS = 20_000;
const NOTICE_MS = 7_000;
const POLL_MS = 1_500;
const SIGNED_OUT_POLL_MS = 10_000;

function tabId(): string {
  const key = "sk-ui-client";
  let id = sessionStorage.getItem(key);
  if (!id) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    sessionStorage.setItem(key, id);
  }
  return id;
}

interface ShowEvent {
  kind?: "show";
  path: string;
  note: string;
  target: string;
  from: string;
}

interface CallEvent {
  kind: "call";
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  target: string;
  from: string;
  account?: string;
  ttlMs?: number;
}

type BridgeEvent = ShowEvent | CallEvent;

interface ApprovalRequest {
  key: string;
  title: string;
  detail: string;
  destructive: boolean;
  from: string;
  tool: string;
  args: string;
  answer: (yes: boolean) => void;
}

/** Live tools + state line: reported again whenever this changes (a document connects, a Craft app becomes ready). */
const liveSignature = (): string => `${offeredLiveTools().join(",")}|${liveNote()}`;

export function UiBridge() {
  const { t } = useT();
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const [notice, setNotice] = useState<{ text: string; key: number } | null>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const callChain = useRef<Promise<void>>(Promise.resolve());
  const reportedLive = useRef("");
  const id = useRef("");
  const where = `${pathname}${search.toString() ? `?${search.toString()}` : ""}`;
  const whereRef = useRef(where);
  const reportRef = useRef<() => Promise<void>>(async () => {});

  // presence: on every navigation, focus / visibility change and on a slow heartbeat
  useEffect(() => {
    whereRef.current = where;
    if (!id.current) id.current = tabId();
    const report = (): Promise<void> => {
      const visible = document.visibilityState === "visible";
      reportedLive.current = liveSignature();
      return fetch("/api/ui/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          clientId: id.current,
          path: whereRef.current,
          title: document.title.slice(0, 200),
          visible,
          active: visible && document.hasFocus(),
          tools: offeredLiveTools(),
          live: liveNote().slice(0, 300),
        }),
      })
        // read the (tiny) body: an unread response stays "in flight" and the page's network never goes idle
        .then((res) => res.text())
        .then(() => undefined)
        .catch(() => {});
    };
    reportRef.current = report;
    void report();
    const timer = setInterval(report, PRESENCE_MS);
    document.addEventListener("visibilitychange", report);
    window.addEventListener("focus", report);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", report);
      window.removeEventListener("focus", report);
    };
  }, [where]);

  // An agent's call: asks the user through the card below when the trust mode wants it, runs the tool, posts the answer.
  // One call at a time, in order. A call still waiting for the user when the agent stops waiting is dropped (denied).
  const approve = useCallback<ApproveFn>(
    (request) =>
      new Promise((resolve) => {
        const key = `${Date.now()}-${Math.random()}`;
        setApproval({ key, title: request.title, detail: request.detail, destructive: request.destructive, from: request.from, tool: request.tool, args: request.args, answer: (yes) => {
          setApproval((current) => (current?.key === key ? null : current));
          resolve(yes);
        } });
      }),
    [],
  );

  const runCall = useCallback(
    (event: CallEvent) => {
      callChain.current = callChain.current.then(async () => {
        const controller = new AbortController();
        let answerNow: ((yes: boolean) => void) | null = null;
        const gated: ApproveFn = (request) => {
          const asked = approve(request);
          return new Promise((resolve) => {
            answerNow = resolve;
            void asked.then(resolve);
          });
        };
        const timer = setTimeout(() => {
          controller.abort();
          answerNow?.(false);
          setApproval(null);
        }, Math.max(0, (event.ttlMs ?? 60_000) - 500));
        try {
          const answer = await runExternalCall({ tool: event.tool, args: event.args ?? {}, from: event.from, account: event.account }, gated, controller.signal);
          if (controller.signal.aborted) return; // nobody waits for it any more
          await fetch("/api/ui/call", {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ clientId: id.current, callId: event.callId, ...answer }),
          })
            .then((res) => res.text())
            .catch(() => {});
        } finally {
          clearTimeout(timer);
        }
      });
    },
    [approve],
  );

  // Requests for this tab: a short poll while the tab is visible (no long-lived connection: the network goes idle
  // between polls and background tabs hold nothing). The visible tab is also the one an agent should steer.
  useEffect(() => {
    if (!id.current) id.current = tabId();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const poll = async (retry = true) => {
      let delay = POLL_MS;
      if (document.visibilityState === "visible") {
        // the page's live tools changed (a document connected, a Craft app became ready): tell the server now
        if (liveSignature() !== reportedLive.current) void reportRef.current();
        try {
          const res = await fetch(`/api/ui/poll?client=${encodeURIComponent(id.current)}`, { credentials: "same-origin", cache: "no-store" });
          // always read the body (a 401 while signed out too): an unread response keeps the network busy
          const text = await res.text();
          // Signed out (public mode visitors): nothing can be shown to this tab, so ask far less often.
          if (res.status === 401) delay = SIGNED_OUT_POLL_MS;
          const body = res.ok ? (JSON.parse(text) as { known?: boolean; events?: BridgeEvent[] }) : { events: [] };
          // The server does not know this tab yet (first poll raced the first report, or it restarted): report, poll again.
          if (res.ok && body.known === false && retry) {
            await reportRef.current();
            if (!stopped) void poll(false);
            return;
          }
          for (const call of body.events ?? []) {
            if (call.kind === "call" && call.target === id.current) runCall(call);
          }
          const event = (body.events ?? []).filter((e): e is ShowEvent => e.kind !== "call").at(-1);
          // only paths inside the app; the server builds them from the registry, this is belt and braces
          if (event && event.target === id.current && event.path.startsWith("/tools/")) {
            router.push(event.path);
            setNotice({ text: event.note ? `${event.from}: ${event.note}` : `${event.from} opened this page.`, key: Date.now() });
          }
        } catch {
          // offline / server restarting: try again on the next tick
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    };
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void poll();
    };
    void poll();
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [router, runCall]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <>
      {notice ? (
        <div role="status" data-ui-bridge-notice className="pointer-events-none fixed top-16 left-1/2 z-50 -translate-x-1/2 rounded-full border border-accent/50 bg-surface px-4 py-2 text-sm text-ink shadow-pop">
          {notice.text}
        </div>
      ) : null}
      {approval ? (
        <div
          role="alertdialog"
          aria-label={`${approval.from}: ${approval.title}`}
          data-ui-call-approval={approval.destructive ? "destructive" : ""}
          className={cx(
            "fixed top-16 right-4 z-[60] flex w-[min(92vw,24rem)] flex-col gap-2 rounded-lg border bg-surface p-3 shadow-pop",
            approval.destructive ? "border-danger/60" : "border-ai/50",
          )}
        >
          <p className="text-xs text-muted">
            {t("{from} wants to run", { from: approval.from })}{" "} <code className="font-mono">{approval.tool}</code> {" "}{t("in this tab")}
          </p>
          <p className={cx("text-sm font-medium", approval.destructive ? "text-danger" : "text-ink")}>
            {approval.destructive ? "⚠ " : ""}
            {approval.title}
          </p>
          {approval.detail && approval.detail !== approval.tool ? <p className="text-xs break-words text-muted">{approval.detail}</p> : null}
          {approval.args ? (
            <pre data-ui-call-args className="max-h-32 overflow-auto rounded border border-line bg-raised px-2 py-1 font-mono text-[11px] break-all whitespace-pre-wrap text-muted">{approval.args}</pre>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => approval.answer(false)}>
              {t("Deny")}
            </Button>
            <Button size="sm" variant={approval.destructive ? "danger" : "primary"} onClick={() => approval.answer(true)}>
              {t("Allow")}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
