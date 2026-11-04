"use client";

import { useState } from "react";
import { Button, Dropzone, Notice, Panel, TextArea } from "@/components/ui";
import { fileToBase64 } from "@/tools/sidecars/client";
import { openAssistant } from "@/lib/agent-client/bridge";
import { guessFromCvText, type WizardAnswers } from "@/lib/cv/wizard";
import { cx } from "@/lib/format";
import { useT } from "@/lib/i18n/react";
import { CvWizard } from "./CvWizard";
import { ProfileImport } from "./ProfileImport";

type Way = "upload" | "scratch" | "assistant";

interface FromFile {
  initial: Partial<WizardAnswers>;
  text: string;
}

/**
 * The first screen of an empty CV project (Your details tab): three ways in, explained in plain words. "Answer simple
 * questions" opens the step-by-step wizard (CvWizard); "I already have a CV" reads an uploaded PDF/DOCX/ODT/TXT on the
 * server and fills in what it can without AI before the same wizard; the assistant's interview needs an AI model.
 */
export function StartHere({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  const [way, setWay] = useState<Way | null>(null);
  const [fromFile, setFromFile] = useState<FromFile | null>(null);
  if (way === "scratch" || fromFile) {
    return (
      <div data-cv-start-here>
        <CvWizard
          initial={fromFile?.initial}
          sourceText={fromFile?.text}
          onDone={onDone}
          onCancel={() => {
            setFromFile(null);
            setWay(fromFile ? "upload" : null);
          }}
        />
      </div>
    );
  }
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
      <Panel title={t("Let's make your CV")}>
        <p className="mb-3 text-sm text-muted">
          {t("How would you like to start? Whichever you choose, you end up with a ready CV to download as PDF or Word, and you can change it at any time.")}
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          {card("scratch", t("Answer simple questions"), t("Recommended. One topic at a time, with examples. It takes about ten minutes."))}
          {card("upload", t("I already have a CV"), t("Bring in the file you have, and we help you put it into the new layout."))}
          {card("assistant", t("Talk to the AI assistant"), t("It asks about your work and writes as you answer. It needs an AI model set up in your account."))}
        </div>
      </Panel>
      {way === "upload" ? <CvStartUpload onDone={onDone} onFill={setFromFile} /> : null}
      {way === "assistant" ? <Interview /> : null}
    </div>
  );
}

/** Bring in an existing CV: upload the file (its text is read server-side), or paste the text; the assistant structures it. */
export function CvStartUpload({ onDone, onFill }: { onDone: () => void; onFill?: (from: FromFile) => void }) {
  const { t, m } = useT();
  const [text, setText] = useState("");
  const [reading, setReading] = useState("");
  const [fileNote, setFileNote] = useState<{ tone: "good" | "error"; text: string } | null>(null);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setFileNote(null);
    setReading(file.name);
    try {
      const data = await fileToBase64(file);
      const res = await fetch("/api/cv/import/extract", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ name: file.name, data }) });
      const body = (await res.json().catch(() => ({}))) as { text?: string; truncated?: boolean; error?: string };
      if (!res.ok || !body.text) throw new Error(body.error || t("The file could not be read."));
      setText(body.text);
      setFileNote({ tone: "good", text: body.truncated ? t("Read {name} (shortened: the file is very long). Check the text below, then continue.", { name: file.name }) : t("Read {name}. Check the text below, then continue.", { name: file.name }) });
    } catch (e) {
      setFileNote({ tone: "error", text: m(e instanceof Error ? e.message : String(e)) });
    } finally {
      setReading("");
    }
  };
  return (
    <div className="space-y-4">
      <Panel title={t("Choose your CV file")}>
        <Dropzone
          accept=".pdf,.docx,.odt,.txt,.md,application/pdf"
          disabled={Boolean(reading)}
          hint={reading ? t("Reading {name}…", { name: reading }) : t("PDF, Word (DOCX), OpenDocument (ODT) or text, up to 8 MB. Only its text is read; the file is not stored.")}
          onFiles={(files) => void upload(files[0])}
        />
        {reading ? <p role="status" className="mt-2 text-[13px] text-muted">{t("Reading {name}…", { name: reading })}</p> : null}
        {fileNote ? <div className="mt-2"><Notice tone={fileNote.tone}>{fileNote.text}</Notice></div> : null}
      </Panel>
      <Panel title={t("Your CV text")}>
        <p className="mb-2 text-[13px] text-muted">{t("The text from your file appears here; you can also paste it from Word, a PDF or LinkedIn. Press Continue and we fill in what we can recognise, with your text next to the questions. If you have an AI model set up, the assistant can sort everything in for you.")}</p>
        <TextArea value={text} onChange={(e) => setText(e.target.value)} rows={8} placeholder={t("Paste the whole CV here…")} aria-label={t("CV text")} />
        <div className="mt-2 flex flex-wrap gap-2">
          {onFill ? (
            <Button variant="primary" disabled={!text.trim()} data-cv-fill-wizard onClick={() => onFill({ initial: guessFromCvText(text), text })}>
              {t("Continue with this text")}
            </Button>
          ) : null}
          <Button
            variant={onFill ? "subtle" : "primary"}
            disabled={!text.trim()}
            onClick={() =>
              openAssistant(
                `Structure this CV into my CV builder profile (the active CV project) with knife_cv_import, copying every fact exactly as written and leaving the other language empty; then translate the empty language with knife_cv_patch. Ask me about anything unclear instead of guessing.\n\n${text.trim()}`,
              )
            }
          >
            {t("Let the AI assistant sort it in")}
          </Button>
        </div>
      </Panel>
      <details className="rounded-tool border border-line bg-surface p-3 text-sm text-muted">
        <summary className="cursor-pointer">{t("For advanced users: import your details as JSON")}</summary>
        <div className="mt-3">
          <ProfileImport existing={null} onImported={onDone} />
        </div>
      </details>
    </div>
  );
}

function Interview() {
  const { t } = useT();
  return (
    <Panel title={t("Interview with the assistant")}>
      <p className="mb-3 text-sm text-muted">{t("The assistant asks one thing at a time (your jobs, what you achieved, skills, education) and saves the answers into this CV. It never makes facts up; you can undo every change.")}</p>
      <Button
        variant="primary"
        onClick={() =>
          openAssistant(
            "Interview me to build my CV in the CV builder (the active CV project). Ask one short question at a time: my name and contact, the role I want, then each job (company, role, dates, what I did with results), projects, skills, education and languages. After each answer, save it with the knife_cv_* tools (load_tools cv first if needed). Never invent facts; ask when something is unclear. Start now.",
          )
        }
      >
        {t("Start the interview")}
      </Button>
    </Panel>
  );
}
