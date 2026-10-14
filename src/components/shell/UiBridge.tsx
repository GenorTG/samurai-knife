"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * Lets agents outside the app (MCP clients) see where this tab is and bring it to a page (`knife_ui_show`). Reports
 * presence on navigation, focus/visibility changes and every 20 s; polls for "show" requests while visible. Renders only
 * the short "opened by …" notice, outside <main> (never part of a page snapshot).
 */

const PRESENCE_MS = 20_000;
const NOTICE_MS = 7_000;
const POLL_MS = 1_500;

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
  path: string;
  note: string;
  target: string;
  from: string;
}

export function UiBridge() {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const [notice, setNotice] = useState<{ text: string; key: number } | null>(null);
  const id = useRef("");
  const where = `${pathname}${search.toString() ? `?${search.toString()}` : ""}`;
  const whereRef = useRef(where);

  // presence: on every navigation, focus / visibility change and on a slow heartbeat
  useEffect(() => {
    whereRef.current = where;
    if (!id.current) id.current = tabId();
    const report = () => {
      const visible = document.visibilityState === "visible";
      void fetch("/api/ui/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ clientId: id.current, path: whereRef.current, title: document.title.slice(0, 200), visible, active: visible && document.hasFocus() }),
      })
        // read the (tiny) body: an unread response stays "in flight" and the page's network never goes idle
        .then((res) => res.text())
        .catch(() => {});
    };
    report();
    const timer = setInterval(report, PRESENCE_MS);
    document.addEventListener("visibilitychange", report);
    window.addEventListener("focus", report);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", report);
      window.removeEventListener("focus", report);
    };
  }, [where]);

  // "show" requests for this tab: a short poll while the tab is visible (no long-lived connection: the network goes
  // idle between polls and background tabs hold nothing). The visible tab is also the one an agent should steer.
  useEffect(() => {
    if (!id.current) id.current = tabId();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const poll = async () => {
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch(`/api/ui/poll?client=${encodeURIComponent(id.current)}`, { credentials: "same-origin", cache: "no-store" });
          // always read the body (a 401 while signed out too): an unread response keeps the network busy
          const text = await res.text();
          const body = res.ok ? (JSON.parse(text) as { events?: ShowEvent[] }) : { events: [] };
          const event = body.events?.at(-1);
          // only paths inside the app; the server builds them from the registry, this is belt and braces
          if (event && event.target === id.current && event.path.startsWith("/tools/")) {
            router.push(event.path);
            setNotice({ text: event.note ? `${event.from}: ${event.note}` : `${event.from} opened this page.`, key: Date.now() });
          }
        } catch {
          // offline / server restarting: try again on the next tick
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
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
  }, [router]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!notice) return null;
  return (
    <div role="status" data-ui-bridge-notice className="pointer-events-none fixed top-16 left-1/2 z-50 -translate-x-1/2 rounded-full border border-accent/50 bg-surface px-4 py-2 text-sm text-ink shadow-pop">
      {notice.text}
    </div>
  );
}
