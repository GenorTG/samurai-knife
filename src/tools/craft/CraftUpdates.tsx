"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Drawer, Notice, SegmentedControl } from "@/components/ui";
import { errorText, getCraftUpdates, postCraftUpdates, type CraftUpdateAction, type CraftUpdatesView } from "@/tools/sidecars/client";

const MODES = [
  { value: "auto", label: "Automatic" },
  { value: "notify", label: "Notify only" },
  { value: "off", label: "Off" },
] as const;

/** UTC, pinned format: never locale-dependent output (AGENTS.md hydration rule; this drawer is client-only anyway). */
function when(iso: string | null): string {
  return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "never";
}

/**
 * Admin view of the Craft apps update channel (GET/POST /api/craft/updates, src/lib/craft/updates.ts): mode, last check,
 * per app the served/available/previous versions with Update, Roll back and Hold.
 */
export function CraftUpdates({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged?: () => void }) {
  const [view, setView] = useState<CraftUpdatesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = () =>
      getCraftUpdates().then(
        (value) => {
          if (cancelled) return;
          setView(value);
          setError(null);
        },
        (err) => {
          if (!cancelled) setError(errorText(err));
        },
      );
    void load();
    // While a background check runs, poll its outcome.
    const timer = setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open]);

  const act = async (key: string, body: CraftUpdateAction) => {
    setBusy(key);
    setError(null);
    try {
      const answer = await postCraftUpdates(body);
      setView("view" in answer ? answer.view : answer);
      onChanged?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const checking = Boolean(view?.running) || busy === "check";
  return (
    <Drawer open={open} title="Craft apps updates" onClose={onClose}>
      <p className="text-sm text-muted">
        New releases come from each app&apos;s GitHub releases, checked once a day. A download must match the sha256 GitHub publishes for it; the previous
        version stays for a one-click roll back. Updates need no restart and no host command.
      </p>
      {view ? (
        <>
          <SegmentedControl
            label="Update mode"
            value={view.mode}
            options={MODES.map((mode) => ({ value: mode.value, label: mode.label }))}
            onChange={(mode) => void act("mode", { action: "mode", mode })}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={checking} onClick={() => void act("check", { action: "check" })}>
              Check now
            </Button>
            <Button size="sm" variant="primary" disabled={checking} onClick={() => void act("check", { action: "check", apply: true })}>
              Check and update all
            </Button>
            <p role="status" className="text-xs text-faint">
              {checking ? "Checking the releases…" : `Last check: ${when(view.checkedAt)}`}
            </p>
          </div>
          {view.error ? <Notice tone="error">{view.error}</Notice> : null}
        </>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!view && !error ? (
        <p role="status" className="text-sm text-muted">
          Loading…
        </p>
      ) : null}
      {view ? (
        <ul className="divide-y divide-line rounded-tool border border-line" aria-label="Apps">
          {view.apps.map((app) => (
            <li key={app.id} className="space-y-1.5 px-3 py-2.5" data-craft-update={app.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink">{app.name}</span>
                <span className="text-sm text-muted">{app.active}</span>
                {app.available ? <Badge tone="accent">{app.available} available</Badge> : null}
                {app.hold ? <Badge>held</Badge> : null}
                {app.served && app.served !== app.active ? <Badge tone="warn">serving {app.served}</Badge> : null}
              </div>
              <p className="text-xs text-faint">
                Minimum {app.minimum}
                {app.previous ? ` · previous ${app.previous}` : ""}
                {app.changedAt ? ` · ${app.change ?? "changed"} ${when(app.changedAt)}` : ""}
                {app.knownBad.length ? ` · never installed: ${app.knownBad.join(", ")}` : ""}
              </p>
              {app.error ? <p className="text-xs text-danger">{app.error}</p> : null}
              <div className="flex flex-wrap gap-2">
                {app.available ? (
                  <Button size="sm" disabled={busy !== null || checking} onClick={() => void act(`apply:${app.id}`, { action: "apply", app: app.id })}>
                    {busy === `apply:${app.id}` ? "Updating…" : `Update to ${app.available}`}
                  </Button>
                ) : null}
                {app.previous ? (
                  <Button size="sm" variant="ghost" disabled={busy !== null || checking} onClick={() => void act(`rollback:${app.id}`, { action: "rollback", app: app.id })}>
                    {busy === `rollback:${app.id}` ? "Rolling back…" : `Roll back to ${app.previous}`}
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act(`hold:${app.id}`, { action: "hold", app: app.id, hold: !app.hold })}>
                  {app.hold ? "Release hold" : "Hold this version"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </Drawer>
  );
}
