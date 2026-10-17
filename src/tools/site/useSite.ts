"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, siteRequest, type SiteView } from "./client";

const POLL_MS = 3000;

/**
 * The account's website studio view: loaded once, then `GET /api/site?revision=N` every 3 s while the page is visible
 * (answers `{changed:false}` when nothing moved), so changes made by the assistant or an MCP agent show up by themselves.
 */
export function useSite(): { view: SiteView | null; error: string; reload: () => Promise<void> } {
  const [view, setView] = useState<SiteView | null>(null);
  const [error, setError] = useState("");
  const revision = useRef<number | null>(null);

  const load = useCallback(async (poll: boolean) => {
    try {
      const q = poll && revision.current !== null ? `?revision=${revision.current}` : "";
      const got = await siteRequest<SiteView | { changed: false; revision: number }>("GET", `/api/site${q}`);
      if ("changed" in got) return;
      revision.current = got.revision;
      setView(got);
      setError("");
    } catch (e) {
      if (!poll) setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load(false);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, POLL_MS);
    const onFocus = () => void load(true);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  return { view, error, reload: () => load(false) };
}
