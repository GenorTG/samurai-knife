"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Badge, Button, EmptyState, Field, Meter, Notice, Panel, TextArea, TextInput } from "@/components/ui";
import {
  addJob, deleteJob, errorText, getMatch, isUnavailable, readCompany, saveApplication, saveJob, saveVariant, suggestVariant,
  type MatchResult,
} from "@/lib/cv/client";
import { openAssistant } from "@/lib/agent-client/bridge";
import { JUSTJOIN_LEVELS } from "@/lib/cv/jobs/justjoin";
import { labelForPath } from "@/lib/cv/diff";
import type { Job, Profile, Variant } from "@/lib/cv/schema";
import { resolveVariant } from "@/lib/cv/variant";
import { cx } from "@/lib/format";
import { CvFrame, externalUrl, LangToggle, NoProfileNotice, profileHref, profileIsEmpty, SafeLink, useLang } from "./shared";
import { useCvData } from "./useCvData";
import { useT } from "@/lib/i18n/react";
import { msg, msgf } from "@/lib/i18n/msg";

const TAB = "jobs";

function hostOf(url: string): string {
  const safe = externalUrl(url);
  return safe ? new URL(safe).host : "";
}

const lines = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter(Boolean);

/** The box holds only links (one or more per line, nothing else): those links, deduplicated. Otherwise []. */
export function offerLinks(text: string): string[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length || !tokens.every((t) => /^https?:\/\/\S+$/i.test(t))) return [];
  return [...new Set(tokens)];
}

/* --------------------------------------------------------------- add form */

function AddOffer({ onAdded }: { onAdded: (job: Job, note: string) => void }) {
  const { t: tr } = useT();
  const [source, setSource] = useState("");
  const [company, setCompany] = useState("");
  const [title, setTitle] = useState("");
  const [companyUrl, setCompanyUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const links = offerLinks(source);
  const bulk = links.length > 1;

  /** Several links, one per line: save each in turn; the form's other fields belong to one offer, so they are not used. */
  const submitMany = async () => {
    setBusy(true);
    setError("");
    const failed: string[] = [];
    let last: Job | null = null;
    for (const [i, url] of links.entries()) {
      setProgress(tr("Saving offer {value} of {links}…", { value: i + 1, links: links.length }));
      try {
        last = (await addJob({ urlOrText: url })).job;
      } catch (e) {
        failed.push(`${url}: ${errorText(e).replace(/\s*Ask the user[^.]*\.(\s.*)?$/s, " Paste the posting text instead.")}`);
      }
    }
    setProgress("");
    setBusy(false);
    if (failed.length) {
      setSource(failed.map((f) => f.split(": ")[0]).join("\n"));
      setError(tr("{saved} of {total} saved. Not saved (left in the box):\n{failed}", { saved: links.length - failed.length, total: links.length, failed: failed.join("\n") }));
    } else setSource("");
    if (last) onAdded(last, tr("{saved} of {total} offers saved.", { saved: links.length - failed.length, total: links.length }));
  };

  const submit = async () => {
    if (!source.trim() || busy) return;
    if (bulk) return submitMany();
    setBusy(true);
    setError("");
    try {
      const res = await addJob({
        urlOrText: source.trim(),
        title: title.trim() || undefined,
        company: company.trim() || undefined,
        companyUrl: companyUrl.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      const isLink = /^https?:\/\/\S+$/i.test(source.trim());
      const note = !res.viaFetch && isLink
        ? tr("Saved the link. Fetching the posting text is not available on this server yet: paste the posting text into the offer to enable matching.")
        : res.companyNote ? tr("Offer saved. The company website was not read: {companyNote}", { companyNote: res.companyNote }) : tr("Offer saved.");
      setSource("");
      setCompany("");
      setTitle("");
      setCompanyUrl("");
      setNotes("");
      onAdded(res.job, note);
    } catch (e) {
      // The fetch route's message is addressed to the assistant; say the same thing to the person.
      setError(errorText(e).replace(/\s*Ask the user[^.]*\.(\s.*)?$/s, " Paste the posting text instead."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={tr("Add a job offer")}>
      <form
        className="space-y-3"
        aria-label={tr("Add job offer")}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label={tr("Job link or posting text")} hint={tr("A justjoin.it or nofluffjobs.com link brings the skills and salary too. Several links, one per line, are saved in one go. Paste the whole posting if the page needs a login (pracuj.pl, LinkedIn).")}>
          <TextArea aria-label={tr("Job link or posting text")} rows={4} value={source} onChange={(e) => setSource(e.target.value)} placeholder={tr("https://justjoin.it/job-offer/… or paste the posting")} className="font-sans" />
        </Field>
        <Field label={tr("Company website")} hint={tr("Optional. Read once, so the CV can speak to what the company does.")}>
          <TextInput aria-label={tr("Company website")} value={companyUrl} onChange={(e) => setCompanyUrl(e.target.value)} placeholder={tr("https://… (optional)")} inputMode="url" />
        </Field>
        <Field label={tr("Notes")} hint={tr("Optional. Extra details for tailoring: what the recruiter said, what they care about, anything copied from elsewhere.")}>
          <TextArea aria-label={tr("Offer notes")} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} className="font-sans" />
        </Field>
        <div className="grid gap-3 @md:grid-cols-2">
          <Field label={tr("Company")}><TextInput value={company} onChange={(e) => setCompany(e.target.value)} placeholder={tr("Optional")} /></Field>
          <Field label={tr("Job title")}><TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tr("Optional")} /></Field>
        </div>
        {bulk ? <p className="text-xs text-muted">{links.length} {" "}{tr("links: each is saved as its own offer. Website, notes, company and title are for a single offer and are not used.")}</p> : null}
        {progress ? <p role="status" className="text-sm text-muted">{progress}</p> : null}
        {error ? <div role="alert"><Notice tone="error"><span className="whitespace-pre-line">{error}</span></Notice></div> : null}
        <Button variant="primary" type="submit" disabled={!source.trim() || busy}>{busy ? tr("Saving…") : bulk ? tr("Save {links} offers", { links: links.length }) : tr("Save offer")}</Button>
      </form>
    </Panel>
  );
}

/* --------------------------------------------------------------- offer list */

function OfferList({ jobs, selected, onSelect, applied, appliedOn }: { jobs: Job[]; selected: string; onSelect: (id: string) => void; applied: Map<string, string>; appliedOn: Map<string, string> }) {
  const { t: tr } = useT();
  return (
    <ul className="space-y-2" aria-label={tr("Saved offers")}>
      {jobs.map((job) => {
        const active = job.id === selected;
        return (
          <li key={job.id} data-cv-path={`/jobs/id=${job.id}`} className="rounded-xl">
            <button
              autoComplete="off"
              type="button"
              aria-pressed={active}
              aria-label={tr("Open offer {value} {value2}", { value: job.company || "Unknown company", value2: job.title || "untitled" })}
              onClick={() => onSelect(job.id)}
              className={cx(
                "block w-full cursor-pointer rounded-xl border p-3 text-left transition-colors",
                active ? "border-accent/60 bg-accent/10" : "border-line bg-surface hover:border-line-strong hover:bg-raised/60",
              )}
            >
              <span className="block text-sm font-semibold text-ink wrap-anywhere">{job.title || tr("Untitled offer")}</span>
              <span className="block text-[13px] text-muted wrap-anywhere">{job.company || tr("Unknown company")}{job.location ? ` · ${job.location}` : ""}</span>
              <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {job.url ? <Badge title={job.url}>{hostOf(job.url) || tr("link")}</Badge> : <Badge>{tr("pasted")}</Badge>}
                {job.requirements.length > 0 ? <Badge tone="accent">{job.requirements.length} {" "}{tr("requirements")}</Badge> : null}
                {applied.has(job.id) ? <Badge tone="good" title={appliedOn.has(job.id) ? tr("Applied on {id}", { id: appliedOn.get(job.id) }) : tr("Tracked in Applications")}>{applied.get(job.id)}{appliedOn.has(job.id) ? ` · ${appliedOn.get(job.id)}` : ""}</Badge> : null}
                <span className="text-[11px] text-faint">{job.savedAt.slice(0, 10)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------- match panel */

type MatchState = { key: string; phase: "idle" | "loading" | "unavailable" | "error" | "ready"; result: MatchResult | null; error: string };

function MatchPanel({ job, profile, state }: { job: Job; profile: Profile; state: MatchState }) {
  const { t: tr, tn } = useT();
  const m = state.result;
  return (
    <Panel title={tr("Match with your profile")} right={<LangToggle tab={TAB} label={tr("Match language")} />}>
      <div className="space-y-4" data-agent-region="cv-match">
        {state.phase === "loading" ? <p role="status" className="text-sm text-muted">{tr("Matching…")}</p> : null}
        {state.phase === "unavailable" ? <Notice>{tr("Matching is not available yet on this server.")}</Notice> : null}
        {state.phase === "error" ? <Notice tone="error">{tr("Match failed:")}{" "} {state.error}</Notice> : null}
        {state.phase === "ready" && !job.text && job.requirements.length === 0 ? <Notice tone="warn">{tr("This offer has no posting text or requirements yet, so there is nothing to match. Paste the text or add requirements below.")}</Notice> : null}
        {m ? (
          <>
            <div className="grid gap-3 @md:grid-cols-2">
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between"><span className="sk-label">{tr("Coverage")}</span><span className="font-mono text-lg font-semibold text-ink tabular-nums">{Math.round(m.coveragePct)}%</span></div>
                <Meter value={m.coveragePct} label={tr("Overall coverage")} />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between"><span className="sk-label">{tr("Technologies")}</span><span className="font-mono text-lg font-semibold text-ink tabular-nums">{m.techCoveragePct === null ? "n/a" : `${Math.round(m.techCoveragePct)}%`}</span></div>
                <Meter value={m.techCoveragePct ?? 0} label={tr("Technology coverage")} />
              </div>
            </div>

            {m.missingRequired.length > 0 || m.missing.length > 0 ? (
              <section aria-label={tr("Gaps")} className="space-y-2 rounded-xl border border-warn/30 bg-warn/5 p-3">
                <h3 className="text-[13px] font-semibold text-ink">{tr("Gaps: asked for, not in your profile")}</h3>
                {m.missingRequired.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted">{tr("Required:")}</span>
                    {m.missingRequired.map((t) => <Badge key={t} tone="danger">{t}</Badge>)}
                  </div>
                ) : null}
                {m.missing.filter((t) => !m.missingRequired.includes(t)).length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted">{tr("Other:")}</span>
                    {m.missing.filter((t) => !m.missingRequired.includes(t)).map((t) => <Badge key={t} tone="warn">{t}</Badge>)}
                  </div>
                ) : null}
                <p className="text-xs leading-relaxed text-muted">{tr("Add only what is true: ask the assistant to look for real evidence, or write a verified bullet in the Profile tab.")}</p>
              </section>
            ) : null}

            <section aria-label={tr("Matched terms")} className="space-y-2">
              <h3 className="text-[13px] font-semibold text-ink">{tr("Matched ({matched})", { matched: m.matched.length })}</h3>
              {m.matched.length === 0 ? <p className="text-sm text-muted">{tr("No overlap found yet.")}</p> : (
                <ul className="space-y-2">
                  {m.matched.map((hit) => (
                    <li key={hit.term} className="rounded-lg border border-line bg-raised/40 p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="good">{hit.term}</Badge>
                        <span className="text-xs text-faint">{tn("{n} place in your profile", "{n} places in your profile", hit.evidence.length)}</span>
                      </div>
                      <ul className="mt-1.5 space-y-1">
                        {hit.evidence.slice(0, 3).map((ev, i) => (
                          <li key={`${ev.path}-${i}`} className="text-xs leading-relaxed text-muted">
                            <Link href={profileHref(ev.path)} className="font-medium text-accent-soft underline underline-offset-2 hover:text-ink" aria-label={tr("Open {profile} in the profile", { profile: labelForPath(profile, ev.path) })}>
                              {labelForPath(profile, ev.path)}
                            </Link>
                            {ev.text ? <span className="wrap-anywhere"> — {ev.text.length > 140 ? `${ev.text.slice(0, 139)}…` : ev.text}</span> : null}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {m.requirementHits.length > 0 ? (
              <section aria-label={tr("Requirement check")} className="space-y-1.5">
                <h3 className="text-[13px] font-semibold text-ink">{tr("Requirement by requirement")}</h3>
                <ul className="space-y-1">
                  {m.requirementHits.map((h, i) => (
                    <li key={`${h.requirement}-${i}`} className="flex items-start gap-2 text-[13px] text-muted">
                      <Badge tone={h.hit ? "good" : "danger"}>{h.hit ? tr("covered") : "gap"}</Badge>
                      <span className="min-w-0 wrap-anywhere">{h.requirement}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------- offer detail + edit */

/** What the job board states besides the text: skills with levels, seniority, mode, salary, languages, apply link. */
function BoardFacts({ job }: { job: Job }) {
  const { t: tr } = useT();
  const required = job.skills.filter((s) => s.required);
  const nice = job.skills.filter((s) => !s.required);
  const facts = [job.seniority && ["Seniority", job.seniority], job.workplace && [tr("Work mode"), job.workplace], job.salary && ["Salary", job.salary], job.languages.length > 0 && ["Languages", job.languages.join(", ")]].filter(Boolean) as [string, string][];
  if (!job.skills.length && !facts.length && !job.applyUrl) return null;
  const skill = (s: Job["skills"][number]) => (
    <Badge key={`${s.name}-${s.required}`} tone={s.required ? "accent" : "neutral"} title={s.level !== null ? tr("Level {level}/5: {value}", { level: s.level, value: JUSTJOIN_LEVELS[s.level] ?? s.level }) : undefined}>
      {s.name}{s.level !== null ? ` · ${JUSTJOIN_LEVELS[s.level] ?? s.level}` : ""}
    </Badge>
  );
  return (
    <section aria-label={tr("From the job board")} className="space-y-2 rounded-xl border border-line bg-raised/30 p-3">
      <h3 className="text-[13px] font-semibold text-ink">{tr("From the job board")}</h3>
      {required.length > 0 ? <div className="flex flex-wrap items-center gap-1.5"><span className="text-xs text-muted">{tr("Skills:")}</span>{required.map(skill)}</div> : null}
      {nice.length > 0 ? <div className="flex flex-wrap items-center gap-1.5"><span className="text-xs text-muted">{tr("Nice to have:")}</span>{nice.map(skill)}</div> : null}
      {facts.length > 0 ? (
        <dl className="grid gap-x-4 gap-y-1 text-[13px] @md:grid-cols-2">
          {facts.map(([k, v]) => <div key={k} className="flex gap-2"><dt className="text-muted">{k}:</dt><dd className="text-ink wrap-anywhere">{v}</dd></div>)}
        </dl>
      ) : null}
      {job.applyUrl ? <SafeLink href={job.applyUrl}>{tr("Apply on the company's page ↗")}</SafeLink> : null}
    </section>
  );
}

function OfferEditor({ job, onChanged, onDeleted }: { job: Job; onChanged: () => void; onDeleted: () => void }) {
  const { t: tr } = useT();
  const stored = JSON.stringify(job);
  const fromJob = (j: Job) => ({ company: j.company, title: j.title, url: j.url, location: j.location, text: j.text, req: j.requirements.join("\n"), nice: j.niceToHave.join("\n"), notes: j.notes, companyUrl: j.companyUrl });
  const [draft, setDraft] = useState({ base: stored, form: fromJob(job) });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  // The offer moved on the server (our own save, the assistant, another tab): adopt it unless there are unsaved edits.
  const pristine = JSON.stringify(draft.form) === JSON.stringify(fromJob(JSON.parse(draft.base) as Job));
  if (draft.base !== stored && pristine) setDraft({ base: stored, form: fromJob(job) });
  const form = draft.form;
  const setForm = (next: typeof form) => setDraft({ ...draft, form: next });
  const req = form.req;
  const nice = form.nice;
  const setReq = (value: string) => setForm({ ...form, req: value });
  const setNice = (value: string) => setForm({ ...form, nice: value });

  const save = async (patch: Partial<Job>, message: string) => {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      await saveJob({ id: job.id, ...patch });
      setSaved(message);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const readSite = async () => {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const res = await readCompany(job.id, form.companyUrl.trim() || undefined);
      setSaved(res.companyNote ? tr("Website saved, but not read: {companyNote}", { companyNote: res.companyNote }) : tr("Read the company website ({companyText} characters).", { companyText: res.job.companyText.length }));
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteJob(job.id);
      onDeleted();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Panel
      title={tr("Offer details")}
      right={<Button size="sm" variant="danger" aria-label={tr("Delete offer {company} {title}", { company: job.company, title: job.title })} onClick={() => void remove()} disabled={busy}>{tr("Delete offer")}</Button>}
    >
      <div className="space-y-4" data-cv-path={`/jobs/id=${job.id}`}>
        <div className="grid gap-3 @md:grid-cols-2">
          <Field label={tr("Company")}><TextInput value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} /></Field>
          <Field label={tr("Job title")}><TextInput value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <Field label={tr("Offer link")}><TextInput value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder={tr("https://…")} /></Field>
          <Field label={tr("Location")}><TextInput value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void save({ company: form.company, title: form.title, url: form.url, location: form.location }, tr("Details saved."))} disabled={busy}>{tr("Save details")}</Button>
          {job.url ? <SafeLink href={job.url}>{tr("Open the offer ↗")}</SafeLink> : <span className="text-xs text-faint">{tr("No link saved")}</span>}
        </div>

        <BoardFacts job={job} />

        <div className="grid gap-3 @md:grid-cols-[minmax(0,1fr)_auto] @md:items-end">
          <Field label={tr("Company website")} hint={job.companyText ? tr("Read: {companyText} characters of context.", { companyText: job.companyText.length }) : tr("Not read yet.")}>
            <TextInput aria-label={tr("Offer company website")} value={form.companyUrl} onChange={(e) => setForm({ ...form, companyUrl: e.target.value })} placeholder={tr("https://…")} inputMode="url" />
          </Field>
          <Button onClick={() => void readSite()} disabled={busy || !form.companyUrl.trim()}>{tr("Read website")}</Button>
        </div>

        <Field label={tr("Notes for this offer")} hint={tr("Read by the assistant when it tailors your CV. Never printed.")}>
          <TextArea aria-label={tr("Notes for this offer")} rows={4} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="font-sans" />
        </Field>
        <Button onClick={() => void save({ notes: form.notes }, tr("Notes saved."))} disabled={busy}>{tr("Save notes")}</Button>

        <div className="grid gap-3 @md:grid-cols-2">
          <Field label={tr("Requirements (one per line)")} hint={tr("Sharper requirements make the match sharper. Ask the assistant to extract them.")}>
            <TextArea aria-label={tr("Requirements (one per line)")} rows={7} value={req} onChange={(e) => setReq(e.target.value)} className="font-sans" />
          </Field>
          <Field label={tr("Nice to have (one per line)")}>
            <TextArea rows={7} value={nice} onChange={(e) => setNice(e.target.value)} className="font-sans" />
          </Field>
        </div>
        <Button onClick={() => void save({ requirements: lines(req), niceToHave: lines(nice) }, tr("Requirements saved."))} disabled={busy}>{tr("Save requirements")}</Button>

        <details className="rounded-lg border border-line bg-raised/30 px-3 py-2">
          <summary className="cursor-pointer text-[13px] font-medium text-muted">{tr("Posting text ({text} characters)", { text: job.text.length })}</summary>
          <div className="mt-2 space-y-2">
            <TextArea rows={10} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} aria-label={tr("Posting text")} className="font-sans" />
            <Button size="sm" onClick={() => void save({ text: form.text }, tr("Posting text saved."))} disabled={busy}>{tr("Save posting text")}</Button>
          </div>
        </details>
        {error ? <div role="alert"><Notice tone="error">{error}</Notice></div> : null}
        {saved ? <div role="status"><Notice tone="good">{saved}</Notice></div> : null}
      </div>
    </Panel>
  );
}

/* -------------------------------------------------- variant + application */

function VariantReview({ job, profile, draft, onClose, onSaved }: { job: Job; profile: Profile; draft: Variant; onClose: () => void; onSaved: (v: Variant) => void }) {
  const { t: tr, tn } = useT();
  const lang = draft.lang;
  const [name, setName] = useState(draft.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const resolved = useMemo(() => resolveVariant(profile, draft), [profile, draft]);
  const bullets = resolved.experience.reduce((n, e) => n + e.bullets.length, 0);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await saveVariant({ ...draft, name: name.trim() || draft.name });
      onSaved(res.variant);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Panel title={tr("Review the suggested version ({value})", { value: lang.toUpperCase() })}>
      <div className="space-y-3" data-agent-region="cv-variant-review">
        <Field label={tr("Version name")}><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <p className="text-[13px] text-muted">
          {tr("For {target}: {bullets}, {roles}, {projects}, {skills}.", { target: job.company || tr("this offer"), bullets: tn("{n} bullet", "{n} bullets", bullets), roles: tn("{n} role", "{n} roles", resolved.experience.length), projects: tn("{n} project", "{n} projects", resolved.projects.length), skills: tn("{n} skill group", "{n} skill groups", resolved.skills.length) })}
        </p>
        <ul className="space-y-2">
          {resolved.experience.map((e) => (
            <li key={e.id} className="rounded-lg border border-line bg-raised/40 p-2.5">
              <p className="text-[13px] font-semibold text-ink">{e.org} <span className="font-normal text-muted">· {e.role[lang]}</span></p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted">
                {e.bullets.map((b) => <li key={b.id} className="wrap-anywhere">{b.text[lang] || <em className="text-faint">{tr("(empty in {value})", { value: lang.toUpperCase() })}</em>}</li>)}
              </ul>
            </li>
          ))}
        </ul>
        {error ? <div role="alert"><Notice tone="error">{error}</Notice></div> : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void save()} disabled={busy}>{tr("Save version")}</Button>
          <Button variant="ghost" onClick={onClose}>{tr("Discard")}</Button>
        </div>
      </div>
    </Panel>
  );
}

/** What "Tailor with the assistant" sends: the offer, the language, and the truthfulness rule. */
export function tailorPrompt(job: Job, lang: "pl" | "en"): string {
  const what = [job.title || "this offer", job.company ? `at ${job.company}` : ""].filter(Boolean).join(" ");
  return msgf("Tailor my CV for the saved offer “{what}” (jobId: {id}) in {value}: create a CV version for it, reword the bullets for this offer, write the headline and summary, then run the ATS check and fix what it finds. Keep my pinned items, follow my tailoring notes, and do not add anything my profile does not show.", { what, id: job.id, value: lang === "pl" ? msg("Polish (pl)") : msg("English (en)") });
}

function Actions({ job, profile, versions, trackedStatus, onChanged }: { job: Job; profile: Profile; versions: Variant[]; trackedStatus: string; onChanged: () => void }) {
  const { t: tr } = useT();
  const lang = useLang(TAB);
  const [draft, setDraft] = useState<Variant | null>(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState<{ tone: "good" | "error" | "info"; text: string; href?: string; hrefLabel?: string } | null>(null);

  const suggest = async () => {
    setBusy("suggest");
    setNote(null);
    try {
      setDraft(await suggestVariant({ jobId: job.id, lang }));
    } catch (e) {
      setNote({ tone: isUnavailable(e) ? "info" : "error", text: isUnavailable(e) ? tr("Suggesting a version is not available yet on this server.") : errorText(e) });
    } finally {
      setBusy("");
    }
  };

  const track = async () => {
    setBusy("track");
    setNote(null);
    try {
      const latest = [...versions].reverse().find((v) => v.jobId === job.id);
      await saveApplication({ company: job.company || tr("Unknown company"), role: job.title || "Role", url: job.url, jobId: job.id, variantId: latest?.id ?? null, lang, status: "wishlist" });
      onChanged();
      setNote({ tone: "good", text: tr("Application tracked as wishlist."), href: "/tools/cv-studio?tab=applications", hrefLabel: tr("Open applications") });
    } catch (e) {
      setNote({ tone: "error", text: errorText(e) });
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="space-y-3">
      <Panel title={tr("Next steps")}>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => openAssistant(tailorPrompt(job, lang))} disabled={busy !== ""}>{tr("Tailor with the assistant")}</Button>
            <Button onClick={() => void suggest()} disabled={busy !== ""}>{busy === "suggest" ? tr("Suggesting…") : tr("Quick version (no rewording)")}</Button>
            <Button onClick={() => void track()} disabled={busy !== "" || trackedStatus !== ""}>{trackedStatus ? `Tracked (${trackedStatus})` : tr("Track application")}</Button>
            {trackedStatus ? <Link href="/tools/cv-studio?tab=applications" className="inline-flex h-9 items-center text-sm text-accent-soft underline underline-offset-2">{tr("Open applications")}</Link> : null}
          </div>
          {versions.some((v) => v.jobId === job.id) ? (
            <p className="text-xs text-muted">{tr("Existing versions for this offer: {value}.", { value: versions.filter((v) => v.jobId === job.id).map((v) => v.name).join(", ") })}{" "} <Link href="/tools/cv-studio?tab=variants" className="text-accent-soft underline underline-offset-2">{tr("Open CV versions")}</Link></p>
          ) : null}
          {note ? (
            <div role={note.tone === "error" ? "alert" : "status"}>
              <Notice tone={note.tone}>{note.text}{note.href ? <> <Link href={note.href} className="underline underline-offset-2">{note.hrefLabel}</Link></> : null}</Notice>
            </div>
          ) : null}
        </div>
      </Panel>
      {draft ? (
        <VariantReview
          job={job}
          profile={profile}
          draft={draft}
          onClose={() => setDraft(null)}
          onSaved={(v) => {
            setDraft(null);
            onChanged();
            setNote({ tone: "good", text: tr("Saved the version “{name}”.", { name: v.name }), href: "/tools/cv-studio?tab=variants", hrefLabel: tr("Open CV versions") });
          }}
        />
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------------- tab */

export default function JobsTab() {
  const { t: tr } = useT();
  const live = useCvData();
  const lang = useLang(TAB);
  const params = useSearchParams();
  const wanted = params.get("job") ?? "";
  const [picked, setPicked] = useState("");
  const [flash, setFlash] = useState("");
  const [match, setMatch] = useState<MatchState>({ key: "", phase: "idle", result: null, error: "" });
  const data = live.data;
  const selectedId = data ? (data.jobs.find((j) => j.id === picked) ?? data.jobs.find((j) => j.id === wanted) ?? data.jobs.at(-1))?.id ?? "" : "";
  const selected = data?.jobs.find((j) => j.id === selectedId) ?? null;
  // The match depends on the offer's content and the profile: refetch when either of their revisions moves.
  const matchKey = data ? `${selectedId}:${lang}:${data.revision}` : "";
  const { reload } = live;

  useEffect(() => {
    if (!matchKey || !selectedId) return;
    let alive = true;
    getMatch(selectedId, lang).then(
      (result) => alive && setMatch({ key: matchKey, phase: "ready", result, error: "" }),
      (e: unknown) => alive && setMatch({ key: matchKey, phase: isUnavailable(e) ? "unavailable" : "error", result: null, error: errorText(e) }),
    );
    return () => {
      alive = false;
    };
    // matchKey already encodes selectedId, lang and the data revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey]);

  // Until the answer for the current key lands, keep showing the previous result under a "Matching…" line.
  const matchView: MatchState = match.key === matchKey ? match : { ...match, phase: "loading", error: "" };
  const refresh = useCallback(() => void reload(), [reload]);
  const applied = useMemo(() => new Map((data?.applications ?? []).filter((a) => a.jobId).map((a) => [a.jobId as string, a.status])), [data]);
  const appliedOn = useMemo(() => new Map((data?.applications ?? []).filter((a) => a.jobId && a.appliedOn).map((a) => [a.jobId as string, a.appliedOn as string])), [data]);

  return (
    <CvFrame live={live}>
      {(cv) => (
        <div className="@container space-y-4">
          {profileIsEmpty(cv) ? <NoProfileNotice /> : null}
          <div className="grid min-w-0 gap-4 @4xl:grid-cols-[23rem_minmax(0,1fr)]">
            <div className="min-w-0 space-y-4">
              <AddOffer onAdded={(job, note) => { setPicked(job.id); setFlash(note); refresh(); }} />
              {flash ? <div role="status"><Notice tone="good">{flash}</Notice></div> : null}
              {cv.jobs.length === 0 ? (
                <EmptyState title={tr("No offers saved yet")}>{tr("Paste a link or the text of a job posting above. The match, the tailored CV version and the application tracker all start from a saved offer.")}</EmptyState>
              ) : (
                <OfferList jobs={[...cv.jobs].reverse()} selected={selectedId} onSelect={(id) => { setPicked(id); setFlash(""); }} applied={applied} appliedOn={appliedOn} />
              )}
            </div>
            <div className="min-w-0 space-y-4">
              {selected ? (
                <>
                  <header className="min-w-0">
                    <h2 className="text-lg font-semibold tracking-tight text-ink wrap-anywhere">{selected.title || tr("Untitled offer")}</h2>
                    <p className="text-sm text-muted wrap-anywhere">{selected.company || tr("Unknown company")}{selected.location ? ` · ${selected.location}` : ""}</p>
                  </header>
                  <MatchPanel job={selected} profile={cv.profile} state={matchView} />
                  <Actions key={`actions-${selected.id}`} job={selected} profile={cv.profile} versions={cv.variants} trackedStatus={applied.get(selected.id) ?? ""} onChanged={refresh} />
                  <OfferEditor key={`editor-${selected.id}`} job={selected} onChanged={refresh} onDeleted={() => { setPicked(""); refresh(); }} />
                </>
              ) : cv.jobs.length > 0 ? (
                <EmptyState title={tr("Select an offer")} />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </CvFrame>
  );
}
