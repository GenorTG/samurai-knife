"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge, Button, EmptyState, Meter, Notice, Panel, Stat, StatGrid } from "@/components/ui";
import { openAssistant } from "@/lib/agent-client/bridge";
import type { AlignmentItem } from "@/lib/site/audit/types";
import { siteRequest, when, type AuditRun } from "./client";
import { useSite } from "./useSite";
import { useT } from "@/lib/i18n/react";
import { msg } from "@/lib/i18n/msg";

const KIND_LABEL: Record<AlignmentItem["kind"], string> = { name: msg("Name"), headline: msg("Headline"), role: msg("Current role"), project: msg("Projects"), skill: msg("Skills"), link: msg("Profile links"), projectLink: msg("Project links"), email: msg("Email") };
const DIMENSIONS: [keyof AuditRun["pages"][number]["copy"]["scores"], string, string][] = [
  ["hero", msg("First screen"), msg("H1 says who you are / what you offer, with a line under it")],
  ["cta", msg("Calls to action"), msg("Asks the visitor to contact you, with a direct channel")],
  ["proof", msg("Proof"), msg("Numbers, results, project links")],
  ["readability", msg("Readability"), msg("FOG-PL (Polish) or Flesch (English)")],
  ["sentences", msg("Sentence length"), msg("Share of long sentences")],
  ["focus", msg("Reader focus"), msg("Talks about the visitor's outcome, not only about you")],
  ["buzzwords", msg("No buzzwords"), msg("Empty words like innowacyjny / cutting-edge")],
  ["substance", msg("Substance"), msg("Enough text to say something")],
];

/**
 * Compare with your CV (a step of the CV studio's Website tab): how the site lines up with the CV project's profile, and
 * copywriting scores per page.
 */
export default function CopyTab() {
  const { t } = useT();
  const { view } = useSite();
  const [fetched, setFetched] = useState<AuditRun | null>(null);
  const latestId = view?.latest?.id ?? "";
  // The run belongs to the newest id; an older fetched one is simply not shown.
  const run = fetched && fetched.id === latestId ? fetched : null;
  useEffect(() => {
    if (!latestId) return;
    let alive = true;
    siteRequest<AuditRun>("GET", `/api/site/audit?run=${latestId}`).then((r) => alive && setFetched(r)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [latestId]);

  if (!view) return <p className="text-sm text-muted">{t("Loading…")}</p>;
  if (!view.connected && !view.siteUrl && !view.latest) {
    return (
      <EmptyState title={t("Connect your website to compare it with your CV")} action={<Link className="text-accent underline" href="/tools/cv-studio?tab=website&step=connect">{t("Add your website")}</Link>}>
        {t("Your personal or company site should tell the same story as your CV: current role, best projects, the skills you want to be hired for.")}
      </EmptyState>
    );
  }
  if (!run) {
    return (
      <EmptyState title={t("No audit yet")} action={<Link className="text-accent underline" href="/tools/cv-studio?tab=website&step=score">{t("Run a check")}</Link>}>
        {t("The copy and CV comparison come from the latest audit.")}
      </EmptyState>
    );
  }
  const a = run.alignment;
  const groups = a ? (Object.keys(KIND_LABEL) as AlignmentItem["kind"][]).map((k) => [k, a.items.filter((i) => i.kind === k)] as const).filter(([, items]) => items.length) : [];
  const missing = a ? a.items.filter((i) => !i.onSite) : [];

  return (
    <div className="space-y-4">
      <Notice tone="info">{t("From your website check of {finishedAt}. Edit the CV in the other tabs; run the check again after you change the site.", { finishedAt: when(run.finishedAt) })}</Notice>
      <Panel title={t("CV fit{value}", { value: a ? ` · ${a.score}/100` : "" })}>
        {a && a.items.length ? (
          <div className="space-y-3">
            <Meter value={a.score} label={t("How much of your CV the site shows")} />
            {groups.map(([kind, items]) => (
              <div key={kind}>
                <h3 className="sk-label mb-1">{t(KIND_LABEL[kind])}</h3>
                <div className="flex flex-wrap gap-1.5">
                  {items.map((i) => (
                    <Badge key={`${kind}-${i.label}`} tone={i.onSite ? "good" : "danger"} title={i.onSite ? t("on the site") : t("not on the site")}>
                      {i.onSite ? "✓" : "✗"} {i.label}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
            {a.siteOnly.length ? <p className="text-sm text-muted">{t("On the site but not in your CV: {value}.", { value: a.siteOnly.join(", ") })}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={!missing.length && !a.siteOnly.length}
                onClick={() => openAssistant(t("Bring my website in line with my CV. Missing on the site: {value}. Read my CV (knife_cv_get) and the site (knife_site_status, knife_site_page), write the copy in the site's language from facts in the CV only, change it on the work branch and open a pull request.", { value: missing.map((i) => `${i.kind} "${i.label}"`).join(", ") || "nothing" }))}
              >
                {t("Update the website from my CV")}
              </Button>
              {a.siteOnly.length ? (
                <Button onClick={() => openAssistant(t("My website mentions {join} but my CV does not. Ask me which of these I really use, then add those to the CV skills (CV studio).", { join: a.siteOnly.join(", ") }))}>
                  {t("Update my CV from the website")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">{a?.note || t("No CV comparison in this audit.")} <Link className="text-accent underline" href="/tools/cv-studio?tab=profile">{t("Open the CV profile")}</Link></p>
        )}
      </Panel>

      {run.pages.map((p) => (
        <Panel key={p.finalUrl} title={t("{value} · copy {score}/100", { value: p.title || p.finalUrl, score: p.copy.score })} right={<span className="font-mono text-xs text-faint">{p.finalUrl.replace(/^https?:\/\//, "")}</span>}>
          {p.copy.words < 30 ? (
            <p className="text-sm text-muted">{t("Only {words} words of text in the HTML: nothing to judge (the text may appear only after JavaScript runs).", { words: p.copy.words })}</p>
          ) : (
            <div className="space-y-3">
              <StatGrid>
                <Stat label={t("Words")} value={p.copy.words} />
                <Stat label={p.copy.readability.formula === "fog-pl" ? "FOG-PL" : t("Flesch")} value={`${p.copy.readability.value} · ${p.copy.readability.label}`} />
                <Stat label={t("Words per sentence")} value={p.copy.avgSentenceWords} />
                <Stat label={t("Calls to action")} value={p.copy.ctaCount} />
                <Stat label={t("Proof signals")} value={p.copy.proofSignals} />
                <Stat label={t("Language")} value={p.copy.lang} />
              </StatGrid>
              <div className="grid gap-2 sm:grid-cols-2">
                {DIMENSIONS.map(([k, label, help]) => (
                  <div key={k} title={t(help)}>
                    <Meter value={p.copy.scores[k]} label={`${t(label)}: ${p.copy.scores[k]}`} />
                  </div>
                ))}
              </div>
              {p.copy.buzzwords.length ? <p className="text-xs text-muted">{t("Buzzwords:")}{" "} {p.copy.buzzwords.join(", ")}</p> : null}
              {p.ctas.length ? <p className="text-xs text-muted">{t("Calls to action found:")}{" "} {p.ctas.join(" · ")}</p> : null}
              <Button size="sm" onClick={() => openAssistant(t("Rewrite the copy of {finalUrl} to score higher (copy score {score}/100; weakest: {value}). Read it with knife_site_page, keep its language and facts from my CV, show me the before/after, then change it on the work branch and open a pull request.", { finalUrl: p.finalUrl, score: p.copy.score, value: DIMENSIONS.filter(([k]) => p.copy.scores[k] < 60).map(([, l]) => l).join(", ") || "none" }))}>
                {t("Improve this page's copy")}
              </Button>
            </div>
          )}
        </Panel>
      ))}
    </div>
  );
}
