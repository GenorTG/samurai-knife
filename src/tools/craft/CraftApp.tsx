"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, ButtonLink, Notice, usePageFullscreen } from "@/components/ui";
import { formatBytes } from "@/lib/format";
import { ARTCRAFT_APPS, type SidecarSite } from "@/lib/services/definitions";
import { craftFileDownloadUrl, ensureService, errorText, getCraftLaunch, getOp, isAdminRequired, saveCraftFile, touchService, type CraftFile, type OpView } from "@/tools/sidecars/client";
import { OpProgress, SidecarCard } from "@/tools/sidecars/SidecarCard";
import { useSidecar } from "@/tools/sidecars/useSidecar";
import { CraftUpdates } from "./CraftUpdates";
import { CraftFilesDrawer, CraftOpenChooser } from "./CraftFiles";
import { useCraftBridge, type OpenRequest, type PickedFile, type SaveRequest } from "./useCraftBridge";

const SERVICE = "craft";

type Stage =
  | { kind: "waiting" }
  | { kind: "starting" }
  | { kind: "ready"; url: string; origin: string; version: string; bridgeUrl: string; accountTag: string }
  | { kind: "failed"; message: string; needsAdmin?: boolean };

/** WebGPU, the clipboard and OPFS need a secure context: https, or http on localhost. */
function secureOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function withFlag(url: string, flag: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${flag}`;
}

/**
 * One Craft app (a tab of the `artcraft` suite; apps by the ArtCraft team): the `craft` sidecar serves it on an origin of its own and this page
 * embeds it in an iframe with exactly the sandbox its hosting notes ask for. Install card while the sidecar is missing,
 * then a lazy start (`ensure`) and the launch URL (`GET /api/craft`). docs/SIDECARS.md "ArtCraft".
 */
export default function CraftApp({ app: appId }: { app: string }) {
  const app = ARTCRAFT_APPS.find((candidate) => candidate.id === appId) as SidecarSite;
  const sidecar = useSidecar(SERVICE);
  const { follow, op } = sidecar;
  const installed = Boolean(sidecar.service?.installed);
  const [stage, setStage] = useState<Stage>({ kind: "waiting" });

  useEffect(() => {
    if (!installed) return;
    let cancelled = false;
    (async () => {
      setStage({ kind: "starting" });
      try {
        const deadline = Date.now() + 10 * 60_000;
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
            if (current.status === "failed") throw new Error(current.error ?? "the Craft apps server did not start");
          }
          if (cancelled) return;
          if (Date.now() > deadline) throw new Error("the Craft apps server did not become ready in time");
        }
        const launch = await getCraftLaunch();
        const entry = launch.apps.find((candidate) => candidate.id === app.id);
        if (!entry) throw new Error(`${app.name} is not served by this installation`);
        if (!cancelled) setStage({ kind: "ready", url: entry.url, origin: launch.origin, version: entry.version, bridgeUrl: entry.bridgeUrl, accountTag: launch.accountTag });
      } catch (err) {
        if (!cancelled) setStage({ kind: "failed", message: errorText(err), needsAdmin: isAdminRequired(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [installed, app.id, app.name, follow]);

  // Keeps the idle stop away while an app is open.
  const ready = stage.kind === "ready";
  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => void touchService(SERVICE).catch(() => {}), 60_000);
    return () => clearInterval(timer);
  }, [ready]);

  const service = sidecar.service;
  if (!service && !sidecar.error) return <CraftPlaceholder app={app} status="Checking the Craft apps server…" op={null} />;
  if (!service || !service.installed || !service.runtime.ok) {
    return (
      <SidecarCard
        sidecar={sidecar}
        compact
        intro={
          <Notice tone="info">
            {app.name} ({app.kind}) is one of {ARTCRAFT_APPS.length} open-source apps by the ArtCraft team that run entirely in your browser. A small web server on this machine serves
            them on an address of their own: install it once (about {Math.round(ARTCRAFT_APPS.reduce((sum, a) => sum + a.bytes, 0) / 1048576)} MB of
            downloads, checked against pinned hashes); it starts by itself when you open an app and stops when idle.
          </Notice>
        }
      />
    );
  }

  if (stage.kind === "failed") {
    return (
      <div className="space-y-4">
        <Notice tone={stage.needsAdmin ? "info" : "error"}>
          {stage.needsAdmin ? `An administrator has to start the Craft apps before you can use ${app.name}.` : `${app.name} could not start: ${stage.message}`}
        </Notice>
        <OpProgress op={op} />
      </div>
    );
  }

  if (stage.kind !== "ready") {
    return <CraftPlaceholder app={app} status="Starting the Craft apps server…" op={op} />;
  }

  return <CraftFrame app={app} stage={stage} canManage={Boolean(service.canManage)} />;
}

/** Same shape as the running workspace (toolbar + app area) while the app is not up yet, so it takes its place without a jump. */
function CraftPlaceholder({ app, status, op }: { app: SidecarSite; status: string; op: OpView | null }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-tool border border-line bg-surface px-3 py-2 shadow-card">
        <h2 className="shrink-0 text-[13px] font-semibold tracking-tight text-ink">{app.name}</h2>
        <p role="status" className="min-w-0 truncate text-xs text-muted">{status}</p>
      </div>
      <OpProgress op={op} />
      <div className="min-h-0 w-full flex-1 rounded-tool border border-line bg-black" aria-hidden="true" />
    </div>
  );
}

type SavedNote = { kind: "saved"; file: CraftFile } | { kind: "saving"; name: string } | { kind: "error"; message: string } | null;

/**
 * The running app: a hidden bridge frame first (account check, then Save/Open through Smart Knife, docs/SIDECARS.md
 * "Craft files"), the app frame once the bridge is ready. Fails closed: without the bridge the app does not load, or a
 * browser shared by several accounts could show the previous account's work.
 */
function CraftFrame({ app, stage, canManage }: { app: SidecarSite; stage: Extract<Stage, { kind: "ready" }>; canManage: boolean }) {
  const [webgl, setWebgl] = useState(false);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [note, setNote] = useState<SavedNote>(null);
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);

  const onSave = useCallback(
    async (request: SaveRequest) => {
      setNote({ kind: "saving", name: request.name });
      try {
        const { file } = await saveCraftFile(app.id, request.name, request.mime, request.bytes);
        setNote({ kind: "saved", file });
      } catch (err) {
        setNote({ kind: "error", message: `${request.name} was not saved: ${errorText(err)}` });
      }
    },
    [app.id],
  );
  const { frame: bridgeFrame, state: bridgeState, attempt: bridgeAttempt, onBridgeLoad, attach, deliver, cancel, retry } = useCraftBridge({
    origin: stage.origin,
    accountTag: stage.accountTag,
    onSave: (request) => void onSave(request),
    onTooBig: (name, size) => setNote({ kind: "error", message: `${name} (${formatBytes(size)}) is larger than your files take (50 MB): it was downloaded instead.` }),
    onOpen: (request) => setOpenRequest(request),
  });
  // The chooser took the focus: give it back to the app, so its next click or shortcut (Ctrl+S) reaches it.
  const closeChooser = () => {
    setOpenRequest(null);
    setTimeout(() => frame.current?.focus({ preventScroll: true }), 0);
  };

  const src = app.webgpu && webgl ? withFlag(stage.url, "webgl") : stage.url;
  const secure = secureOrigin(stage.origin);
  const status =
    bridgeState.kind === "connecting" ? `Preparing ${app.name}…` : bridgeState.kind === "failed" ? `${app.name} is not loaded.` : loadedSrc === src ? `${app.name} loaded from ${stage.origin}.` : `Loading ${app.name}…`;

  // The workspace: toolbar + app, sized to the window. Full screen covers the page with it (in the page, so the file
  // chooser and My files keep working); `?full=1` (Open in new tab) starts that way.
  const workspace = useRef<HTMLDivElement>(null);
  const fullscreen = usePageFullscreen(workspace);
  const { enter: enterFullscreen } = fullscreen;
  const startedFull = useRef(false);
  useEffect(() => {
    if (startedFull.current) return;
    startedFull.current = true;
    if (new URLSearchParams(window.location.search).get("full") === "1") enterFullscreen();
  }, [enterFullscreen]);
  const wasFull = useRef(false);
  useEffect(() => {
    if (wasFull.current && !fullscreen.active) {
      const url = new URL(window.location.href);
      if (url.searchParams.has("full")) {
        url.searchParams.delete("full");
        window.history.replaceState(window.history.state, "", url);
      }
    }
    wasFull.current = fullscreen.active;
  }, [fullscreen.active]);
  const notes: ReactNode[] = [];
  if (bridgeState.kind === "failed") {
    notes.push(
      <Notice key="bridge" tone="error">
        {bridgeState.message} {app.name} only loads once its files can go to your account (and a browser shared with someone else is cleared first).{" "}
        <Button size="sm" onClick={retry}>
          Try again
        </Button>
      </Notice>,
    );
  }
  if (bridgeState.kind === "ready" && bridgeState.wiped) notes.push(<p key="wiped">Another account used the Craft apps in this browser before you: their local data was cleared.</p>);
  if (!secure) {
    notes.push(
      <p key="secure">
        {app.webgpu
          ? `This address is plain http, which is not a secure context: WebGPU and the clipboard are off, so ${app.name} draws with WebGL2 (tick Force WebGL2 if it misbehaves). Serve the Craft apps over https for WebGPU.`
          : `This address is plain http, which is not a secure context: the clipboard is off and the browser may keep the library in IndexedDB instead of OPFS. Serve the Craft apps over https for the full storage.`}
      </p>,
    );
  }
  if (app.note) notes.push(<p key="note">{app.note}</p>);

  return (
    <>
      <iframe
        key={`bridge-${bridgeAttempt}`}
        ref={bridgeFrame}
        src={stage.bridgeUrl}
        title="Craft files bridge"
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        onLoad={onBridgeLoad}
        hidden
        aria-hidden="true"
        tabIndex={-1}
      />
      <div ref={workspace} className="flex h-full min-h-0 flex-col gap-2" data-craft-app={app.id} data-wide="true">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-tool border border-line bg-surface px-3 py-2 shadow-card">
          <h2 className="shrink-0 text-[13px] font-semibold tracking-tight text-ink">
            {app.name} <span className="font-normal text-faint">{stage.version}</span>
          </h2>
          <p role="status" className="min-w-0 truncate text-xs text-muted">
            {status}
          </p>
          {note ? (
            <p role="status" aria-live="polite" data-craft-saved className={`flex min-w-0 items-center gap-2 text-xs ${note.kind === "error" ? "text-danger" : "text-good"}`}>
              <span className="truncate">{note.kind === "saving" ? `Saving ${note.name} to your files…` : note.kind === "error" ? note.message : `Saved ${note.file.name} to your files.`}</span>
              {note.kind === "saved" ? (
                <a className="shrink-0 underline underline-offset-2 hover:text-ink" href={craftFileDownloadUrl(note.file.id)} download={note.file.name}>
                  Download
                </a>
              ) : null}
            </p>
          ) : null}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {app.webgpu ? (
              <label className="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={webgl} onChange={(event) => setWebgl(event.target.checked)} />
                Force WebGL2
              </label>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setFilesOpen(true)} title="Save and Export in the app keep the file here; Open offers these and this computer">
              My files
            </Button>
            {canManage ? (
              <Button size="sm" variant="ghost" onClick={() => setUpdatesOpen(true)}>
                Updates
              </Button>
            ) : null}
            <Button size="sm" aria-pressed={fullscreen.active} title={fullscreen.active ? "Back to the page (Esc)" : "Fill the page with the app; your files keep working"} onClick={fullscreen.active ? fullscreen.exit : fullscreen.enter}>
              {fullscreen.active ? "Exit full screen" : "Full screen"}
            </Button>
            <ButtonLink href="/credits" external size="sm">Credits</ButtonLink>
            {/* A new tab of this page (full screen), never the bare app: only here do Save and Open reach the account. */}
            <ButtonLink href={`/tools/artcraft?tab=${encodeURIComponent(app.id)}&full=1`} external size="sm">
              Open in new tab
            </ButtonLink>
          </div>
        </div>
        {notes.length ? <div className="space-y-1 text-xs text-faint">{notes}</div> : null}
        {canManage ? <CraftUpdates open={updatesOpen} onClose={() => setUpdatesOpen(false)} /> : null}
        <CraftFilesDrawer open={filesOpen} onClose={() => setFilesOpen(false)} highlight={note?.kind === "saved" ? note.file.id : null} />
        <CraftOpenChooser
          app={app.id}
          request={openRequest}
          onPick={(files: PickedFile[]) => {
            if (openRequest) deliver(openRequest.id, files);
            closeChooser();
          }}
          onCancel={() => {
            if (openRequest) cancel(openRequest.id);
            closeChooser();
          }}
        />
        {bridgeState.kind === "ready" ? (
          <iframe
            key={src}
            ref={frame}
            src={src}
            title={`${app.name} (${app.kind})`}
            sandbox={app.sandbox.join(" ")}
            allow={app.allow.join("; ")}
            allowFullScreen
            referrerPolicy="no-referrer"
            onLoad={() => {
              setLoadedSrc(src);
              attach();
            }}
            data-page-fill
            className="block min-h-0 w-full flex-1 rounded-tool border border-line bg-black"
          />
        ) : (
          <div data-page-fill className="min-h-0 w-full flex-1 rounded-tool border border-line bg-black" aria-hidden="true" />
        )}
      </div>
    </>
  );
}
