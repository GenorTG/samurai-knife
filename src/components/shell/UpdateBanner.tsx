"use client";

import { useEffect, useState } from "react";
import { fetchServerVersion, setLoadedVersion } from "@/lib/build-version";
import { useT } from "@/lib/i18n/react";

const CHECK_MS = 5 * 60_000;

/**
 * "Smart Knife was updated": after a release, a tab that was not reloaded runs the old code (old tools, old assistant
 * instructions). Checks GET /api/system/version every 5 minutes while visible and when the tab comes back, never at
 * load (the page was just rendered by the server it would ask). Shell chrome: outside <main>, never in agent snapshots.
 */
export function UpdateBanner({ version }: { version: string }) {
  const { t } = useT();
  const [server, setServer] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => setLoadedVersion(version), [version]);

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      const v = await fetchServerVersion();
      if (!stopped && v) setServer(v);
    };
    const timer = setInterval(() => void check(), CHECK_MS);
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!server || server === version || dismissed === server) return null;
  return (
    <div role="alert" className="fixed bottom-4 left-4 z-[70] flex max-w-[min(28rem,calc(100vw-2rem))] flex-wrap items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink shadow-pop">
      <span>{t("Smart Knife was updated (v{from} → v{to}). Reload to get the new version and the assistant's new tools.", { from: version, to: server })}</span>
      <button type="button" className="rounded-md bg-accent px-2.5 py-1 font-semibold text-accent-fg" onClick={() => window.location.reload()}>{t("Reload")}</button>
      <button type="button" className="rounded-md px-2 py-1 text-muted hover:bg-raised" onClick={() => setDismissed(server)}>{t("Later")}</button>
    </div>
  );
}
