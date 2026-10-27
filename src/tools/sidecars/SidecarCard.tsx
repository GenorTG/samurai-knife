"use client";

import { useState, type ReactNode } from "react";
import { Badge, Button, Field, KeyValues, Meter, Notice, NumberField, Panel, TextInput } from "@/components/ui";
import { formatBytes } from "@/lib/format";
import { configureService, errorText, type OpView, type ServiceView } from "./client";
import type { useSidecar } from "./useSidecar";
import { SyncNeededNotice } from "@/components/SyncNeededNotice";
import { useT } from "@/lib/i18n/react";
import { msg } from "@/lib/i18n/msg";

type Sidecar = ReturnType<typeof useSidecar>;

export function serviceBadge(service: ServiceView | null, op: OpView | null): { tone: "neutral" | "good" | "warn" | "danger" | "accent"; text: string } {
  if (op?.status === "running") return { tone: "accent", text: `${op.kind === "idle-stop" ? "Stopping (idle)" : op.kind[0].toUpperCase() + op.kind.slice(1)}…` };
  if (!service) return { tone: "neutral", text: "Checking…" };
  if (!service.runtime.ok) return { tone: "danger", text: msg("No container runtime") };
  if (!service.installed) return { tone: "neutral", text: msg("Not installed") };
  if (service.ready) return { tone: "good", text: "Running" };
  if (service.container.state === "running") return { tone: "warn", text: "Starting" };
  return { tone: "neutral", text: "Stopped" };
}

/** Live progress of a sidecar op: phase line + meter + pull bytes, log tail on demand. role=status for the agent and tests. */
export function OpProgress({ op }: { op: OpView | null }) {
  const { t } = useT();
  if (!op) return null;
  const pull = op.pull;
  const seconds = Math.round(op.elapsedMs / 1000);
  return (
    <div className="space-y-2" data-agent-region="sidecar-progress">
      <p role="status" aria-live="polite" className="text-sm text-muted">
        {op.status === "running" ? `${op.phase}… (${seconds} s)` : op.status === "done" ? `${op.phase} (${seconds} s).` : `Failed: ${op.error ?? op.phase}`}
        {pull && op.status === "running" && pull.totalBytes > 0 ? ` ${formatBytes(pull.downloadedBytes)} of ${formatBytes(pull.totalBytes)} downloaded, ${pull.layersDone}/${pull.layers} layers done.` : ""}
      </p>
      {op.status === "running" && op.percent !== undefined ? <Meter value={op.percent} label={t("{kind} progress", { kind: op.kind })} tone="good" /> : null}
      {op.log.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-faint">{t("Log ({log} lines)", { log: op.log.length })}</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded-lg border border-line bg-raised/50 p-2 font-mono text-[11px] whitespace-pre-wrap text-muted">{op.log.slice(-40).join("\n")}</pre>
        </details>
      ) : null}
    </div>
  );
}

function RemoveControls({ sidecar }: { sidecar: Sidecar }) {
  const { t } = useT();
  const [confirming, setConfirming] = useState(false);
  const [purge, setPurge] = useState(false);
  if (!confirming) {
    return (
      <Button variant="danger" disabled={sidecar.running} onClick={() => setConfirming(true)}>
        {t("Remove…")}
      </Button>
    );
  }
  return (
    <div className="flex w-full flex-wrap items-center gap-3 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2">
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
        {t("Also delete its data volumes and secrets")}
      </label>
      <Button
        variant="danger"
        onClick={() => {
          setConfirming(false);
          void sidecar.act({ action: "remove", purge });
        }}
      >
        {t("Confirm remove")}
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(false)}>
        {t("Keep it")}
      </Button>
    </div>
  );
}

function Settings({ sidecar, service }: { sidecar: Sidecar; service: ServiceView }) {
  const { t } = useT();
  const state = service.state;
  const [port, setPort] = useState(state?.hostPort ?? 0);
  const [appUrl, setAppUrl] = useState(state?.appUrl ?? "");
  const [publicUrl, setPublicUrl] = useState(state?.publicUrl ?? "");
  const [idle, setIdle] = useState(state?.idleStopMinutes ?? 30);
  const [autostart, setAutostart] = useState(Boolean(state?.autostart));
  const [note, setNote] = useState<{ tone: "good" | "error"; text: string } | null>(null);
  if (!state) return null;
  return (
    <details className="rounded-lg border border-line px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium text-ink">{t("Settings")}</summary>
      <form
        className="mt-3 grid gap-3 sm:grid-cols-2"
        onSubmit={async (event) => {
          event.preventDefault();
          setNote(null);
          try {
            const result = await configureService(service.id, { port, appUrl: appUrl.trim() || null, publicUrl: publicUrl.trim() || null, idleStopMinutes: idle, autostart });
            setNote({ tone: "good", text: result.restartNeeded ? "Saved. Restart (Stop, Start) to use the new port." : "Saved." });
            void sidecar.refresh();
          } catch (error) {
            setNote({ tone: "error", text: errorText(error) });
          }
        }}
      >
        <Field label={t("Port")} hint={t("Published on {bindHost} only.", { bindHost: state.bindHost })}>
          <NumberField value={port} onValueChange={setPort} min={1024} max={65535} integer />
        </Field>
        <Field label={t("Stop when idle (minutes)")} hint={autostart ? t("Not used while it starts automatically.") : t("0 = never stop on its own.")}>
          <NumberField value={idle} onValueChange={setIdle} min={0} max={1440} integer />
        </Field>
        <label className="flex items-start gap-2 text-sm text-ink sm:col-span-2">
          <input type="checkbox" className="mt-1" checked={autostart} onChange={(e) => setAutostart(e.target.checked)} />
          <span>
            {t("Start automatically")}
            <span className="block text-xs text-muted">{t("Starts when the app starts and again within a minute if it stops, so users never wait for an administrator. Stop holds it stopped until the next Start.")}</span>
          </span>
        </label>
        {service.callsBack ? (
          <Field label={t("App URL (container → app)")} hint={t("Empty = {value}.", { value: service.appUrl.source === "state" ? "derived" : service.appUrl.url })}>
            <TextInput value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder={service.appUrl.url} />
          </Field>
        ) : null}
        <Field label={t("Public URL (browser → service)")} hint={t("Empty = the bind address and port.")}>
          <TextInput value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} placeholder={t("http://{bindHost}:{hostPort}", { bindHost: state.bindHost, hostPort: state.hostPort })} />
        </Field>
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="submit" variant="primary">{t("Save settings")}</Button>
          {note ? <span className={note.tone === "good" ? "text-sm text-good" : "text-sm text-danger"}>{note.text}</span> : null}
        </div>
      </form>
    </details>
  );
}

/**
 * Status + lifecycle controls of one sidecar. `compact` = the install card a tool shows while its sidecar is missing
 * (no settings, no update/remove).
 */
export function SidecarCard({ sidecar, compact = false, intro }: { sidecar: Sidecar; compact?: boolean; intro?: ReactNode }) {
  const { t } = useT();
  const { service, op, running, error } = sidecar;
  const badge = serviceBadge(service, op);
  if (!service) {
    return (
      <Panel title={t("Sidecar")}>
        <p role="status" className="text-sm text-muted">{error ? t("Could not read the service status: {message}", { message: error.message }) : t("Checking the service…")}</p>
      </Panel>
    );
  }
  const state = service.state;
  const canManage = service.canManage !== false;
  if (!canManage) {
    // Public mode, not an administrator: the shared service is used, never managed (no buttons, no configuration).
    const running = service.installed && service.ready;
    return (
      <Panel title={service.name} right={<Badge tone={badge.tone}>{t(badge.text)}</Badge>} className="sk-sidecar-card">
        <div className="space-y-4">
          {intro}
          <p className="text-sm text-muted">{t(service.description)}</p>
          {running ? (
            <Notice tone="good">{service.name} {" "}{t("is running and ready to use.")}</Notice>
          ) : (
            <Notice tone="info">
              {!service.installed ? t("An administrator has to install {name}", { name: service.name }) : t("An administrator has to start {name}", { name: service.name })} {" "}{t("before you can use it here.")}
            </Notice>
          )}
          <OpProgress op={op} />
        </div>
      </Panel>
    );
  }
  return (
    <Panel title={service.name} right={<Badge tone={badge.tone}>{t(badge.text)}</Badge>} className="sk-sidecar-card">
      <div className="space-y-4">
        {intro}
        <p className="text-sm text-muted">{t(service.description)}</p>
        {!service.runtime.ok ? (
          <Notice tone="error">
            {service.runtime.message} {t(service.runtime.hint)}
          </Notice>
        ) : null}
        {service.runtime.ok && service.sync?.needed ? <SyncNeededNotice id={service.id} name={service.name} message={service.sync.message} /> : null}
        {/* Without a runtime the warnings repeat the notice above. */}
        {(service.runtime.ok ? service.warnings : []).map((warning) => (
          <Notice key={warning} tone="warn">{warning}</Notice>
        ))}
        {error ? (
          <Notice tone="error">
            {error.message}
            {error.hint ? ` ${error.hint}` : ""}
          </Notice>
        ) : null}
        <OpProgress op={op} />
        <div className="flex flex-wrap gap-2">
          {!service.installed ? (
            <Button variant="primary" disabled={running || !service.runtime.ok} onClick={() => void sidecar.act({ action: "install" })}>
              {t("Install {shortName}", { shortName: service.shortName })}
            </Button>
          ) : (
            <>
              {service.container.state === "running" ? (
                <Button disabled={running} onClick={() => void sidecar.act({ action: "stop" })}>{t("Stop")}</Button>
              ) : (
                <Button variant="primary" disabled={running} onClick={() => void sidecar.act({ action: "start" })}>{t("Start")}</Button>
              )}
              {!compact ? <Button disabled={running} onClick={() => void sidecar.act({ action: "update" })}>{service.updateAvailable ? t("Update (new version)") : t("Update")}</Button> : null}
              {!compact ? <Button variant="ghost" disabled={running} onClick={() => void sidecar.refresh(true)}>{t("Refresh (with memory)")}</Button> : null}
            </>
          )}
          {!compact && service.installed ? <RemoveControls sidecar={sidecar} /> : null}
        </div>
        {!service.installed ? (
          <p className="text-xs text-faint [overflow-wrap:anywhere]">
            {t("Downloads {image} (about {diskGb} GB on disk, {ramGb} GB RAM recommended), runs it with docker compose as project samurai-knife-{id}, bound to this machine's app address only. Licence {license}.", { image: service.image, diskGb: service.requirements.diskGb, ramGb: service.requirements.ramGb, id: service.id, license: service.license })}
          </p>
        ) : null}
        {!compact && state ? (
          <KeyValues
            rows={[
              ["Image", state.image],
              ["Address", service.publicUrl ?? "—"],
              ...(service.callsBack ? [[t("App URL"), `${service.appUrl.url} (${service.appUrl.source})`] as [string, string]] : []),
              ["Container", `${service.container.state}${service.container.status ? `, ${service.container.status}` : ""}`],
              ["Autostart", state.autostart ? (state.heldStopped ? "on, held: stopped by an administrator (Start resumes it)" : "on") : "off"],
              [t("Idle stop"), state.autostart ? "never (autostart)" : state.idleStopMinutes ? `after ${state.idleStopMinutes} min without use` : "never"],
              [t("Last start"), state.lastStartMs ? `${(state.lastStartMs / 1000).toFixed(1)} s to healthy` : "—"],
              ["Memory", service.memory ? service.memory.text : t("Refresh (with memory) to measure")],
              [t("Open sessions"), String(service.openSessions)],
              ["Runtime", service.runtime.ok ? `${service.runtime.kind} ${service.runtime.engineVersion}, compose ${service.runtime.composeVersion}` : "—"],
            ]}
          />
        ) : null}
        {!compact && service.installed ? <Settings key={state?.updatedAt} sidecar={sidecar} service={service} /> : null}
      </div>
    </Panel>
  );
}
