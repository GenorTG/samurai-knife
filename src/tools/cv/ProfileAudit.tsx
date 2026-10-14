"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Notice, Panel } from "@/components/ui";
import { errorText, getAudit, isUnavailable, type AuditResult } from "@/lib/cv/client";
import { labelForPath } from "@/lib/cv/diff";
import type { CvLang, Profile } from "@/lib/cv/schema";
import { SeverityBadge } from "./shared";

export interface AuditState {
  phase: "loading" | "ready" | "unavailable" | "error";
  result: AuditResult | null;
  error: string;
  rerun: () => void;
}

/** Runs GET /api/cv/audit?lang= whenever the language or the profile revision changes. */
export function useAudit(lang: CvLang, revision: number | null): AuditState {
  const [state, setState] = useState<Omit<AuditState, "rerun">>({ phase: "loading", result: null, error: "" });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (revision === null) return;
    let live = true;
    getAudit(lang).then(
      (result) => live && setState({ phase: "ready", result, error: "" }),
      (error: unknown) => live && setState({ phase: isUnavailable(error) ? "unavailable" : "error", result: null, error: errorText(error) }),
    );
    return () => {
      live = false;
    };
  }, [lang, revision, nonce]);
  const rerun = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, rerun };
}

const SHOWN = 10;

export function AuditPanel({ audit, profile, lang, onGo }: { audit: AuditState; profile: Profile; lang: CvLang; onGo: (path: string) => void }) {
  const [all, setAll] = useState(false);
  const result = audit.result;
  const paths = result ? Object.keys(result.findings).filter((p) => result.findings[p].length > 0) : [];
  const total = paths.reduce((n, p) => n + (result?.findings[p].length ?? 0), 0);
  const visible = all ? paths : paths.slice(0, SHOWN);

  return (
    <Panel
      title={`Audit (${lang.toUpperCase()})`}
      right={<Button size="sm" onClick={audit.rerun} disabled={audit.phase === "loading"}>Re-run audit</Button>}
    >
      <div className="space-y-3" data-agent-region="cv-audit">
        {audit.phase === "loading" ? <p role="status" className="text-sm text-muted">Checking the profile…</p> : null}
        {audit.phase === "unavailable" ? <Notice>The audit is not available yet on this server.</Notice> : null}
        {audit.phase === "error" ? <Notice tone="error">Audit failed: {audit.error}</Notice> : null}
        {result ? (
          <>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(result.counts).map(([key, n]) => <Badge key={key} tone={/err|high/i.test(key) && n > 0 ? "danger" : n > 0 ? "warn" : "good"}>{key}: {n}</Badge>)}
              {total === 0 ? <Badge tone="good">No findings</Badge> : null}
            </div>
            {Object.keys(result.byRule).length > 0 ? (
              <p className="text-xs leading-relaxed text-muted">
                {Object.entries(result.byRule).filter(([, n]) => n > 0).map(([rule, n]) => `${rule} ×${n}`).join(" · ")}
              </p>
            ) : null}
            <ul className="space-y-2.5">
              {visible.map((path) => (
                <li key={path} className="rounded-lg border border-line bg-raised/40 p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 text-xs font-medium text-ink wrap-anywhere">{labelForPath(profile, path)}</span>
                    <Button size="sm" variant="ghost" aria-label={`Go to ${labelForPath(profile, path)}`} onClick={() => onGo(path)}>Go to field</Button>
                  </div>
                  <ul className="mt-1.5 space-y-1.5">
                    {result.findings[path].map((f, i) => (
                      <li key={`${f.rule}-${i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted">
                        <SeverityBadge severity={f.severity} />
                        <Badge>{f.rule}</Badge>
                        <span className="min-w-0 flex-1 basis-40 wrap-anywhere">{f.message}{f.fix ? <> <b className="font-semibold text-ink">Tip:</b> {f.fix}</> : null}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            {paths.length > SHOWN ? (
              <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${paths.length} fields`}</Button>
            ) : null}
          </>
        ) : null}
      </div>
    </Panel>
  );
}
