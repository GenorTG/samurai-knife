"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, siteRequest, type SiteView } from "./client";
import { CV_PROJECT_EVENT, shownProject } from "@/lib/cv/shown-project";

const POLL_MS = 3000;

/**
 * The account's website studio view: loaded once, then `GET /api/site?revision=N` every 3 s while the page is visible
 * (answers `{changed:false}` when nothing moved), so changes made by the assistant or an MCP agent show up by themselves.
 */
export function useSite(): { view: SiteView | null; error: string; reload: () => Promise<void> } {
  const [view, setView] = useState<SiteView | null>(null);
  const [error, setError] = useState("");
  const revision = useRef<number | null>(null);
  const shownWas = useRef<string | null>(null);

  const load = useCallback(async (poll: boolean) => {
    try {
      // A revision only means something for the CV project it came from: after a switch, read the new one in full.
      const same = shownWas.current === shownProject();
      shownWas.current = shownProject();
      const q = poll && same && revision.current !== null ? `?revision=${revision.current}` : "";
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
    const onSwitch = () => void load(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener(CV_PROJECT_EVENT, onSwitch);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(CV_PROJECT_EVENT, onSwitch);
    };
  }, [load]);

  return { view, error, reload: () => load(false) };
}
