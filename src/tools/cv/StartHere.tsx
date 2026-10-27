"use client";

import { useState } from "react";
import { Button, Field, Notice, Panel, TextArea, TextInput } from "@/components/ui";
import { openAssistant } from "@/lib/agent-client/bridge";
import { errorText, importCv } from "@/lib/cv/client";
import { cx } from "@/lib/format";
import { useT } from "@/lib/i18n/react";
import { ProfileImport } from "./ProfileImport";

type Way = "upload" | "scratch" | "assistant";

/**
 * The first screen of an empty CV project (Profile tab): three ways in, explained in plain words. "Upload" is
 * `CvStartUpload` (the file upload + parsing step plugs in there); "From scratch" is a short form that writes a first
 * profile; "Interview" hands over to the assistant.
 */
export function StartHere({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  const [way, setWay] = useState<Way | null>(null);
  const card = (id: Way, title: string, text: string) => (
    <button
      type="button"
      autoComplete="off"
      aria-pressed={way === id}
      onClick={() => setWay(id)}
      data-cv-start={id}
      className={cx("rounded-xl border p-4 text-left transition-colors", way === id ? "border-accent bg-accent/10" : "border-line bg-surface hover:border-line-strong")}
    >
      <span className="block text-[15px] font-semibold text-ink">{title}</span>
      <span className="mt-1.5 block text-[13px] leading-relaxed text-muted">{text}</span>
    </button>
  );
  return (
    <div className="space-y-4" data-cv-start-here>
      <Panel title={t("Start here")}>
        <p className="mb-3 text-sm text-muted">
          {t("This CV project is empty. Its profile is the master copy of your CV: everything you have done, once, in Polish and English. Tailored versions for job offers and the documents you send are made from it later. Pick how to begin:")}
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          {card("upload", t("Use my existing CV"), t("Bring in the CV you already have, then fix what needs fixing."))}
          {card("scratch", t("Build one from scratch"), t("Answer a few short questions; add the rest in the profile afterwards."))}
          {card("assistant", t("Let the assistant interview me"), t("Chat with the assistant: it asks about your work and fills the profile in as you go."))}
        </div>
      </Panel>
      {way === "upload" ? <CvStartUpload onDone={onDone} /> : null}
      {way === "scratch" ? <FromScratch onDone={onDone} /> : null}
      {way === "assistant" ? <Interview /> : null}
    </div>
  );
}

/** Bring in an existing CV. Today: a structured (JSON) profile, or the assistant structures pasted CV text. */
export function CvStartUpload({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  const [text, setText] = useState("");
  return (
    <div className="space-y-4">
      <Panel title={t("Paste your CV text")}>
        <p className="mb-2 text-[13px] text-muted">{t("Copy the text of your CV (from Word, a PDF or LinkedIn) and paste it here. The assistant sorts it into the profile; nothing is invented, and anything unclear is asked.")}</p>
        <TextArea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder={t("Paste the whole CV here…")} aria-label={t("CV text")} />
        <div className="mt-2">
          <Button
            variant="primary"
            disabled={!text.trim()}
            onClick={() =>
              openAssistant(
                `Structure this CV into my CV studio profile (the active CV project) with knife_cv_import, copying every fact exactly as written and leaving the other language empty; then translate the empty language with knife_cv_patch. Ask me about anything unclear instead of guessing.\n\n${text.trim()}`,
              )
            }
          >
            {t("Sort it in with the assistant")}
          </Button>
        </div>
      </Panel>
      <ProfileImport existing={null} onImported={onDone} />
    </div>
  );
}

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function FromScratch({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  const [lang, setLang] = useState<"pl" | "en">("pl");
  const [f, setF] = useState({ name: "", email: "", phone: "", location: "", link: "", headline: "", summary: "", org: "", role: "", start: "", end: "", bullets: "", skills: "", school: "", degree: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (key: keyof typeof f) => (event: { target: { value: string } }) => setF((v) => ({ ...v, [key]: event.target.value }));
  const bi = (text: string) => ({ pl: lang === "pl" ? text.trim() : "", en: lang === "en" ? text.trim() : "" });

  const submit = async () => {
    setBusy(true);
    setError("");
    const bullets = f.bullets.split("\n").map((line) => line.replace(/^[-•*]\s*/, "").trim()).filter(Boolean);
    const skills = f.skills.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    const link = f.link.trim();
    const profile = {
      contact: {
        name: f.name.trim(),
        headline: bi(f.headline),
        location: bi(f.location),
        email: f.email.trim(),
        phone: f.phone.trim(),
        links: link ? [{ label: link.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""), url: /^https?:\/\//.test(link) ? link : `https://${link}` }] : [],
      },
      summary: bi(f.summary),
      experience: f.org.trim()
        ? [{ id: newId("job"), org: f.org.trim(), role: bi(f.role), start: f.start.trim(), end: f.end.trim() || null, bullets: bullets.map((text) => ({ id: newId("b"), text: bi(text) })) }]
        : [],
      skills: skills.length ? [{ id: "skills", name: { pl: "Umiejętności", en: "Skills" }, items: skills }] : [],
      education: f.school.trim() ? [{ id: newId("edu"), institution: f.school.trim(), detail: bi(f.degree) }] : [],
    };
    try {
      await importCv(profile, false);
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={t("Build your CV from scratch")}>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label={t("Language you are writing in")}>
          <span className="flex gap-2">
            <Button size="sm" variant={lang === "pl" ? "primary" : "subtle"} aria-pressed={lang === "pl"} onClick={() => setLang("pl")}>Polski</Button>
            <Button size="sm" variant={lang === "en" ? "primary" : "subtle"} aria-pressed={lang === "en"} onClick={() => setLang("en")}>English</Button>
          </span>
        </Field>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-1 text-sm font-semibold text-ink">{t("1. You")}</legend>
          <Field label={t("Full name")}><TextInput value={f.name} onChange={set("name")} autoComplete="name" required /></Field>
          <Field label={t("Job title you want to be seen as")} hint={t("e.g. Backend developer, Marketing specialist")}><TextInput value={f.headline} onChange={set("headline")} /></Field>
          <Field label={t("Email")}><TextInput value={f.email} onChange={set("email")} type="email" autoComplete="email" /></Field>
          <Field label={t("Phone")}><TextInput value={f.phone} onChange={set("phone")} type="tel" autoComplete="tel" /></Field>
          <Field label={t("City")}><TextInput value={f.location} onChange={set("location")} /></Field>
          <Field label={t("LinkedIn, GitHub or website (optional)")}><TextInput value={f.link} onChange={set("link")} inputMode="url" /></Field>
        </fieldset>
        <Field label={t("2. A few sentences about you (optional)")} hint={t("What you do, what you are good at, what you are looking for.")}>
          <TextArea value={f.summary} onChange={set("summary")} rows={3} />
        </Field>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-1 text-sm font-semibold text-ink">{t("3. Your latest job (optional)")}</legend>
          <Field label={t("Company")}><TextInput value={f.org} onChange={set("org")} /></Field>
          <Field label={t("Your role")}><TextInput value={f.role} onChange={set("role")} /></Field>
          <Field label={t("From (YYYY-MM)")}><TextInput value={f.start} onChange={set("start")} placeholder="2022-03" pattern="\d{4}(-\d{2})?" /></Field>
          <Field label={t("To (YYYY-MM, empty = now)")}><TextInput value={f.end} onChange={set("end")} placeholder="" pattern="\d{4}(-\d{2})?" /></Field>
          <Field label={t("What you did there, one point per line")} className="sm:col-span-2"><TextArea value={f.bullets} onChange={set("bullets")} rows={4} /></Field>
        </fieldset>
        <Field label={t("4. Skills, separated by commas (optional)")}><TextInput value={f.skills} onChange={set("skills")} /></Field>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-1 text-sm font-semibold text-ink">{t("5. Education (optional)")}</legend>
          <Field label={t("School or university")}><TextInput value={f.school} onChange={set("school")} /></Field>
          <Field label={t("Degree or field")}><TextInput value={f.degree} onChange={set("degree")} /></Field>
        </fieldset>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={busy || !f.name.trim()}>{t("Create my CV")}</Button>
          <span className="text-[13px] text-muted">{t("You can add more jobs, projects and languages in the profile right after.")}</span>
        </div>
      </form>
    </Panel>
  );
}

function Interview() {
  const { t } = useT();
  return (
    <Panel title={t("Interview with the assistant")}>
      <p className="mb-3 text-sm text-muted">{t("The assistant asks one thing at a time (your roles, what you achieved, skills, education) and saves the answers into this CV project. It never makes facts up; you can undo every change.")}</p>
      <Button
        variant="primary"
        onClick={() =>
          openAssistant(
            "Interview me to build my CV in the CV studio (the active CV project). Ask one short question at a time: my name and contact, the role I want, then each job (company, role, dates, what I did with results), projects, skills, education and languages. After each answer, save it with the knife_cv_* tools (load_tools cv first if needed). Never invent facts; ask when something is unclear. Start now.",
          )
        }
      >
        {t("Start the interview")}
      </Button>
    </Panel>
  );
}
