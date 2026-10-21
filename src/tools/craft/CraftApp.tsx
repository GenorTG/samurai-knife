"use client";

import { useEffect, useRef, useState } from "react";
import { ButtonLink, FullscreenButton, Notice, Panel } from "@/components/ui";
import { ARTCRAFT_APPS, type SidecarSite } from "@/lib/services/definitions";
import { ensureService, errorText, getCraftLaunch, getOp, isAdminRequired, touchService } from "@/tools/sidecars/client";
import { OpProgress, SidecarCard } from "@/tools/sidecars/SidecarCard";
import { useSidecar } from "@/tools/sidecars/useSidecar";

const SERVICE = "craft";

type Stage =
  | { kind: "waiting" }
  | { kind: "starting" }
  | { kind: "ready"; url: string; origin: string }
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
 * One ArtCraft app (a tab of the `artcraft` suite): the `craft` sidecar serves it on an origin of its own and this page
 * embeds it in an iframe with exactly the sandbox its hosting notes ask for. Install card while the sidecar is missing,
 * then a lazy start (`ensure`) and the launch URL (`GET /api/craft`). docs/SIDECARS.md "ArtCraft".
 */
export default function CraftApp({ app: appId }: { app: string }) {
  const app = ARTCRAFT_APPS.find((candidate) => candidate.id === appId) as SidecarSite;
  const sidecar = useSidecar(SERVICE);
  const { follow, op } = sidecar;
  const installed = Boolean(sidecar.service?.installed);
  const [stage, setStage] = useState<Stage>({ kind: "waiting" });
  const [webgl, setWebgl] = useState(false);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);

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
            if (current.status === "failed") throw new Error(current.error ?? "the ArtCraft server did not start");
          }
          if (cancelled) return;
          if (Date.now() > deadline) throw new Error("the ArtCraft server did not become ready in time");
        }
        const launch = await getCraftLaunch();
        const entry = launch.apps.find((candidate) => candidate.id === app.id);
        if (!entry) throw new Error(`${app.name} is not served by this installation`);
        if (!cancelled) setStage({ kind: "ready", url: entry.url, origin: launch.origin });
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
  if (!service || !service.installed || !service.runtime.ok) {
    return (
      <SidecarCard
        sidecar={sidecar}
        compact
        intro={
          <Notice tone="info">
            {app.name} ({app.kind}) is one of {ARTCRAFT_APPS.length} ArtCraft apps that run entirely in your browser. A small web server on this machine serves
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
          {stage.needsAdmin ? `An administrator has to start the ArtCraft apps before you can use ${app.name}.` : `${app.name} could not start: ${stage.message}`}
        </Notice>
        <OpProgress op={op} />
      </div>
    );
  }

  if (stage.kind !== "ready") {
    return (
      <div className="space-y-3">
        <p role="status" className="text-sm text-muted">Starting the ArtCraft server…</p>
        <OpProgress op={op} />
      </div>
    );
  }

  const src = app.webgpu && webgl ? withFlag(stage.url, "webgl") : stage.url;
  const secure = secureOrigin(stage.origin);
  return (
    <div className="space-y-3" data-craft-app={app.id}>
      <Panel
        title={`${app.name} ${app.version}`}
        right={
          <div className="flex flex-wrap items-center gap-3">
            {app.webgpu ? (
              <label className="flex items-center gap-2 text-sm text-muted">
                <input type="checkbox" checked={webgl} onChange={(event) => setWebgl(event.target.checked)} />
                Force WebGL2
              </label>
            ) : null}
            <FullscreenButton target={frame} />
            <ButtonLink href={src} external size="sm">
              Open in new tab
            </ButtonLink>
          </div>
        }
        bodyClassName="space-y-2 p-3 sm:p-3"
      >
        <p role="status" className="text-sm text-muted">
          {loadedSrc === src ? `${app.name} loaded from ${stage.origin}.` : `Loading ${app.name}…`}
        </p>
        {!secure ? (
          <p className="text-xs text-faint">
            {app.webgpu
              ? `This address is plain http, which is not a secure context: WebGPU and the clipboard are off, so ${app.name} draws with WebGL2 (tick Force WebGL2 if it misbehaves). Serve ArtCraft over https for WebGPU.`
              : `This address is plain http, which is not a secure context: the clipboard is off and the browser may keep the library in IndexedDB instead of OPFS. Serve ArtCraft over https for the full storage.`}
          </p>
        ) : null}
        {app.note ? <p className="text-xs text-faint">{app.note}</p> : null}
        <p className="text-xs text-faint">
          Files you open stay in this browser; Save and Export download them. {app.license},{" "}
          <a className="underline underline-offset-2 hover:text-ink" href={app.repo} target="_blank" rel="noopener noreferrer">
            source
          </a>
          .
        </p>
      </Panel>
      <iframe
        key={src}
        ref={frame}
        src={src}
        title={`${app.name} (${app.kind})`}
        sandbox={app.sandbox.join(" ")}
        allow={app.allow.join("; ")}
        allowFullScreen
        referrerPolicy="no-referrer"
        onLoad={() => setLoadedSrc(src)}
        className="block h-[calc(100dvh-15rem)] min-h-[560px] w-full rounded-tool border border-line bg-black [&:fullscreen]:rounded-none [&:fullscreen]:border-0"
      />
    </div>
  );
}
