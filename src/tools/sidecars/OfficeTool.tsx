"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Dropzone, EmptyState, Field, Notice, Panel, Select, TextInput } from "@/components/ui";
import { formatBytes } from "@/lib/format";
import { OFFICE_FORMATS } from "@/lib/office/templates";
import {
  createDoc,
  deleteDoc,
  docDownloadUrl,
  editorConfig,
  ensureService,
  errorText,
  fileToBase64,
  getOp,
  listDocs,
  touchService,
  uploadDoc,
  type DocMeta,
  type OfficeFormat,
} from "./client";
import { OpProgress, SidecarCard } from "./SidecarCard";
import { OfficeLiveBridge, setActiveLiveBridge, type LiveState } from "@/lib/office/live-bridge";
import { useSidecar } from "./useSidecar";

const SERVICE = "office";
const FORMAT_LABEL: Record<OfficeFormat, string> = {
  docx: "Word document (.docx)",
  xlsx: "Excel spreadsheet (.xlsx)",
  pptx: "PowerPoint presentation (.pptx)",
  odt: "OpenDocument text (.odt)",
  ods: "OpenDocument spreadsheet (.ods)",
  odp: "OpenDocument presentation (.odp)",
};
const ACCEPT = OFFICE_FORMATS.map((f) => `.${f}`).join(",");

/** Pinned, locale-free timestamp (no hydration/locale drift). */
function when(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

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
  | { kind: "error"; message: string };

/** The editor for one document: lazy-starts the sidecar, loads DocsAPI from it and mounts the iframe. */
function DocEditor({ doc, sidecar, onClose }: { doc: DocMeta; sidecar: ReturnType<typeof useSidecar>; onClose: () => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<EditorPhase>({ kind: "starting" });
  const [saved, setSaved] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [closing, setClosing] = useState(false);
  // The editor batches a single user's changes for ~2 s before sending them; true while some are not on the server yet.
  const unsent = useRef(false);
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
        if (!cancelled) setPhase({ kind: "error", message: errorText(error) });
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

  const status =
    phase.kind === "starting"
      ? "Starting the office editor service…"
      : phase.kind === "loading"
        ? `Loading the editor for ${doc.name}…`
        : phase.kind === "ready"
          ? `Editor ready: ${doc.name}. Changes are saved back here automatically (also on Ctrl+S) and when you close the editor.`
          : `Could not open the editor: ${phase.message}`;

  return (
    <div className="space-y-3" data-wide="true">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-ink">{doc.name}</h2>
          <p role="status" aria-live="polite" data-agent-region="office-editor-status" className="text-sm text-muted">
            {status}
            {saved && phase.kind === "ready" ? ` ${saved}.` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <a className="inline-flex h-9 items-center rounded-lg border border-line-strong px-3.5 text-sm text-ink hover:bg-raised" href={docDownloadUrl(doc.id)} download={doc.name}>
            Download
          </a>
          <Button
            variant="primary"
            disabled={closing}
            onClick={async () => {
              // Destroying the editor drops changes it has not sent yet (the last ~2 s of typing or of the assistant's
              // edits): wait for "all changes sent" first, then the server saves the closed session (callback status 2).
              setClosing(true);
              const deadline = Date.now() + 15_000;
              while (unsent.current && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
              onClose();
            }}
          >
            {closing ? "Saving last changes…" : "Close editor"}
          </Button>
        </div>
      </div>
      {phase.kind === "starting" ? <OpProgress op={op} /> : null}
      {phase.kind === "error" ? <Notice tone="error">{phase.message}</Notice> : null}
      {live && phase.kind !== "error" ? (
        <p role="status" data-agent-region="office-live-status" className="text-xs text-faint">
          {liveLabel(live)}
        </p>
      ) : null}
      <div ref={holder} className="h-[calc(100vh-15rem)] min-h-[32rem] overflow-hidden rounded-tool border border-line bg-white" />
    </div>
  );
}

function DocRow({ doc, onOpen, onDeleted }: { doc: DocMeta; onOpen: () => void; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <tr className="border-t border-line align-middle">
      <td className="px-3 py-2">
        <span className="font-medium text-ink">{doc.name}</span>
        {error ? <span className="block text-xs text-danger">{error}</span> : null}
      </td>
      <td className="px-3 py-2"><Badge>{doc.format}</Badge></td>
      <td className="px-3 py-2 font-mono text-xs text-muted">{formatBytes(doc.bytes)}</td>
      <td className="px-3 py-2 font-mono text-xs text-muted">{when(doc.updatedAt)} · v{doc.version}</td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap justify-end gap-2">
          {confirming ? (
            <>
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  try {
                    await deleteDoc(doc.id);
                    onDeleted();
                  } catch (err) {
                    setError(errorText(err));
                    setConfirming(false);
                  }
                }}
              >
                Confirm delete {doc.name}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="primary" onClick={onOpen} aria-label={`Open ${doc.name}`}>Open</Button>
              <a className="inline-flex h-7 items-center rounded-lg border border-line-strong px-2.5 text-xs text-ink hover:bg-raised" href={docDownloadUrl(doc.id)} download={doc.name} aria-label={`Download ${doc.name}`}>
                Download
              </a>
              <Button size="sm" variant="danger" onClick={() => setConfirming(true)} aria-label={`Delete ${doc.name}`}>Delete</Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

/** Office documents: per-account library + the Euro-Office editor (sidecar). The library works without the sidecar. */
export default function OfficeTool() {
  const sidecar = useSidecar(SERVICE);
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [format, setFormat] = useState<OfficeFormat>("docx");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // Browser-only component (ssr: false in registry-client), so the URL can seed the state directly.
  const [openId, setOpenId] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("doc")));

  const reload = useCallback((): Promise<void> => {
    return (async () => {
      try {
        setDocs(await listDocs());
      } catch (err) {
        setError(errorText(err));
      }
    })();
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const open = (id: string | null) => {
    setOpenId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("doc", id);
    else url.searchParams.delete("doc");
    window.history.replaceState(window.history.state, "", url);
    if (!id) void reload();
  };

  const service = sidecar.service;
  const openDoc = openId ? docs?.find((d) => d.id === openId) : undefined;

  if (openId && openDoc && service?.installed) {
    return <DocEditor key={openDoc.id} doc={openDoc} sidecar={sidecar} onClose={() => open(null)} />;
  }

  return (
    <div className="space-y-5">
      {service && !service.installed ? (
        <SidecarCard
          sidecar={sidecar}
          compact
          intro={
            <Notice tone="info">
              Editing needs the office editor service, which is not installed yet. Your document library below works without it
              (create, upload, download, delete); Open becomes available once the service is installed.
            </Notice>
          }
        />
      ) : null}
      {openId && !openDoc && docs ? <Notice tone="warn">That document no longer exists.</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? <Notice tone="good">{notice}</Notice> : null}
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="New document">
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError(null);
              try {
                const doc = await createDoc(format, name.trim() || "Untitled");
                setName("");
                setNotice(`Created ${doc.name}.`);
                await reload();
              } catch (err) {
                setError(errorText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Type">
              <Select value={format} onChange={(e) => setFormat(e.target.value as OfficeFormat)}>
                {OFFICE_FORMATS.map((f) => (
                  <option key={f} value={f}>{FORMAT_LABEL[f]}</option>
                ))}
              </Select>
            </Field>
            <Field label="Name">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Untitled" maxLength={120} />
            </Field>
            <Button type="submit" variant="primary" disabled={busy}>Create</Button>
          </form>
        </Panel>
        <Panel title="Upload">
          <Dropzone
            accept={ACCEPT}
            multiple
            disabled={busy}
            hint="docx, xlsx, pptx, odt, ods, odp · up to 50 MB · stored in your library on this server"
            onFiles={async (files) => {
              setBusy(true);
              setError(null);
              try {
                for (const file of files) await uploadDoc(file.name, await fileToBase64(file));
                setNotice(`Uploaded ${files.map((f) => f.name).join(", ")}.`);
                await reload();
              } catch (err) {
                setError(errorText(err));
              } finally {
                setBusy(false);
              }
            }}
          />
        </Panel>
      </div>
      <Panel title="Your documents" right={docs ? <span className="text-xs text-faint">{docs.length} file{docs.length === 1 ? "" : "s"}</span> : null}>
        {docs === null ? (
          <p role="status" className="text-sm text-muted">Loading documents…</p>
        ) : docs.length === 0 ? (
          <EmptyState title="No documents yet">Create a blank document or upload one.</EmptyState>
        ) : (
          <div className="-mx-4 overflow-x-auto sm:-mx-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-faint">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Size</th>
                  <th className="px-3 py-2 font-medium">Updated (UTC)</th>
                  <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {docs.map((doc) => (
                  <DocRow
                    key={doc.id}
                    doc={doc}
                    onOpen={() => (service?.installed ? open(doc.id) : setError("Install the office editor service first (card above)."))}
                    onDeleted={() => {
                      setNotice(`Deleted ${doc.name}.`);
                      void reload();
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {service?.installed ? <p className="text-xs text-faint">Editor service: {service.ready ? "running" : "stopped (starts when you open a document)"} · manage it on the Sidecar services page.</p> : null}
    </div>
  );
}
