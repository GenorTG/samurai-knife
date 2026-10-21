"use client";

import { useEffect, useState } from "react";
import { Drawer, Notice } from "@/components/ui";
import type { SidecarSite } from "@/lib/services/definitions";
import { errorText, getCraftNotices, type AppNotices } from "@/tools/sidecars/client";

/**
 * "Licences & notices" for one Craft app: copyright, licence, the release's LICENSE files and the repository's NOTICE
 * with the third-party licence files it names (GET /api/craft/notices, src/lib/craft/notices.ts).
 */
export function CraftNotices({ app, open, onClose }: { app: SidecarSite; open: boolean; onClose: () => void }) {
  const [notices, setNotices] = useState<AppNotices | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  }, [open, notices, app.id]);

  return (
    <Drawer open={open} title={`${app.name}: licences & notices`} onClose={onClose}>
      <div className="space-y-1 text-sm text-muted">
        <p>
          {app.name} is made by the ArtCraft team and contributors and licensed {app.license} (either licence, at your option). This site serves the
          official, unmodified web build; it is not affiliated with or endorsed by the ArtCraft team.
        </p>
        <p>
          <a className="underline underline-offset-2 hover:text-ink" href={app.repo} target="_blank" rel="noopener noreferrer">
            Source code
          </a>
          {notices ? (
            <>
              {" · "}
              <a className="underline underline-offset-2 hover:text-ink" href={notices.tagUrl} target="_blank" rel="noopener noreferrer">
                version {notices.version}
              </a>
            </>
          ) : null}
        </p>
      </div>
      {error ? <Notice tone="error">The notices could not be loaded: {error}</Notice> : null}
      {!notices && !error ? (
        <p role="status" className="text-sm text-muted">
          Loading the notices…
        </p>
      ) : null}
      {notices ? (
        <>
          <p className="text-sm text-ink">{notices.copyright}</p>
          {notices.missing.length ? (
            <Notice tone="info">
              Not reachable right now: {notices.missing.join(", ")}. They are in the repository at version {notices.version}.
            </Notice>
          ) : null}
          {notices.absent.length ? (
            <p className="text-xs text-faint">Named in the NOTICE but not in the repository at this version: {notices.absent.join(", ")}.</p>
          ) : null}
          {notices.files.map((file) => (
            <details key={file.name} className="rounded-tool border border-line">
              <summary className="cursor-pointer px-3 py-2 text-sm text-ink">
                {file.name}
                <span className="ml-2 text-xs text-faint">{file.source === "release" ? "in the release" : "from the repository"}</span>
              </summary>
              <pre className="max-h-96 overflow-auto border-t border-line px-3 py-2 text-xs whitespace-pre-wrap text-muted">{file.text}</pre>
            </details>
          ))}
        </>
      ) : null}
    </Drawer>
  );
}
