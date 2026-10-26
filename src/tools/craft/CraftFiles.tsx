"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Drawer, Notice } from "@/components/ui";
import { accepts } from "@/lib/craft/accept";
import { formatBytes } from "@/lib/format";
import { ARTCRAFT_APPS } from "@/lib/services/definitions";
import { craftFileBytes, craftFileDownloadUrl, deleteCraftFile, errorText, listCraftFiles, type CraftFile, type CraftFilesList } from "@/tools/sidecars/client";
import type { OpenRequest, PickedFile } from "./useCraftBridge";
import { useT } from "@/lib/i18n/react";
import type { Translator } from "@/lib/i18n/core";

const appName = (id: string) => ARTCRAFT_APPS.find((app) => app.id === id)?.name ?? id;
/** UTC, pinned format (never locale-dependent output). */
const when = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

function useFiles(open: boolean): { list: CraftFilesList | null; error: string | null; reload: () => void } {
  const [list, setList] = useState<CraftFilesList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listCraftFiles().then(
      (value) => {
        if (!cancelled) {
          setList(value);
          setError(null);
        }
      },
      (err) => {
        if (!cancelled) setError(errorText(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, tick]);
  return { list, error, reload: () => setTick((value) => value + 1) };
}

function usageLine(list: CraftFilesList, { t, tn }: Translator): string {
  const total = list.files.reduce((sum, file) => sum + file.size, 0);
  const quota = list.usage.quotaBytes === null ? t("no storage limit") : t("{used} of your {quota} used in all", { used: formatBytes(list.usage.usedBytes), quota: formatBytes(list.usage.quotaBytes) });
  return `${tn("{n} file", "{n} files", list.files.length)}, ${formatBytes(total)} · ${quota}`;
}

/** "My files": everything the Craft apps saved to this account, with Download and Delete. */
export function CraftFilesDrawer({ open, onClose, highlight }: { open: boolean; onClose: () => void; highlight?: string | null }) {
  const i18n = useT();
  const { t } = i18n;
  const { list, error, reload } = useFiles(open);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Drawer open={open} title={t("Craft files")} onClose={onClose}>
      <p className="text-sm text-muted">
        {t("What you save in the Craft apps is kept in your account, so you can open it again on any browser or device. Download puts a copy on this computer.")}
      </p>
      {error || problem ? <Notice tone="error">{error ?? problem}</Notice> : null}
      {!list && !error ? (
        <p role="status" className="text-sm text-muted">
          {t("Loading…")}
        </p>
      ) : null}
      {list ? <p className="text-xs text-faint">{usageLine(list, i18n)}</p> : null}
      {list && list.files.length === 0 ? <p className="text-sm text-muted">{t("Nothing saved yet: use Save or Export in an app.")}</p> : null}
      {list && list.files.length ? (
        <ul className="divide-y divide-line rounded-tool border border-line" aria-label={t("Craft files")}>
          {list.files.map((file) => (
            <li key={file.id} className={`space-y-1 px-3 py-2.5 ${highlight === file.id ? "bg-raised" : ""}`} data-craft-file={file.name}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-medium break-all text-ink">{file.name}</span>
                <span className="text-xs text-faint">
                  {appName(file.app)} · {formatBytes(file.size)} · {when(file.updatedAt)}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <a className="inline-flex h-7 items-center rounded-lg border border-line-strong px-2.5 text-xs text-ink hover:bg-raised" href={craftFileDownloadUrl(file.id)} download={file.name}>
                  {t("Download")}
                </a>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy !== null}
                  onClick={async () => {
                    if (!window.confirm(t("Delete {name}? This cannot be undone.", { name: file.name }))) return;
                    setBusy(file.id);
                    setProblem(null);
                    try {
                      await deleteCraftFile(file.id);
                      reload();
                    } catch (err) {
                      setProblem(errorText(err));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === file.id ? t("Deleting…") : t("Delete")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </Drawer>
  );
}

/**
 * The app asked to open a file: Smart Knife's own chooser (the app cannot see or click it). The account's Craft files
 * that match the app's `accept`, or files from this computer (an input of this page: the person's click is here).
 */
export function CraftOpenChooser({ app, request, onPick, onCancel }: { app: string; request: OpenRequest | null; onPick: (files: PickedFile[]) => void; onCancel: () => void }) {
  const { t } = useT();
  const { list, error } = useFiles(request !== null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const local = useRef<HTMLInputElement>(null);
  const matching = list ? list.files.filter((file) => request && accepts(request.accept, file)) : [];
  const mine = matching.filter((file) => file.app === app);
  const others = matching.filter((file) => file.app !== app);
  const pick = async (file: CraftFile) => {
    setBusy(true);
    setProblem(null);
    try {
      const { bytes, mime } = await craftFileBytes(file.id);
      onPick([{ name: file.name, mime: mime || file.mime, bytes, lastModified: Date.parse(file.updatedAt) }]);
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const row = (file: CraftFile) => (
    <li key={file.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" data-craft-pick={file.name}>
      <span className="min-w-0 text-sm break-all text-ink">
        {file.name}
        <span className="ml-2 text-xs text-faint">
          {formatBytes(file.size)} · {when(file.updatedAt)}
        </span>
      </span>
      <Button size="sm" disabled={busy} onClick={() => void pick(file)}>
        {t("Open")}
      </Button>
    </li>
  );
  return (
    <Drawer open={request !== null} title={t("Open in {app}", { app: appName(app) })} onClose={onCancel}>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => local.current?.click()}>
          {t("From this computer…")}
        </Button>
        <input
          ref={local}
          type="file"
          className="hidden"
          accept={request?.accept || undefined}
          multiple={request?.multiple ?? false}
          onChange={async (event) => {
            const chosen = [...(event.target.files ?? [])];
            event.target.value = "";
            if (!chosen.length) return;
            setBusy(true);
            try {
              onPick(await Promise.all(chosen.map(async (file) => ({ name: file.name, mime: file.type, bytes: await file.arrayBuffer(), lastModified: file.lastModified }))));
            } finally {
              setBusy(false);
            }
          }}
        />
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("Cancel")}
        </Button>
      </div>
      {error || problem ? <Notice tone="error">{error ?? problem}</Notice> : null}
      {!list && !error ? (
        <p role="status" className="text-sm text-muted">
          {t("Loading your files…")}
        </p>
      ) : null}
      {list && !matching.length ? <p className="text-sm text-muted">{t("None of your Craft files fit what {app} opens here.", { app: appName(app) })}</p> : null}
      {mine.length ? (
        <section className="space-y-1">
          <h3 className="text-xs font-semibold text-muted">{t("Saved in")}{" "} {appName(app)}</h3>
          <ul className="divide-y divide-line rounded-tool border border-line">{mine.map(row)}</ul>
        </section>
      ) : null}
      {others.length ? (
        <section className="space-y-1">
          <h3 className="text-xs font-semibold text-muted">{t("From other Craft apps")}</h3>
          <ul className="divide-y divide-line rounded-tool border border-line">{others.map(row)}</ul>
        </section>
      ) : null}
    </Drawer>
  );
}
