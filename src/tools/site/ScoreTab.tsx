"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, EmptyState, Field, KeyValues, Notice, Panel, Select, Stat, StatGrid, TextInput } from "@/components/ui";
import { openAssistant } from "@/lib/agent-client/bridge";
import type { Issue } from "@/lib/site/audit/types";
import { errorText, SCORE_LABELS, siteRequest, when, type AuditProgressView, type AuditRun, type ChangesView } from "./client";
import { useSite } from "./useSite";
import { useT } from "@/lib/i18n/react";

const SEVERITY_TONE = { high: "danger", medium: "warn", low: "neutral" } as const;
const CATEGORY_LABEL: Record<Issue["category"], string> = {
  seo: "SEO", content: "Content", copy: "Copy", accessibility: "Accessibility", security: "Security", performance: "Performance", alignment: "CV fit", lighthouse: "Lighthouse",
};

function delta(now: number | undefined, before: number | undefined): string {
  if (now === undefined || before === undefined || now === before) return "";
  return now > before ? ` ▲${now - before}` : ` ▼${before - now}`;
}

/** Score tab: run an audit, see scores (with the change since the previous run), issues, Lighthouse, history. */
export default function ScoreTab() {
  const { t, m } = useT();
  const { view, error } = useSite();
  const [target, setTarget] = useState<"production" | "preview" | "custom">("production");
  const [customUrl, setCustomUrl] = useState("");
  const [lighthouse, setLighthouse] = useState(true);
  const [progress, setProgress] = useState<AuditProgressView | null>(null);
  const [runs, setRuns] = useState<Record<string, AuditRun>>({});
  const [preview, setPreview] = useState<{ branch: string; url: string }>({ branch: "", url: "" });
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState<"all" | Issue["category"]>("all");
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const latestId = view?.latest?.id ?? "";
  const previousId = view?.history[1]?.id ?? "";
  const run = runs[latestId] ?? null;
  const previous = runs[previousId] ?? null;

  useEffect(() => {
    let alive = true;
    for (const id of [latestId, previousId]) {
      if (!id) continue;
      siteRequest<AuditRun>("GET", `/api/site/audit?run=${id}`).then((r) => alive && setRuns((all) => ({ ...all, [r.id]: r }))).catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [latestId, previousId]);

  // A preview exists while there is a work branch with a deployment; look it up once per work branch.
  const branch = view?.work?.branch ?? "";
  const previewUrl = preview.branch === branch ? preview.url : "";
  useEffect(() => {
    if (!branch) return;
    let alive = true;
    siteRequest<ChangesView>("GET", "/api/site/changes").then((c) => alive && setPreview({ branch, url: c.checks?.previewUrl ?? "" })).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [branch]);

  // An audit started elsewhere (the assistant, MCP) shows its progress here too.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const p = await siteRequest<AuditProgressView>("GET", "/api/site/audit");
        if (alive) setProgress(p.running ? p : null);
      } catch {
        /* next tick */
      }
    };
    void poll();
    timer.current = setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, 1500);
    return () => {
      alive = false;
      clearInterval(timer.current);
    };
  }, []);

  async function start() {
    setMessage("");
    const url = target === "custom" ? customUrl.trim() : target === "preview" ? previewUrl : undefined;
    if (target === "custom" && !url) {
      setMessage(t("Enter the URL to audit."));
      return;
    }
    try {
      const { id } = await siteRequest<{ id: string }>("POST", "/api/site/audit", { target, ...(url ? { url } : {}), lighthouse });
      setProgress({ running: true, id, phase: "Starting", done: 0, total: 1 });
    } catch (e) {
      setMessage(errorText(e));
    }
  }

  const issues = useMemo(() => (run ? run.issues.filter((i) => category === "all" || i.category === category) : []), [run, category]);
  const categories = useMemo(() => (run ? [...new Set(run.issues.map((i) => i.category))] : []), [run]);

  if (view && !view.connected && !view.latest) {
    return (
      <EmptyState title={t("Connect your website first")} action={<Link className="text-accent underline" href="/tools/site-studio?tab=connect">{t("Open Connect")}</Link>}>
        {t("The studio needs the repository and the production URL. (A one-off audit of any URL works too once connected.)")}
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Panel title={t("Audit")}>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t("What to audit")} className="w-56">
            <Select value={target} onChange={(e) => setTarget(e.target.value as typeof target)}>
              <option value="production">{t("Production (")}{view?.connection?.productionUrl || t("not set")})</option>
              <option value="preview" disabled={!previewUrl}>{t("Preview of the changes")}{previewUrl ? "" : t(" (none yet)")}</option>
              <option value="custom">{t("Another URL…")}</option>
            </Select>
          </Field>
          {target === "custom" ? (
            <Field label="URL" className="min-w-64 flex-1">
              <TextInput value={customUrl} onChange={(e) => setCustomUrl(e.target.value)} placeholder={t("https://…")} inputMode="url" />
            </Field>
          ) : null}
          <label className="flex h-10 items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={lighthouse} onChange={(e) => setLighthouse(e.target.checked)} /> {" "}{t("Lighthouse (PageSpeed, ~30-60 s)")}
          </label>
          <Button variant="primary" onClick={() => void start()} disabled={!!progress}>{t("Run audit")}</Button>
        </div>
        {progress ? (
          <p role="status" className="mt-3 text-sm text-muted">
            {t("Auditing… {phase} ({value}/{value2})", { phase: progress.phase, value: progress.done ?? 0, value2: progress.total ?? 1 })}
          </p>
        ) : null}
        {message ? <div className="mt-3"><Notice tone="error">{message}</Notice></div> : null}
      </Panel>

      {run ? (
        <>
          <Panel title={t("Scores · {finishedAt} · {target} · {baseUrl}", { finishedAt: when(run.finishedAt), target: run.target, baseUrl: run.baseUrl })}>
            <StatGrid aria-label={t("Scores")}>
              {SCORE_LABELS.filter(([k]) => run.scores[k] !== undefined).map(([k, label]) => (
                <Stat key={k} label={label} value={`${run.scores[k]}${delta(run.scores[k], previous?.scores[k])}`} />
              ))}
            </StatGrid>
            {run.notes.length ? <ul className="mt-3 list-disc pl-5 text-xs text-faint">{run.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => openAssistant(t("Look at the latest website audit (knife_site_audit_get) and propose the 5 changes with the biggest effect on my scores. Then make them on the work branch and open a pull request."))}>{t("Ask the assistant to improve it")}</Button>
            </div>
          </Panel>

          <Panel
            title={t("Issues ({issues})", { issues: run.issues.length })}
            right={
              <Select aria-label={t("Filter issues")} className="h-8 w-40" value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
                <option value="all">{t("All categories")}</option>
                {categories.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
              </Select>
            }
          >
            {issues.length ? (
              <ul className="divide-y divide-line">
                {issues.map((i, n) => (
                  <li key={`${i.id}-${i.page}-${n}`} className="py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={SEVERITY_TONE[i.severity]}>{i.severity}</Badge>
                      <Badge>{CATEGORY_LABEL[i.category]}</Badge>
                      <span className="text-sm font-medium text-ink">{m(i.title)}</span>
                    </div>
                    {i.detail ? <p className="mt-1 text-xs text-muted wrap-anywhere">{m(i.detail)}</p> : null}
                    <p className="mt-1 text-xs text-faint">
                      {i.page ? <span className="font-mono">{i.page.replace(/^https?:\/\//, "")}</span> : t("whole site")} {" "}{t("· Fix:")}{" "}{m(i.fix)}{" "}
                      <button type="button" className="text-accent underline" onClick={() => openAssistant(t("Fix this website issue on the work branch, then open or update the pull request: \"{title}\" ({value}). {detail} Suggested fix: {fix}", { title: i.title, value: i.page || "whole site", detail: i.detail, fix: i.fix }))}>
                        {t("Ask the assistant")}
                      </button>
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">{t("No issues in this category.")}</p>
            )}
          </Panel>

          {run.lighthouse.length ? (
            <Panel title={t("Lighthouse (PageSpeed Insights)")}>
              <div className="grid gap-4 md:grid-cols-2">
                {run.lighthouse.map((l) => (
                  <div key={l.strategy} className="space-y-2">
                    <h3 className="text-sm font-semibold capitalize text-ink">{l.strategy}</h3>
                    {l.ok ? (
                      <>
                        <StatGrid>
                          {Object.entries(l.scores).map(([k, v]) => <Stat key={k} label={k.replace("-", " ")} value={v} />)}
                        </StatGrid>
                        <p className="text-xs text-muted">{Object.entries(l.metrics).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(" · ")}</p>
                        <ul className="list-disc pl-5 text-xs text-muted">
                          {l.failing.slice(0, 8).map((f) => <li key={f.id}>{f.title}{f.display ? ` (${f.display})` : ""}</li>)}
                        </ul>
                      </>
                    ) : (
                      <Notice tone="warn">{l.error}</Notice>
                    )}
                  </div>
                ))}
              </div>
            </Panel>
          ) : null}

          {run.site ? (
            <Panel title={t("Site checks")}>
              <KeyValues
                rows={[
                  ["robots.txt", run.site.robots.status === 200 ? `found${run.site.robots.blocksAll ? ", blocks every crawler" : ""}` : `HTTP ${run.site.robots.status || "none"}`],
                  ["Sitemap", run.site.sitemap.status === 200 ? `${run.site.sitemap.urls} URL(s)` : `HTTP ${run.site.sitemap.status || "none"}`],
                  ["http → https", run.site.httpsRedirect === null ? "not checked" : run.site.httpsRedirect ? "redirects" : "does not redirect"],
                  [t("Unknown URL"), run.site.notFoundStatus === 404 ? "404 (good)" : `HTTP ${run.site.notFoundStatus}`],
                  [t("Security headers"), Object.entries(run.site.securityHeaders).map(([h, ok]) => `${ok ? "✓" : "✗"} ${h}`).join("  ")],
                ]}
              />
            </Panel>
          ) : null}

          {view && view.history.length > 1 ? (
            <Panel title={t("History")}>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-faint">
                    <tr>
                      <th className="py-1 pr-3">{t("When")}</th>
                      <th className="py-1 pr-3">{t("Target")}</th>
                      {SCORE_LABELS.slice(0, 6).map(([k, label]) => <th key={k} className="py-1 pr-3 text-right">{label}</th>)}
                      <th className="py-1 text-right">{t("High issues")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.history.map((h) => (
                      <tr key={h.id} className="border-t border-line">
                        <td className="py-1 pr-3 font-mono text-xs">{when(h.finishedAt)}</td>
                        <td className="py-1 pr-3">{h.target}</td>
                        {SCORE_LABELS.slice(0, 6).map(([k]) => <td key={k} className="py-1 pr-3 text-right tabular-nums">{h.scores[k] ?? "–"}</td>)}
                        <td className="py-1 text-right tabular-nums">{h.issues.high}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : null}
        </>
      ) : view?.connected && !progress ? (
        <EmptyState title={t("No audit yet")}>{t("Run the first one above: it takes about a minute with Lighthouse.")}</EmptyState>
      ) : null}
    </div>
  );
}
