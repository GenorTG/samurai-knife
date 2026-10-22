"use client";

import { useEffect, useRef, useState } from "react";
import { Button, FullscreenButton, Notice } from "@/components/ui";
import { docDownloadUrl, editorConfig, ensureService, errorText, getDoc, getOp, isAdminRequired, touchService, type DocMeta } from "./client";
import { OpProgress } from "./SidecarCard";
import { OfficeLiveBridge, setActiveLiveBridge, type LiveState } from "@/lib/office/live-bridge";
import type { useSidecar } from "./useSidecar";

const SERVICE = "office";

interface DocsApiEditor {
  destroyEditor(): void;
}

interface DocsApiGlobal {
  DocEditor: new (placeholderId: string, config: Record<string, unknown>) => DocsApiEditor;
}

declare global {
  interface Window {
    DocsAPI?: DocsApiGlobal;
  }
}

function loadDocsApi(src: string): Promise<DocsApiGlobal> {
  const existing = document.querySelector<HTMLScriptElement>(`script[data-docsapi="${CSS.escape(src)}"]`);
  if (existing && window.DocsAPI) return Promise.resolve(window.DocsAPI);
  existing?.remove();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.docsapi = src;
    script.onload = () => (window.DocsAPI ? resolve(window.DocsAPI) : reject(new Error("api.js loaded but DocsAPI is missing")));
    script.onerror = () => reject(new Error(`could not load ${src} (is the office service reachable from this browser?)`));
    document.head.appendChild(script);
  });
}

function liveLabel(live: LiveState): string {
  if (live.state === "connected") return `Assistant live editing: connected (${live.editor} editor${live.viewMode ? ", read-only" : ""}).`;
  if (live.state === "connecting") return "Assistant live editing: connecting to the editor…";
  return `Assistant live editing unavailable: ${live.reason}.`;
}

type EditorPhase =
  | { kind: "starting" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string; needsAdmin?: boolean };

function DownloadLink({ doc }: { doc: DocMeta }) {
  return (
    <a className="inline-flex h-9 items-center rounded-lg border border-line-strong px-3.5 text-sm text-ink hover:bg-raised" href={docDownloadUrl(doc.id)} download={doc.name}>
      Download
    </a>
  );
}

/**
 * The editor service is not installed: nothing to start here. The library keeps working (the parent page), so this only
 * says so and offers the download. Installing/starting is the Sidecar services page's job (admins in public mode).
 */
function NotInstalled({ doc, onClose }: { doc: DocMeta; onClose: () => void }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-ink">{doc.name}</h2>
          <p role="status" aria-live="polite" data-agent-region="office-editor-status" className="text-sm text-muted">
            Could not open the editor: the office editor service is not installed on this server.
          </p>
        </div>
        <div className="flex gap-2">
          <DownloadLink doc={doc} />
          <Button variant="primary" onClick={onClose}>Back to documents</Button>
        </div>
      </div>
      <Notice tone="info">
        Editing in the browser needs the office editor service. Your documents are safe and the library works without it:
        upload, download, organise into folders, versions and the trash. Download this file to edit it on your computer, or
        open it here once the service is installed.
      </Notice>
    </div>
  );
}

/** The editor for one document: lazy-starts the sidecar, loads DocsAPI from it and mounts the iframe. */
export function DocEditor({ doc, sidecar, onClose }: { doc: DocMeta; sidecar: ReturnType<typeof useSidecar>; onClose: () => void }) {
  if (sidecar.service && !sidecar.service.installed) return <NotInstalled doc={doc} onClose={onClose} />;
  return <MountedEditor doc={doc} sidecar={sidecar} onClose={onClose} />;
}

function MountedEditor({ doc, sidecar, onClose }: { doc: DocMeta; sidecar: ReturnType<typeof useSidecar>; onClose: () => void }) {
  const holder = useRef<HTMLDivElement>(null);
  // Full screen covers the page with the whole editor panel (status, Download, Close), not the editor alone.
  const panel = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<EditorPhase>({ kind: "starting" });
  const [saved, setSaved] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [closing, setClosing] = useState(false);
  const [latest, setLatest] = useState<DocMeta>(doc);
  // The editor batches a single user's changes for ~2 s before sending them; true while some are not on the server yet.
  const unsent = useRef(false);
  const openedAt = useRef(new Date().toISOString());
  const { follow, op } = sidecar;

  useEffect(() => {
    let cancelled = false;
    let editor: DocsApiEditor | null = null;
    let bridge: OfficeLiveBridge | null = null;
    const host = holder.current;
    (async () => {
      try {
        // Lazy start: ensure until healthy, following the start op the server runs meanwhile.
        const deadline = Date.now() + 6 * 60_000;
        for (;;) {
          const answer = await ensureService(SERVICE);
          if (answer.ready) break;
          if (answer.op) {
            follow(answer.op);
            let current = answer.op;
            while (current.status === "running" && !cancelled) {
              await new Promise((r) => setTimeout(r, 1000));
              current = await getOp(current.opId);
              follow(current);
            }
            if (current.status === "failed") throw new Error(current.error ?? "the office service did not start");
          }
          if (cancelled) return;
          if (Date.now() > deadline) throw new Error("the office service did not become ready in time");
        }
        if (cancelled) return;
        setPhase({ kind: "loading" });
        const { apiUrl, config, live: session } = await editorConfig(doc.id);
        const api = await loadDocsApi(apiUrl);
        if (cancelled || !host) return;
        const placeholder = document.createElement("div");
        placeholder.id = `sk-office-editor-${doc.id}`;
        host.replaceChildren(placeholder);
        if (session) {
          // The assistant's channel into the editor (live-bridge.ts): listening before the editor exists, so the
          // plugin's first hello is never missed.
          bridge = new OfficeLiveBridge({
            token: session.token,
            sidecarOrigin: session.sidecarOrigin,
            docId: doc.id,
            docName: doc.name,
            editorFrame: () => host.querySelector("iframe"),
          });
          bridge.subscribe((state) => {
            if (!cancelled) setLive(state);
          });
          bridge.start();
          setLive(bridge.state);
          setActiveLiveBridge(bridge);
        }
        editor = new api.DocEditor(placeholder.id, {
          ...config,
          events: {
            onDocumentReady: () => {
              if (!cancelled) setPhase({ kind: "ready" });
              const frame = host.querySelector("iframe");
              frame?.setAttribute("title", `Office editor: ${doc.name}`);
            },
            onDocumentStateChange: (event: { data?: boolean }) => {
              unsent.current = event.data === true;
              if (!cancelled) setSaved(event.data ? "Editing… changes are being sent to the server" : `All changes sent (${new Date().toISOString().slice(11, 19)} UTC)`);
            },
            onError: (event: { data?: { errorCode?: number; errorDescription?: string } }) => {
              if (!cancelled) setPhase({ kind: "error", message: `Editor error ${event.data?.errorCode ?? ""}: ${event.data?.errorDescription ?? "unknown"}` });
            },
          },
        });
      } catch (error) {
        if (!cancelled) setPhase({ kind: "error", message: errorText(error), needsAdmin: isAdminRequired(error) });
      }
    })();
    const heartbeat = setInterval(() => void touchService(SERVICE).catch(() => {}), 60_000);
    return () => {
      cancelled = true;
      clearInterval(heartbeat);
      if (bridge) {
        bridge.stop();
        setActiveLiveBridge(null);
      }
      try {
        editor?.destroyEditor();
      } catch {
        /* already gone */
      }
      host?.replaceChildren();
    };
  }, [doc.id, doc.name, follow]);

  // Saves arrive through the server callback: poll the document for its version and for a refused save (storage full).
  useEffect(() => {
    if (phase.kind !== "ready") return;
    const timer = setInterval(() => {
      void getDoc(doc.id).then(setLatest, () => {});
    }, 10_000);
    return () => clearInterval(timer);
  }, [doc.id, phase.kind]);

  const saveError = latest.lastSaveError && latest.lastSaveError.at >= openedAt.current ? latest.lastSaveError.message : null;
  const status =
    phase.kind === "starting"
      ? "Starting the office editor service…"
      : phase.kind === "loading"
        ? `Loading the editor for ${doc.name}…`
        : phase.kind === "ready"
          ? `Editor ready: ${doc.name}. Changes are saved back here automatically (also on Ctrl+S) and when you close the editor; every save keeps the previous version.`
          : `Could not open the editor: ${phase.message}`;

  return (
    <div ref={panel} className="space-y-3" data-wide="true">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-ink">{doc.name}</h2>
          <p role="status" aria-live="polite" data-agent-region="office-editor-status" className="text-sm text-muted">
            {status}
            {saved && phase.kind === "ready" ? ` ${saved}.` : ""}
            {phase.kind === "ready" && latest.version > doc.version ? ` Saved as version ${latest.version}.` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          {phase.kind === "ready" ? <FullscreenButton target={panel} size="md" /> : null}
          <DownloadLink doc={doc} />
          <Button
            variant="primary"
            disabled={closing}
            onClick={async () => {
              // Destroying the editor drops changes it has not sent yet (the last ~2 s of typing or of the assistant's
              // edits): wait for "all changes sent" first, then the server saves the closed session (callback status 2).
              if (phase.kind !== "ready") return onClose();
              setClosing(true);
              const deadline = Date.now() + 15_000;
              while (unsent.current && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
              onClose();
            }}
          >
            {closing ? "Saving last changes…" : phase.kind === "error" ? "Back to documents" : "Close editor"}
          </Button>
        </div>
      </div>
      {phase.kind === "starting" ? <OpProgress op={op} /> : null}
      {phase.kind === "error" ? (
        <Notice tone={phase.needsAdmin ? "info" : "error"}>
          {phase.needsAdmin
            ? `${phase.message} The editor opens once it is running; until then the library still works (download, upload, organise).`
            : phase.message}
        </Notice>
      ) : null}
      {saveError ? <Notice tone="error">The last save was refused: {saveError} Your changes stay in the editor; free space, then press Ctrl+S.</Notice> : null}
      {live && phase.kind !== "error" ? (
        <p role="status" data-agent-region="office-live-status" className="text-xs text-faint">
          {liveLabel(live)}
        </p>
      ) : null}
      <div ref={holder} data-page-fill className={phase.kind === "error" ? "hidden" : "h-[calc(100vh-15rem)] min-h-[32rem] overflow-hidden rounded-tool border border-line bg-white"} />
    </div>
  );
}
