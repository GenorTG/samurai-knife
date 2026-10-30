"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/react";
import { unseen, type SeenState } from "@/lib/release-notes";

/** Pages that are read before or instead of the app: no window over them. */
const QUIET = /^\/(?:privacy|terms|changelog|login|register|verify|reset|forgot|credits)(?:\/|$)/;

type Shown = NonNullable<ReturnType<typeof unseen>> & { version: string };

/**
 * "What's new in Smart Knife <version>": once per release (MAJOR.MINOR.PATCH) for each account, on the first page
 * load after an update (also the reload the UpdateBanner asks for), in plain words (src/lib/release-notes.ts), plus a
 * short note when the Terms / privacy notice edition changed. "Got it" and "See all changes" record it (PUT
 * /api/account/seen). Shell chrome: outside <main>, never in agent snapshots.
 */
export function WhatsNewModal() {
  const { t } = useT();
  const pathname = usePathname() ?? "/";
  const [shown, setShown] = useState<Shown | null>(null);
  const quiet = QUIET.test(pathname);

  useEffect(() => {
    if (quiet) return;
    let stopped = false;
    void (async () => {
      try {
        const response = await fetch("/api/account/seen", { cache: "no-store" });
        const data = (await response.json()) as { seen?: SeenState | null; current?: { version: string; legalEdition: number | null } };
        if (stopped || !response.ok || !data.current) return;
        const next = unseen(data.seen ?? null, data.current);
        if (next) setShown({ ...next, version: data.current.version });
      } catch {
        /* offline or signed out: nothing to show */
      }
    })();
    return () => {
      stopped = true;
    };
    // Once per page load: a client-side navigation does not ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!shown || quiet) return null;
  const done = async (then?: string) => {
    setShown(null);
    try {
      await fetch("/api/account/seen", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
    } catch {
      /* shown again next time */
    }
    if (then) window.location.assign(then);
  };
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" data-whats-new>
      <div className="sk-scrim absolute inset-0 backdrop-blur-sm" aria-hidden onMouseDown={() => void done()} />
      <div role="dialog" aria-modal="true" aria-labelledby="whats-new-title" className="relative max-h-[85vh] w-[min(36rem,100%)] overflow-y-auto rounded-xl border border-line-strong bg-surface p-5 text-sm text-ink shadow-pop">
        <h2 id="whats-new-title" className="text-lg font-semibold">{t("What's new in Smart Knife {version}", { version: shown.version })}</h2>
        {shown.notes.map((note) => (
          <div key={note.version} className="mt-3 space-y-2">
            {shown.notes.length > 1 ? <h3 className="text-sm font-semibold text-muted">{note.version}</h3> : null}
            {note.features.length ? (
              <>
                <h4 className="sk-label">{t("New")}</h4>
                <ul className="list-disc space-y-1 pl-5 text-muted">{note.features.map((item) => <li key={item}>{t(item)}</li>)}</ul>
              </>
            ) : null}
            {note.fixes.length ? (
              <>
                <h4 className="sk-label">{t("Fixed")}</h4>
                <ul className="list-disc space-y-1 pl-5 text-muted">{note.fixes.map((item) => <li key={item}>{t(item)}</li>)}</ul>
              </>
            ) : null}
          </div>
        ))}
        {shown.legal.length ? (
          <div className="mt-4 rounded-lg border border-line bg-raised/50 p-3" data-whats-new-legal>
            <h3 className="font-semibold">{t("Privacy and terms changes")}</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-muted">{shown.legal.map((l) => <li key={l.edition}>{t(l.summary)}</li>)}</ul>
            <p className="mt-2 text-xs text-muted">
              <a className="underline" href="/privacy">{t("Privacy notice")}</a> · <a className="underline" href="/terms">{t("Terms of Service")}</a>
            </p>
          </div>
        ) : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" autoComplete="off" className="rounded-lg border border-line-strong px-3 py-1.5 hover:bg-raised" onClick={() => void done("/changelog")}>{t("See all changes")}</button>
          <button type="button" autoComplete="off" autoFocus className="rounded-lg bg-accent px-3 py-1.5 font-semibold text-accent-fg" onClick={() => void done()}>{t("Got it")}</button>
        </div>
      </div>
    </div>
  );
}
