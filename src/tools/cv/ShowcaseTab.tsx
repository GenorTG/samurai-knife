"use client";

import { useState } from "react";
import { Badge, Button, EmptyState, Field, Meter, Notice, Panel, TextInput } from "@/components/ui";
import { errorText, getShowcaseRank, getShowcaseRepo, isUnavailable, type ShowcaseDetail, type ShowcaseRanking, type ShowcaseRepo } from "@/lib/cv/client";
import { copyText } from "@/lib/format";
import { SafeLink } from "./shared";
import { useIsAdmin } from "@/lib/use-is-admin";

/** Plain text the assistant can work from: ranking facts + the checklist with its advice. */
export function factsForAssistant(repo: ShowcaseRepo, detail: ShowcaseDetail | null): string {
  const out = [`Showcase facts for ${repo.fullName} (score ${Math.round(repo.score)}/100)`];
  if (repo.url) out.push(`URL: ${repo.url}`);
  if (repo.breakdown.length > 0) out.push(`Score breakdown: ${repo.breakdown.map((b) => `${b.label} ${b.points}`).join(", ")}`);
  if (repo.reasons.length > 0) out.push("", "Why it ranks:", ...repo.reasons.map((r) => `- ${r}`));
  if (repo.improve.length > 0) out.push("", "Improve first:", ...repo.improve.map((r) => `- ${r}`));
  if (detail) {
    out.push("", "Facts:", ...detail.facts.map(([k, v]) => `- ${k}: ${v}`));
    out.push("", "Checklist:", ...detail.checklist.map((c) => `- [${c.passed ? "x" : " "}] ${c.id}${c.passed ? "" : `: ${c.advice}`}`));
  }
  return out.join("\n");
}

function RepoCard({ repo, rank }: { repo: ShowcaseRepo; rank: number }) {
  const [detail, setDetail] = useState<ShowcaseDetail | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error" | "unavailable">("idle");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const load = async (): Promise<ShowcaseDetail | null> => {
    if (detail) return detail;
    setState("loading");
    setError("");
    try {
      const d = await getShowcaseRepo(repo.fullName);
      setDetail(d);
      setState("idle");
      return d;
    } catch (e) {
      setState(isUnavailable(e) ? "unavailable" : "error");
      setError(errorText(e));
      return null;
    }
  };

  const copy = async () => {
    const d = await load();
    if (await copyText(factsForAssistant(repo, d))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <li className="min-w-0 rounded-tool border border-line bg-surface p-4 shadow-card" data-cv-path={`/showcase/${repo.fullName}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink wrap-anywhere"><span className="mr-2 font-mono text-faint">#{rank}</span>{repo.url ? <SafeLink href={repo.url} className="text-ink hover:text-accent-soft">{repo.fullName}</SafeLink> : repo.fullName}</h3>
        </div>
        <div className="w-40 shrink-0 space-y-1">
          <div className="flex items-baseline justify-between"><span className="sk-label">Score</span><span className="font-mono text-lg font-semibold text-ink tabular-nums">{Math.round(repo.score)}</span></div>
          <Meter value={repo.score} label={`Showcase score of ${repo.fullName}`} />
        </div>
      </div>
      {repo.breakdown.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">{repo.breakdown.map((b) => <Badge key={b.label}>{b.label} {b.points}</Badge>)}</div>
      ) : null}
      <div className="mt-3 grid gap-3 @2xl:grid-cols-2">
        <section aria-label={`Why ${repo.fullName} ranks`}>
          <h4 className="sk-label mb-1">Why it ranks</h4>
          <ul className="list-disc space-y-0.5 pl-4 text-[13px] text-muted">{repo.reasons.length === 0 ? <li className="list-none text-faint">No reasons reported.</li> : repo.reasons.map((r, i) => <li key={i} className="wrap-anywhere">{r}</li>)}</ul>
        </section>
        <section aria-label={`Improve ${repo.fullName} first`}>
          <h4 className="sk-label mb-1">Improve first</h4>
          <ul className="list-disc space-y-0.5 pl-4 text-[13px] text-muted">{repo.improve.length === 0 ? <li className="list-none text-faint">Nothing urgent.</li> : repo.improve.map((r, i) => <li key={i} className="wrap-anywhere">{r}</li>)}</ul>
        </section>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void load()} disabled={state === "loading" || detail !== null} aria-label={`Load details of ${repo.fullName}`}>{state === "loading" ? "Loading…" : detail ? "Details loaded" : "Load details and checklist"}</Button>
        <Button size="sm" variant={copied ? "primary" : "subtle"} onClick={() => void copy()} aria-label={`Copy facts for the assistant: ${repo.fullName}`}>{copied ? "Copied" : "Copy facts for the assistant"}</Button>
      </div>
      {state === "unavailable" ? <div className="mt-3"><Notice>Repo details are not available yet on this server.</Notice></div> : null}
      {state === "error" ? <div className="mt-3" role="alert"><Notice tone="error">{error}</Notice></div> : null}
      {detail ? (
        <div className="mt-3 grid gap-3 @2xl:grid-cols-2" data-agent-region={`showcase-${repo.fullName}`}>
          <section aria-label="Repository facts">
            <h4 className="sk-label mb-1">Facts</h4>
            <dl className="divide-y divide-line overflow-hidden rounded-lg border border-line text-[13px]">
              {detail.facts.map(([k, v]) => (
                <div key={k} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2 px-2.5 py-1.5"><dt className="text-faint">{k}</dt><dd className="text-ink wrap-anywhere">{v}</dd></div>
              ))}
            </dl>
          </section>
          <section aria-label="Showcase checklist">
            <h4 className="sk-label mb-1">Checklist ({detail.checklist.filter((c) => c.passed).length}/{detail.checklist.length})</h4>
            <ul className="space-y-1">
              {detail.checklist.map((c) => (
                <li key={c.id} className="flex items-start gap-2 text-[13px]">
                  <Badge tone={c.passed ? "good" : "warn"}>{c.passed ? "ok" : "todo"}</Badge>
                  <span className="min-w-0 wrap-anywhere"><span className="font-medium text-ink">{c.id}</span>{!c.passed && c.advice ? <span className="text-muted"> — {c.advice}</span> : null}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
    </li>
  );
}

export default function ShowcaseTab() {
  const admin = useIsAdmin();
  const [owner, setOwner] = useState("");
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "unavailable" | "error">("idle");
  const [ranking, setRanking] = useState<ShowcaseRanking | null>(null);
  const [error, setError] = useState("");

  const run = async () => {
    setPhase("loading");
    setError("");
    try {
      setRanking(await getShowcaseRank(owner.trim()));
      setPhase("ready");
    } catch (e) {
      setPhase(isUnavailable(e) ? "unavailable" : "error");
      setError(errorText(e));
    }
  };

  if (admin === false) {
    return (
      <div className="@container space-y-4">
        <Panel title="Project showcase">
          <Notice>An administrator has to run the project showcase on this server: it reads GitHub with the server owner&apos;s own login. Add your projects on the Profile tab by hand, or ask the assistant to write them from what you tell it.</Notice>
        </Panel>
      </div>
    );
  }

  return (
    <div className="@container space-y-4">
      <Panel title="Project showcase">
        <form className="space-y-3" aria-label="Rank repositories" onSubmit={(e) => { e.preventDefault(); void run(); }}>
          <p className="text-[13px] leading-relaxed text-muted">
            Ranks your public, non-fork GitHub repositories by how well they work as CV evidence (stars, recency, commits, README and presentation) and says what to fix first.
            The assistant can then write the project bullets from these facts.
          </p>
          <Field label="GitHub owner" hint="Leave empty to use the account the server is signed in with.">
            <TextInput aria-label="GitHub owner" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="your-github-username" autoCapitalize="none" spellCheck={false} />
          </Field>
          <Button variant="primary" type="submit" disabled={phase === "loading"}>{phase === "loading" ? "Ranking…" : "Rank my repositories"}</Button>
          {phase === "loading" ? <p role="status" className="text-sm text-muted">Reading repository facts from GitHub. This can take up to a minute.</p> : null}
          {phase === "unavailable" ? <Notice>The showcase is not available yet on this server.</Notice> : null}
          {phase === "error" ? <div role="alert"><Notice tone="error">{error}</Notice></div> : null}
        </form>
      </Panel>

      {ranking ? (
        ranking.repos.length === 0 ? (
          <EmptyState title="No repositories to rank">No public non-fork repositories were found for this owner.</EmptyState>
        ) : (
          <>
            {ranking.note ? <p className="text-xs text-faint">{ranking.note}</p> : null}
            <ol className="space-y-3" aria-label="Ranked repositories">
              {ranking.repos.map((repo, i) => <RepoCard key={repo.fullName} repo={repo} rank={i + 1} />)}
            </ol>
            {ranking.skipped.length > 0 ? (
              <Notice tone="warn">Skipped {ranking.skipped.length}: {ranking.skipped.map((s) => `${s.repo} (${s.error})`).join("; ")}</Notice>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}
