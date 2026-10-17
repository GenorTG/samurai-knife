"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge, Button, EmptyState, Meter, Notice, Panel, Stat, StatGrid } from "@/components/ui";
import { openAssistant } from "@/lib/agent-client/bridge";
import type { AlignmentItem } from "@/lib/site/audit/types";
import { siteRequest, when, type AuditRun } from "./client";
import { useSite } from "./useSite";

const KIND_LABEL: Record<AlignmentItem["kind"], string> = { name: "Name", headline: "Headline", role: "Current role", project: "Projects", skill: "Skills", link: "Profile links", email: "Email" };
const DIMENSIONS: [keyof AuditRun["pages"][number]["copy"]["scores"], string, string][] = [
  ["hero", "First screen", "H1 says who you are / what you offer, with a line under it"],
  ["cta", "Calls to action", "Asks the visitor to contact you, with a direct channel"],
  ["proof", "Proof", "Numbers, results, project links"],
  ["readability", "Readability", "FOG-PL (Polish) or Flesch (English)"],
  ["sentences", "Sentence length", "Share of long sentences"],
  ["focus", "Reader focus", "Talks about the visitor's outcome, not only about you"],
  ["buzzwords", "No buzzwords", "Empty words like innowacyjny / cutting-edge"],
  ["substance", "Substance", "Enough text to say something"],
];

/**
 * Copy & CV: copywriting scores per page and how the site lines up with the CV studio profile. Also the "Website" tab
 * of the CV studio (the CV flow), so it links to the full website studio from there.
 */
export default function CopyTab() {
  const { view } = useSite();
  const inCv = usePathname()?.startsWith("/tools/cv-studio") ?? false;
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

  if (!view) return <p className="text-sm text-muted">Loading…</p>;
  if (!view.connected && !view.latest) {
    return (
      <EmptyState title="Connect your website to compare it with your CV" action={<Link className="text-accent underline" href="/tools/site-studio?tab=connect">Open the website studio</Link>}>
        Your personal or company site should tell the same story as your CV: current role, best projects, the skills you want to be hired for.
      </EmptyState>
    );
  }
  if (!run) {
    return (
      <EmptyState title="No audit yet" action={<Link className="text-accent underline" href="/tools/site-studio?tab=score">Run an audit</Link>}>
        The copy and CV comparison come from the latest audit.
      </EmptyState>
    );
  }
  const a = run.alignment;
  const groups = a ? (Object.keys(KIND_LABEL) as AlignmentItem["kind"][]).map((k) => [k, a.items.filter((i) => i.kind === k)] as const).filter(([, items]) => items.length) : [];
  const missing = a ? a.items.filter((i) => !i.onSite) : [];

  return (
    <div className="space-y-4">
      {inCv ? <Notice tone="info">From your website audit of {when(run.finishedAt)}. Edit the site in the <Link className="underline" href="/tools/site-studio?tab=score">website studio</Link>; edit the CV in the other tabs here.</Notice> : null}
      <Panel title={`CV fit${a ? ` · ${a.score}/100` : ""}`}>
        {a && a.items.length ? (
          <div className="space-y-3">
            <Meter value={a.score} label="How much of your CV the site shows" />
            {groups.map(([kind, items]) => (
              <div key={kind}>
                <h3 className="sk-label mb-1">{KIND_LABEL[kind]}</h3>
                <div className="flex flex-wrap gap-1.5">
                  {items.map((i) => (
                    <Badge key={`${kind}-${i.label}`} tone={i.onSite ? "good" : "danger"} title={i.onSite ? "on the site" : "not on the site"}>
                      {i.onSite ? "✓" : "✗"} {i.label}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
            {a.siteOnly.length ? <p className="text-sm text-muted">On the site but not in your CV: {a.siteOnly.join(", ")}.</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={!missing.length && !a.siteOnly.length}
                onClick={() => openAssistant(`Bring my website in line with my CV. Missing on the site: ${missing.map((i) => `${i.kind} "${i.label}"`).join(", ") || "nothing"}. Read my CV (knife_cv_get) and the site (knife_site_status, knife_site_page), write the copy in the site's language from facts in the CV only, change it on the work branch and open a pull request.`)}
              >
                Update the website from my CV
              </Button>
              {a.siteOnly.length ? (
                <Button onClick={() => openAssistant(`My website mentions ${a.siteOnly.join(", ")} but my CV does not. Ask me which of these I really use, then add those to the CV skills (CV studio).`)}>
                  Update my CV from the website
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">{a?.note || "No CV comparison in this audit."} <Link className="text-accent underline" href="/tools/cv-studio?tab=profile">Open the CV profile</Link></p>
        )}
      </Panel>

      {run.pages.map((p) => (
        <Panel key={p.finalUrl} title={`${p.title || p.finalUrl} · copy ${p.copy.score}/100`} right={<span className="font-mono text-xs text-faint">{p.finalUrl.replace(/^https?:\/\//, "")}</span>}>
          {p.copy.words < 30 ? (
            <p className="text-sm text-muted">Only {p.copy.words} words of text in the HTML: nothing to judge (the text may appear only after JavaScript runs).</p>
          ) : (
            <div className="space-y-3">
              <StatGrid>
                <Stat label="Words" value={p.copy.words} />
                <Stat label={p.copy.readability.formula === "fog-pl" ? "FOG-PL" : "Flesch"} value={`${p.copy.readability.value} · ${p.copy.readability.label}`} />
                <Stat label="Words per sentence" value={p.copy.avgSentenceWords} />
                <Stat label="Calls to action" value={p.copy.ctaCount} />
                <Stat label="Proof signals" value={p.copy.proofSignals} />
                <Stat label="Language" value={p.copy.lang} />
              </StatGrid>
              <div className="grid gap-2 sm:grid-cols-2">
                {DIMENSIONS.map(([k, label, help]) => (
                  <div key={k} title={help}>
                    <Meter value={p.copy.scores[k]} label={`${label}: ${p.copy.scores[k]}`} />
                  </div>
                ))}
              </div>
              {p.copy.buzzwords.length ? <p className="text-xs text-muted">Buzzwords: {p.copy.buzzwords.join(", ")}</p> : null}
              {p.ctas.length ? <p className="text-xs text-muted">Calls to action found: {p.ctas.join(" · ")}</p> : null}
              <Button size="sm" onClick={() => openAssistant(`Rewrite the copy of ${p.finalUrl} to score higher (copy score ${p.copy.score}/100; weakest: ${DIMENSIONS.filter(([k]) => p.copy.scores[k] < 60).map(([, l]) => l).join(", ") || "none"}). Read it with knife_site_page, keep its language and facts from my CV, show me the before/after, then change it on the work branch and open a pull request.`)}>
                Improve this page&apos;s copy
              </Button>
            </div>
          )}
        </Panel>
      ))}
    </div>
  );
}
