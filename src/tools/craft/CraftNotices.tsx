"use client";

import { useEffect, useState } from "react";
import { Notice } from "@/components/ui";
import type { SidecarSite } from "@/lib/services/definitions";
import { errorText, getCraftNotices, type AppNotices } from "@/tools/sidecars/client";
import { useT } from "@/lib/i18n/react";

/**
 * The active Craft release's licence and notice texts, exposed from the central /credits page.
 */
export function CraftNotices({ app }: { app: SidecarSite }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [notices, setNotices] = useState<AppNotices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!open || notices) return;
    let cancelled = false;
    getCraftNotices(app.id).then(
      (value) => {
        if (!cancelled) setNotices(value);
      },
      (err) => {
        if (!cancelled) setError(errorText(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, notices, app.id, retry]);

  return (
    <details
      className="rounded-tool border border-line bg-surface p-4"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer font-semibold text-ink">
        {t("{name} · bundled licence texts", { name: app.name })}
        {notices ? <span className="ml-2 text-sm font-normal text-muted">{t("version")}{" "} {notices.version}</span> : null}
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm text-muted">
          {t("{name} is made by the ArtCraft team and contributors and licensed {license} (either licence, at your option). This site serves the official, unmodified web build; it is not affiliated with or endorsed by the ArtCraft team.", { name: app.name, license: app.license })}
        </p>
        <p className="text-sm">
          <a className="text-accent-soft underline underline-offset-2" href={app.repo} target="_blank" rel="noopener noreferrer">{t("Source code")}</a>
          {notices ? (
            <>
              {" · "}
              <a className="text-accent-soft underline underline-offset-2" href={notices.tagUrl} target="_blank" rel="noopener noreferrer">
                {t("version {version} source", { version: notices.version })}
              </a>
            </>
          ) : null}
        </p>
        {error ? (
          <div className="space-y-2">
            <Notice tone="error">{t("The notices could not be loaded:")}{" "} {error}</Notice>
            <button className="text-sm text-accent-soft underline underline-offset-2" type="button" onClick={() => { setError(null); setRetry((count) => count + 1); }}>
              {t("Retry loading notices")}
            </button>
          </div>
        ) : null}
        {!notices && !error ? <p role="status" className="text-sm text-muted">{t("Loading licence and notice texts…")}</p> : null}
        {notices ? (
          <>
            <p className="text-sm text-ink">{notices.copyright}</p>
            {notices.missing.length ? (
              <Notice tone="info">
                {t("Not reachable right now: {value}. They are listed in the repository at version {version}.", { value: notices.missing.join(", "), version: notices.version })}
              </Notice>
            ) : null}
            {notices.absent.length ? (
              <p className="text-xs text-faint">{t("Named in the NOTICE but not in the repository at this version: {value}.", { value: notices.absent.join(", ") })}</p>
            ) : null}
            {notices.files.map((file) => (
              <details key={file.name} className="rounded-tool border border-line">
                <summary className="cursor-pointer px-3 py-2 text-sm text-ink">
                  {file.name}
                  <span className="ml-2 text-xs text-faint">{file.source === "release" ? t("in the release") : t("from the repository")}</span>
                </summary>
                <pre className="max-h-96 overflow-auto border-t border-line px-3 py-2 text-xs whitespace-pre-wrap text-muted">{file.text}</pre>
              </details>
            ))}
          </>
        ) : null}
      </div>
    </details>
  );
}
