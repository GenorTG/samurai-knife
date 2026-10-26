"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Field, NumberField, OutputBlock } from "@/components/ui";
import { formatBytes } from "@/lib/format";
import { docAction, errorText, getDocDetails, versionDownloadUrl, versionPreview, type DocMeta, type DocVersion } from "./client";
import { useT } from "@/lib/i18n/react";

/** Pinned, locale-free timestamp (no hydration/locale drift). */
export function when(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

const SOURCE: Record<string, string> = {
  blank: "created blank",
  upload: "uploaded",
  assistant: "made by the assistant",
  editor: "saved in the editor",
  restore: "restored",
  copy: "duplicated",
};

function describe(v: { source?: string; savedBy?: string; restoredFrom?: number }): string {
  const how = v.source ? SOURCE[v.source] ?? v.source : "saved";
  return `${how}${v.restoredFrom ? ` from v${v.restoredFrom}` : ""}${v.savedBy ? ` by ${v.savedBy}` : ""}`;
}

/**
 * Versions of one document: the current one and every kept earlier version (newest first) with preview (plain text, the
 * same extraction as the assistant's knife_doc_read), download and restore (= a new version, nothing lost), and prune.
 */
export function VersionsPanel({ doc, onChanged, onNotice }: { doc: DocMeta; onChanged: () => void; onNotice: (tone: "good" | "error", text: string) => void }) {
  const { t } = useT();
  const [versions, setVersions] = useState<DocVersion[] | null>(null);
  const [current, setCurrent] = useState<DocMeta>(doc);
  const [preview, setPreview] = useState<{ version: number; text: string; truncated: boolean } | null>(null);
  const [keep, setKeep] = useState(5);
  const [confirmPrune, setConfirmPrune] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    void getDocDetails(doc.id).then(
      (r) => {
        setCurrent(r.doc);
        setVersions([...r.versions].reverse());
      },
      (err) => onNotice("error", errorText(err)),
    );
  }, [doc.id, onNotice]);
  useEffect(load, [load, doc.version]);

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    try {
      onNotice("good", await fn());
      load();
      onChanged();
    } catch (err) {
      onNotice("error", errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const keptBytes = versions?.reduce((sum, v) => sum + v.bytes, 0) ?? 0;
  return (
    <div className="space-y-3" role="region" aria-label={t("Versions of {name}", { name: doc.name })}>
      {busy ? <p role="status" className="text-xs text-muted">{busy}…</p> : null}
      {versions === null ? (
        <p role="status" className="text-sm text-muted">{t("Loading versions…")}</p>
      ) : (
        <ol className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
            <span className="min-w-0">
              <span className="font-medium text-ink">v{current.version}</span> <Badge tone="accent">{t("current")}</Badge>{" "}
              <span className="font-mono text-xs text-muted">{formatBytes(current.bytes)} · {when(current.contentAt ?? current.updatedAt)} UTC · {describe({ source: current.versionSource, savedBy: current.lastSavedBy, restoredFrom: current.restoredFrom })}</span>
            </span>
          </li>
          {versions.map((v) => (
            <li key={v.version} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="font-medium text-ink">v{v.version}</span>{" "}
                <span className="font-mono text-xs text-muted">{v.format} · {formatBytes(v.bytes)} · {when(v.savedAt)} UTC · {describe(v)}</span>
              </span>
              <span className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" aria-label={t("Preview version {version} of {name}", { version: v.version, name: doc.name })} onClick={async () => {
                  try {
                    const r = await versionPreview(doc.id, v.version);
                    setPreview({ version: v.version, text: r.text, truncated: r.truncated });
                  } catch (err) {
                    onNotice("error", errorText(err));
                  }
                }}>{t("Preview")}</Button>
                <a className="inline-flex h-7 items-center rounded-lg border border-line-strong px-2.5 text-xs text-ink hover:bg-raised" href={versionDownloadUrl(doc.id, v.version)} aria-label={t("Download version {version} of {name}", { version: v.version, name: doc.name })}>
                  {t("Download")}
                </a>
                <Button size="sm" disabled={busy !== null} aria-label={t("Restore version {version} of {name}", { version: v.version, name: doc.name })} onClick={() => void run(t("Restoring version {version}", { version: v.version }), async () => {
                  const r = await docAction(doc.id, { action: "restore_version", version: v.version });
                  return t("Restored version {version} of {name} as version {version2}; the content it replaced is kept as version {value}.", { version: v.version, name: doc.name, version2: r.doc.version, value: r.doc.version - 1 });
                })}>{t("Restore")}</Button>
              </span>
            </li>
          ))}
          {versions.length === 0 ? <li className="px-3 py-2 text-sm text-muted">{t("No earlier versions yet: each save from the editor keeps the previous one here.")}</li> : null}
        </ol>
      )}
      {preview ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-faint">{t("Text of version")}{" "} {preview.version}{preview.truncated ? t(" (first 20,000 characters)") : ""}{t("; formatting and images are not shown.")}</p>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>{t("Close preview")}</Button>
          </div>
          <OutputBlock value={preview.text} rows={8} empty={t("(no text in this version)")} />
        </div>
      ) : null}
      {versions && versions.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t("Keep the newest")}>
            <NumberField aria-label={t("Versions to keep")} integer min={0} max={25} value={keep} onValueChange={setKeep} className="w-20" />
          </Field>
          {confirmPrune ? (
            <>
              <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => {
                setConfirmPrune(false);
                void run(t("Pruning versions"), async () => {
                  const r = await docAction(doc.id, { action: "prune_versions", keep });
                  return t("Removed {value} old version(s) of {name}, freed {formatBytes}.", { value: r.removed ?? 0, name: doc.name, formatBytes: formatBytes(r.freedBytes ?? 0) });
                });
              }}>{t("Confirm: delete older versions")}</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmPrune(false)}>{t("Keep them")}</Button>
            </>
          ) : (
            <Button size="sm" variant="danger" disabled={versions.length <= keep} onClick={() => setConfirmPrune(true)}>
              {t("Prune old versions")}
            </Button>
          )}
          <span className="text-xs text-faint">{versions.length} {" "}{t("kept ·")}{" "} {formatBytes(keptBytes)}</span>
        </div>
      ) : null}
    </div>
  );
}
