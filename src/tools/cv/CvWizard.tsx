"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button, Field, Notice, Panel, Select, TextArea, TextInput } from "@/components/ui";
import { errorText, importCv } from "@/lib/cv/client";
import { answersToProfile, EMPTY_JOB, EMPTY_SCHOOL, emptyAnswers, monthProblem, suggestSummary, type WizardAnswers, type WizardJob, type WizardLang, type WizardSchool } from "@/lib/cv/wizard";
import { cx } from "@/lib/format";
import { useT } from "@/lib/i18n/react";
import { msg } from "@/lib/i18n/msg";

/** The account's encrypted draft (/api/workspace, the same store as the tools' drafts), until the CV is created. */
const DRAFT_TOOL = "cv-wizard";
const DRAFT_URL = `/api/workspace?tool=${DRAFT_TOOL}`;

function dropDraft(): void {
  void fetch(DRAFT_URL, { method: "DELETE" }).catch(() => undefined);
}

const STEPS = [
  { id: "you", label: msg("About you") },
  { id: "goal", label: msg("The job you want") },
  { id: "jobs", label: msg("Your work") },
  { id: "schools", label: msg("Your education") },
  { id: "skills", label: msg("What you can do") },
  { id: "about", label: msg("A few words about you") },
  { id: "review", label: msg("Check and finish") },
] as const;

const LEVELS = [msg("Native"), "C2", "C1", "B2", "B1", "A2", "A1"];
const HEADLINE_EXAMPLES = [msg("Accountant"), msg("Sales assistant"), msg("Warehouse worker"), msg("Office assistant"), msg("Nurse"), msg("Software developer")];

function Row({ label, value, empty }: { label: string; value: string; empty: string }) {
  return (
    <div className="grid gap-1 border-b border-line py-2 last:border-0 sm:grid-cols-[11rem_1fr]">
      <dt className="text-[13px] text-faint">{label}</dt>
      <dd className={cx("whitespace-pre-wrap text-sm", value ? "text-ink" : "text-faint")}>{value || empty}</dd>
    </div>
  );
}

/**
 * Create a CV by answering one topic per screen: a progress bar, Back and Next on every step, examples next to the fields,
 * nothing required except the name, dates in whatever way people write them, and a draft saved in the account.
 * `initial` carries what could be read from an uploaded CV; `sourceText` stays visible so it can be copied from.
 */
export function CvWizard({ initial, sourceText, onCreating, onDone, onCancel }: { initial?: Partial<WizardAnswers>; sourceText?: string; onCreating?: (creating: boolean) => void; onDone: () => void; onCancel: () => void }) {
  const { t, locale } = useT();
  const fresh = (): WizardAnswers => ({ ...emptyAnswers(locale === "en" ? "en" : "pl"), ...initial });
  const [a, setA] = useState<WizardAnswers>(fresh);
  const [step, setStep] = useState(0);
  const [restored, setRestored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  // A file brought in by the person (initial) starts over instead of mixing with an earlier draft.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        if (initial) return;
        const response = await fetch(DRAFT_URL, { cache: "no-store" });
        const body = (await response.json()) as Record<string, { answers?: unknown; step?: unknown }>;
        const stored = body[DRAFT_TOOL];
        if (!live || !response.ok || typeof stored?.answers !== "string") return;
        const answers = JSON.parse(stored.answers) as WizardAnswers;
        if (answers.jobs && answers.schools) {
          setA(answers);
          setStep(Math.min(Number(stored.step) || 0, STEPS.length - 1));
          setRestored(true);
        }
      } catch {
        /* no draft */
      } finally {
        if (live) setDraftLoaded(true);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on opening
  }, []);

  // Saved shortly after typing stops; never before the earlier draft was read, so opening the page cannot overwrite it.
  useEffect(() => {
    if (!draftLoaded || created) return;
    const timer = setTimeout(() => {
      void fetch("/api/workspace", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool: DRAFT_TOOL, fields: { answers: JSON.stringify(a), step: String(step) } }) }).catch(() => undefined);
    }, 700);
    return () => clearTimeout(timer);
  }, [a, step, draftLoaded, created]);

  const go = (next: number) => {
    setStep(next);
    setError("");
  };
  // Each step starts at its question, for a keyboard or screen-reader user too (the buttons they pressed may be gone).
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) {
      heading.current?.focus();
      heading.current?.scrollIntoView({ block: "nearest" });
    }
    opened.current = true;
  }, [step]);
  const set = <K extends keyof WizardAnswers>(key: K, value: WizardAnswers[K]) => setA((now) => ({ ...now, [key]: value }));
  const input = (key: "name" | "email" | "phone" | "city" | "link" | "headline") => ({ value: a[key], onChange: (e: { target: { value: string } }) => set(key, e.target.value) });
  const setJob = (i: number, patch: Partial<WizardJob>) => set("jobs", a.jobs.map((job, n) => (n === i ? { ...job, ...patch } : job)));
  const setSchool = (i: number, patch: Partial<WizardSchool>) => set("schools", a.schools.map((school, n) => (n === i ? { ...school, ...patch } : school)));
  const dateHint = (value: string) => (monthProblem(value) ? <span className="text-danger">{t("We can't read this date. Write it like 03.2022 or 2022.")}</span> : t("For example 03.2022 or 2022"));

  const current = STEPS[step];
  const canGoOn = current.id !== "you" || Boolean(a.name.trim());

  const create = async () => {
    setBusy(true);
    setError("");
    // The page refreshes by itself: once the CV exists it would swap this screen for the details form before "ready" shows.
    onCreating?.(true);
    try {
      await importCv(answersToProfile(a), false);
      dropDraft();
      setCreated(true);
    } catch (e) {
      onCreating?.(false);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <Panel title={t("Your CV is ready!")}>
        <div data-cv-wizard-done>
          <p className="text-[15px] leading-relaxed text-muted">{t("Now you can see how it looks, choose a layout and download it as PDF or Word. You can also change anything you wrote at any time.")}</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href="/tools/cv-studio?tab=variants" className="inline-flex h-11 items-center rounded-lg bg-accent px-5 text-[15px] font-semibold text-accent-fg" data-cv-wizard-see>{t("See and download my CV")}</Link>
            <Button size="lg" onClick={onDone}>{t("Add more details")}</Button>
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <div className="space-y-4" data-cv-wizard={current.id}>
      {restored ? (
        <Notice tone="info">
          {t("We kept what you wrote last time.")}{" "}
          <button
            type="button"
            autoComplete="off"
            className="underline underline-offset-2"
            onClick={() => {
              dropDraft();
              setA(fresh());
              setRestored(false);
              go(0);
            }}
          >
            {t("Start over")}
          </button>
        </Notice>
      ) : null}

      <Panel>
        <div className="mb-5">
          <p className="mb-2 text-[13px] text-muted">{t("Step {step} of {total}: {label}", { step: step + 1, total: STEPS.length, label: t(current.label) })}</p>
          <ol className="flex gap-1.5" aria-hidden>
            {STEPS.map((item, i) => <li key={item.id} className={cx("h-1.5 flex-1 rounded-full", i <= step ? "bg-accent" : "bg-raised")} />)}
          </ol>
        </div>

        <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold text-ink outline-none">
          {current.id === "you" ? t("Let's start with you") : null}
          {current.id === "goal" ? t("What job are you looking for?") : null}
          {current.id === "jobs" ? t("Where have you worked?") : null}
          {current.id === "schools" ? t("Where did you study?") : null}
          {current.id === "skills" ? t("What can you do, and which languages do you speak?") : null}
          {current.id === "about" ? t("Write a few words about yourself") : null}
          {current.id === "review" ? t("Is everything right?") : null}
        </h2>

        <div className="mt-4 space-y-4">
          {current.id === "you" ? (
            <>
              <Field label={t("Which language will you write your CV in?")} hint={t("You can add the other language later.")}>
                <span className="flex gap-2">
                  {(["pl", "en"] as WizardLang[]).map((lang) => (
                    <Button key={lang} variant={a.lang === lang ? "primary" : "subtle"} aria-pressed={a.lang === lang} onClick={() => set("lang", lang)}>
                      {lang === "pl" ? "Polski" : "English"}
                    </Button>
                  ))}
                </span>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("Your first and last name")} hint={t("This is the only thing you have to fill in.")}><TextInput {...input("name")} autoComplete="name" required autoFocus /></Field>
                <Field label={t("City")} hint={t("For example Warsaw")}><TextInput {...input("city")} /></Field>
                <Field label={t("Email address")}><TextInput {...input("email")} type="email" autoComplete="email" /></Field>
                <Field label={t("Phone number")}><TextInput {...input("phone")} type="tel" autoComplete="tel" /></Field>
                <Field label={t("LinkedIn or your website")} hint={t("You can leave this empty.")} className="sm:col-span-2"><TextInput {...input("link")} inputMode="url" /></Field>
              </div>
            </>
          ) : null}

          {current.id === "goal" ? (
            <>
              <Field label={t("Job title")} hint={t("It goes at the top of your CV, right under your name. You can leave it empty.")}><TextInput {...input("headline")} autoFocus /></Field>
              <div>
                <p className="mb-2 text-[13px] text-faint">{t("Examples (click to use):")}</p>
                <div className="flex flex-wrap gap-2">
                  {HEADLINE_EXAMPLES.map((example) => <Button key={example} size="sm" onClick={() => set("headline", t(example))}>{t(example)}</Button>)}
                </div>
              </div>
            </>
          ) : null}

          {current.id === "jobs" ? (
            <>
              <p className="text-sm text-muted">{t("Start with your latest job. No work experience yet? Just press Next.")}</p>
              {a.jobs.map((job, i) => (
                <fieldset key={i} className="space-y-3 rounded-tool border border-line p-4" data-cv-wizard-job={i}>
                  <legend className="px-1 text-sm font-semibold text-ink">{t("Job {n}", { n: i + 1 })}</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t("Company or employer")}><TextInput value={job.org} onChange={(e) => setJob(i, { org: e.target.value })} /></Field>
                    <Field label={t("Your position")}><TextInput value={job.role} onChange={(e) => setJob(i, { role: e.target.value })} /></Field>
                    <Field label={t("Started")} hint={dateHint(job.start)}><TextInput value={job.start} onChange={(e) => setJob(i, { start: e.target.value })} /></Field>
                    {job.current ? null : <Field label={t("Finished")} hint={dateHint(job.end)}><TextInput value={job.end} onChange={(e) => setJob(i, { end: e.target.value })} /></Field>}
                  </div>
                  <label className="flex items-center gap-2 text-sm text-muted">
                    <input type="checkbox" className="h-4 w-4 accent-[var(--c-accent)]" checked={job.current} onChange={(e) => setJob(i, { current: e.target.checked })} />
                    {t("I still work here")}
                  </label>
                  <Field label={t("What did you do there?")} hint={t("One thing per line. Numbers help, for example: Served 50 customers a day.")}><TextArea rows={4} value={job.duties} onChange={(e) => setJob(i, { duties: e.target.value })} /></Field>
                  {a.jobs.length > 1 ? <Button size="sm" onClick={() => set("jobs", a.jobs.filter((_, n) => n !== i))}>{t("Remove this job")}</Button> : null}
                </fieldset>
              ))}
              <Button onClick={() => set("jobs", [...a.jobs, { ...EMPTY_JOB }])}>{t("Add another job")}</Button>
            </>
          ) : null}

          {current.id === "schools" ? (
            <>
              <p className="text-sm text-muted">{t("Your highest school is enough. You can skip this step too.")}</p>
              {a.schools.map((school, i) => (
                <fieldset key={i} className="space-y-3 rounded-tool border border-line p-4">
                  <legend className="px-1 text-sm font-semibold text-ink">{t("School {n}", { n: i + 1 })}</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t("School or university")}><TextInput value={school.institution} onChange={(e) => setSchool(i, { institution: e.target.value })} /></Field>
                    <Field label={t("Field of study or degree")} hint={t("You can leave this empty.")}><TextInput value={school.detail} onChange={(e) => setSchool(i, { detail: e.target.value })} /></Field>
                    <Field label={t("Started")} hint={dateHint(school.start)}><TextInput value={school.start} onChange={(e) => setSchool(i, { start: e.target.value })} /></Field>
                    <Field label={t("Finished")} hint={dateHint(school.end)}><TextInput value={school.end} onChange={(e) => setSchool(i, { end: e.target.value })} /></Field>
                  </div>
                  {a.schools.length > 1 ? <Button size="sm" onClick={() => set("schools", a.schools.filter((_, n) => n !== i))}>{t("Remove this school")}</Button> : null}
                </fieldset>
              ))}
              <Button onClick={() => set("schools", [...a.schools, { ...EMPTY_SCHOOL }])}>{t("Add another school")}</Button>
            </>
          ) : null}

          {current.id === "skills" ? (
            <>
              <Field label={t("Your skills")} hint={t("Separate them with commas. For example: Excel, customer service, driving licence B")}><TextArea rows={3} value={a.skills} onChange={(e) => set("skills", e.target.value)} autoFocus /></Field>
              <div className="space-y-2">
                <p className="text-sm font-medium text-ink">{t("Languages you speak")}</p>
                {a.languages.map((item, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-2">
                    <Field label={t("Language")} className="min-w-40 flex-1"><TextInput value={item.name} onChange={(e) => set("languages", a.languages.map((x, n) => (n === i ? { ...x, name: e.target.value } : x)))} /></Field>
                    <Field label={t("Level")} className="w-36">
                      <Select value={item.level} onChange={(e) => set("languages", a.languages.map((x, n) => (n === i ? { ...x, level: e.target.value } : x)))}>
                        <option value="">{t("Choose")}</option>
                        {LEVELS.map((level) => <option key={level} value={t(level)}>{t(level)}</option>)}
                      </Select>
                    </Field>
                    <Button onClick={() => set("languages", a.languages.filter((_, n) => n !== i))}>{t("Remove")}</Button>
                  </div>
                ))}
                <Button onClick={() => set("languages", [...a.languages, { name: "", level: "" }])}>{t("Add a language")}</Button>
              </div>
            </>
          ) : null}

          {current.id === "about" ? (
            <>
              <p className="text-sm text-muted">{t("Two or three sentences at the top of your CV: what you do, what you are good at, what you are looking for. You can skip this.")}</p>
              <TextArea rows={5} aria-label={t("A few words about you")} value={a.summary} onChange={(e) => set("summary", e.target.value)} autoFocus />
              {suggestSummary(a) ? <Button onClick={() => set("summary", suggestSummary(a))}>{t("Write it for me from my answers")}</Button> : null}
            </>
          ) : null}

          {current.id === "review" ? (
            <>
              <dl>
                <Row label={t("Name")} value={a.name} empty={t("not filled in")} />
                <Row label={t("Contact")} value={[a.email, a.phone, a.city, a.link].filter(Boolean).join("\n")} empty={t("not filled in")} />
                <Row label={t("Job title")} value={a.headline} empty={t("not filled in")} />
                <Row label={t("Your work")} value={a.jobs.filter((job) => job.org || job.role).map((job) => [job.role, job.org].filter(Boolean).join(", ")).join("\n")} empty={t("not filled in")} />
                <Row label={t("Your education")} value={a.schools.filter((school) => school.institution).map((school) => school.institution).join("\n")} empty={t("not filled in")} />
                <Row label={t("Your skills")} value={a.skills} empty={t("not filled in")} />
                <Row label={t("Languages you speak")} value={a.languages.filter((item) => item.name).map((item) => [item.name, item.level].filter(Boolean).join(" ")).join("\n")} empty={t("not filled in")} />
                <Row label={t("A few words about you")} value={a.summary} empty={t("not filled in")} />
              </dl>
              <label className="flex items-start gap-2 text-sm text-muted">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--c-accent)]" checked={a.consent} onChange={(e) => set("consent", e.target.checked)} />
                <span>{t("Add the data-processing consent line at the bottom. Most Polish employers expect it.")}</span>
              </label>
              {[...a.jobs.flatMap((job) => [job.start, job.current ? "" : job.end]), ...a.schools.flatMap((school) => [school.start, school.end])].some(monthProblem) ? (
                <Notice tone="warn">{t("One of the dates can't be read, so it will be left out. You can go back and fix it.")}</Notice>
              ) : null}
              {error ? <Notice tone="error">{error}</Notice> : null}
            </>
          ) : null}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          {step > 0 ? <Button size="lg" onClick={() => go(step - 1)}>{t("Back")}</Button> : <Button size="lg" onClick={onCancel}>{t("Back")}</Button>}
          {current.id === "review" ? (
            <Button size="lg" variant="primary" disabled={busy || !a.name.trim()} onClick={() => void create()} data-cv-wizard-create>{busy ? t("Creating your CV…") : t("Create my CV")}</Button>
          ) : (
            <Button size="lg" variant="primary" disabled={!canGoOn} onClick={() => go(step + 1)} data-cv-wizard-next>{t("Next")}</Button>
          )}
          <span className="text-[13px] text-faint">{t("What you write is saved in your account until you finish, so you can stop and come back, even on another computer.")}</span>
        </div>
      </Panel>

      {sourceText ? (
        <Panel title={t("Your CV text, to copy from")}>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{sourceText}</pre>
        </Panel>
      ) : null}
    </div>
  );
}
