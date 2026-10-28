"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Notice, Panel } from "@/components/ui";
import { errorText, siteRequest, when, type VercelPreviewsView } from "./client";
import { useT } from "@/lib/i18n/react";

const POLL_MS = 15_000;
const STATE_TONE: Record<string, "good" | "warn" | "danger" | "neutral"> = { READY: "good", BUILDING: "warn", QUEUED: "warn", INITIALIZING: "warn", ERROR: "danger", CANCELED: "neutral", BLOCKED: "danger" };

/**
 * Changes tab, Vercel linked: the deployments Vercel built for the work branch, the one from its head commit, and a
 * button to build a preview of that commit (the same action as the assistant's knife_site_deploy; never production).
 */
export default function VercelPreviews({ revision, onScore }: { revision: number; onScore: (url: string) => void }) {
  const { t } = useT();
  const [data, setData] = useState<VercelPreviewsView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "good" | "error"; text: string } | null>(null);

  const load = useCallback(() => {
    return siteRequest<{ previews?: VercelPreviewsView }>("GET", "/api/site/vercel?previews=1").then(
      (d) => {
        setData(d.previews ?? null);
        setError("");
      },
      (e: unknown) => setError(errorText(e)),
    );
  }, []);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void load();
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load, revision]);

  async function deploy(force: boolean) {
    setBusy(true);
    setNotice(null);
    try {
      const r = await siteRequest<{ created: boolean }>("POST", "/api/site/vercel", { action: "deploy", force });
      setNotice({ tone: "good", text: r.created ? t("Preview build started on Vercel.") : t("Vercel already has this commit: no new build started.") });
      await load();
    } catch (e) {
      setNotice({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const head = data?.headDeployment ?? null;
  return (
    <Panel title={t("Vercel previews")}>
      <div className="space-y-3 text-sm">
        {error ? <Notice tone="error">{error}</Notice> : null}
        {!data && !error ? <p className="text-muted">{t("Loading Vercel deployments…")}</p> : null}
        {data ? (
          <>
            <p className="text-muted">
              {t("Project")} <b>{data.project.name}</b>
              {data.branch ? <> · {t("branch")} <code>{data.branch}</code>{data.head ? <> @ <code>{data.head.slice(0, 7)}</code></> : null}</> : null}
              {data.protectedPreviews ? <> · {data.canReadProtected ? t("protected previews, bypass stored") : t("protected previews, no bypass secret")}</> : null}
            </p>
            {head ? (
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={STATE_TONE[head.state] ?? "neutral"}>{head.state}</Badge>
                <a className="text-accent underline wrap-anywhere" href={head.url} target="_blank" rel="noreferrer">{head.url}</a>
                {head.inspectorUrl ? <a className="text-muted underline" href={head.inspectorUrl} target="_blank" rel="noreferrer">{t("Build details")}</a> : null}
                {head.state === "READY" ? <Button size="sm" onClick={() => onScore(head.url)}>{t("Score the preview")}</Button> : null}
              </div>
            ) : (
              <p className="text-muted">{data.branch ? t("No deployment of the head commit yet.") : t("No work branch yet.")}</p>
            )}
            {head?.error ? <Notice tone="error">{head.error}</Notice> : null}
            {data.branch ? (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void deploy(false)} disabled={busy || (!!head && head.state !== "ERROR" && head.state !== "CANCELED")}>{t("Build preview")}</Button>
                {head && (head.state === "ERROR" || head.state === "READY") ? <Button variant="ghost" onClick={() => void deploy(true)} disabled={busy}>{t("Rebuild")}</Button> : null}
              </div>
            ) : null}
            {data.deployments.length > 1 ? (
              <details>
                <summary className="cursor-pointer text-ink">{t("Earlier deployments ({count})", { count: data.deployments.length })}</summary>
                <ul className="mt-2 space-y-1">
                  {data.deployments.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center gap-2">
                      <Badge tone={STATE_TONE[d.state] ?? "neutral"}>{d.state}</Badge>
                      <code>{d.sha.slice(0, 7)}</code>
                      <span className="text-muted">{when(d.createdAt)}</span>
                      <a className="text-accent underline wrap-anywhere" href={d.url} target="_blank" rel="noreferrer">{d.url}</a>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        ) : null}
        {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      </div>
    </Panel>
  );
}
