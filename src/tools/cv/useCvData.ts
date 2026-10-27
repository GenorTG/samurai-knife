"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, getCv, undoCv, type CvProjectInfo } from "@/lib/cv/client";
import { CV_PROJECT_EVENT, setShownProject } from "@/lib/cv/shown-project";
import { diffCollections, diffCv, type FieldChange } from "@/lib/cv/diff";
import type { CvData } from "@/lib/cv/schema";

const POLL_MS = 2000;

export interface ChangeBatch {
  /** Increases with every batch so effects run once per batch. */
  seq: number;
  revision: number;
  changes: FieldChange[];
}

export interface CvLive {
  data: CvData | null;
  status: "loading" | "ready" | "error";
  error: string;
  /** Force a refetch now (call after your own mutation). */
  reload: () => Promise<void>;
  /** The newest batch of changes seen between two revisions (assistant or user), for flash + toast. */
  batch: ChangeBatch | null;
  /** POST /api/cv/undo, then refetch. Resolves to an error text or "". */
  undo: () => Promise<string>;
  /** The CV project shown (the account's active one; follows a switch made elsewhere on the next poll). */
  project: string | null;
  /** The account's CV projects. */
  projects: CvProjectInfo[];
}

/**
 * Loads the active CV project's data once, then polls `GET /api/cv?revision=N&shown=<project>` every ~2 s while the page is visible (cheap: answers
 * `{changed:false}`), pauses when hidden and refetches on focus. Every revision change is diffed against the previous
 * data, so any edit (assistant via knife_cv_* tools, the user, another tab) is reported as a `batch`.
 */
export function useCvData(): CvLive {
  const [data, setData] = useState<CvData | null>(null);
  const [status, setStatus] = useState<CvLive["status"]>("loading");
  const [error, setError] = useState("");
  const [batch, setBatch] = useState<ChangeBatch | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [projects, setProjects] = useState<CvProjectInfo[]>([]);
  const dataRef = useRef<CvData | null>(null);
  const projectRef = useRef<string | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const seq = useRef(0);
  const alive = useRef(true);

  const load = useCallback((force: boolean): Promise<void> => {
    if (inflight.current) return inflight.current;
    const run = (async () => {
      try {
        const known = dataRef.current?.revision;
        const res = await getCv(force || !known || !projectRef.current ? undefined : { revision: known, project: projectRef.current });
        if (!alive.current) return;
        setError("");
        setStatus("ready");
        if (!res.changed) return;
        const { changed, project: nextProject, active, projects: list, ...next } = res;
        void changed;
        void active;
        setProjects(list);
        // Another project became active (the switcher, the assistant, another tab): show it as it is, no change toast.
        const switched = projectRef.current !== null && projectRef.current !== nextProject;
        projectRef.current = nextProject;
        setShownProject(nextProject);
        setProject(nextProject);
        const prev = switched ? null : dataRef.current;
        if (prev && prev.revision === next.revision) return;
        const changes = prev ? [...diffCv(prev.profile, next.profile), ...diffCollections(prev, next)] : [];
        dataRef.current = next;
        setData(next);
        if (changes.length > 0) {
          seq.current += 1;
          setBatch({ seq: seq.current, revision: next.revision, changes });
        }
      } catch (e) {
        if (!alive.current) return;
        setError(errorText(e));
        setStatus((s) => (dataRef.current ? s : "error"));
      } finally {
        inflight.current = null;
      }
    })();
    inflight.current = run;
    return run;
  }, []);

  useEffect(() => {
    alive.current = true;
    void load(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      timer = setTimeout(async () => {
        if (document.visibilityState === "visible") await load(false);
        tick();
      }, POLL_MS);
    };
    tick();
    const wake = () => {
      if (document.visibilityState === "visible") void load(false);
    };
    const switched = () => void load(true);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener(CV_PROJECT_EVENT, switched);
    return () => {
      alive.current = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener(CV_PROJECT_EVENT, switched);
    };
  }, [load]);

  // A poll that started before our own mutation may still be in flight with the old revision: let it land, then force a read.
  const reload = useCallback(async (): Promise<void> => {
    if (inflight.current) await inflight.current;
    await load(true);
  }, [load]);
  const undo = useCallback(async (): Promise<string> => {
    try {
      await undoCv();
      await load(true);
      return "";
    } catch (e) {
      return errorText(e);
    }
  }, [load]);

  return { data, status, error, reload, batch, undo, project, projects };
}
