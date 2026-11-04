"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, Drawer, Field, Notice, Select, TextInput } from "@/components/ui";
import { createProject, deleteProject, errorText, renameProject, switchProject, type CvProjectInfo } from "@/lib/cv/client";
import { msg } from "@/lib/i18n/msg";
import { useT } from "@/lib/i18n/react";
import { announceProjectChange, CV_PROJECT_EVENT, setShownProject } from "@/lib/cv/shown-project";


/** What each CV builder tab is for, in a few plain words (shown under "How this works"). */
const HOW: Record<string, string[]> = {
  profile: [
    msg("Everything about you in one place: every job, project, skill and school, in Polish and English. Nothing here goes to anyone unless you send it yourself or ask the AI assistant to work on it."),
    msg("Click any text to change it. If you have set up an AI model, the assistant can fill this in for you; you see each change and can undo it."),
    msg("CVs for particular job offers are made from these details in the Your CVs tab, so keep the facts complete here."),
  ],
  jobs: [
    msg("Save the job offers that interest you: paste a link (justjoin.it and nofluffjobs.com work best) or the text of the ad."),
    msg("Each offer shows what the employer asks for and how well your details match. From there you can make a CV for that job."),
  ],
  variants: [
    msg("A CV for a job is a copy of your details fitted to one offer or one purpose: which jobs, points and projects it shows, in which order and language."),
    msg("Pick a layout, compare it with the offer to see how well recruitment software can read it (ATS), then download it or print it to PDF."),
  ],
  applications: [
    msg("Keep track of where you applied, when, which CV you sent and what to do next. Anything overdue is marked."),
  ],
  showcase: [
    msg("For people with projects on GitHub: see which ones are worth showing, and add them to your details with facts read from GitHub. If you have none, skip this tab."),
  ],
  website: [
    msg("Optional, for people with their own website or portfolio: compare what the site says with this CV and fix what is out of date."),
    msg("A link to the site is enough for the check; connecting its GitHub repository also lets the assistant prepare changes for you to review."),
  ],
};

async function fetchProjects(): Promise<{ active: string; projects: CvProjectInfo[] } | null> {
  try {
    const res = await fetch("/api/cv/projects", { credentials: "same-origin", cache: "no-store" });
    const body = (await res.json()) as { active?: string; projects?: CvProjectInfo[] };
    return res.ok && body.active && body.projects ? { active: body.active, projects: body.projects } : null;
  } catch {
    return null;
  }
}

/**
 * Top of every CV builder tab: which CV project the tab shows (switch, create, rename, duplicate, delete) and a short
 * "How this works" for the tab. Projects are separate CVs on one account (docs/CV-STUDIO.md "Projects").
 */
export function ProjectBar({ tab }: { tab: string }) {
  const { t } = useT();
  const [state, setState] = useState<{ active: string; projects: CvProjectInfo[] } | null>(null);
  const [manage, setManage] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const next = await fetchProjects();
    if (!next) return;
    // The page follows the active project (also when the assistant or another tab switched it).
    setShownProject(next.active);
    setState(next);
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 4000);
    window.addEventListener(CV_PROJECT_EVENT, refresh);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      window.removeEventListener(CV_PROJECT_EVENT, refresh);
    };
  }, [refresh]);

  const choose = async (id: string) => {
    setError("");
    try {
      await switchProject(id);
      await refresh();
      announceProjectChange();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const how = HOW[tab] ?? [];
  const current = state?.projects.find((p) => p.id === state.active);
  return (
    <div className="mb-4 space-y-2" data-cv-project-bar>
      {state && state.projects.length > 1 ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t("Which CV")} className="min-w-52 flex-1 sm:max-w-sm">
            <Select value={state.active} onChange={(event) => void choose(event.target.value)} aria-label={t("Which CV")}>
              {state.projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </Select>
          </Field>
          <Button onClick={() => setManage(true)}>{t("Manage my CVs")}</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
          <span className="min-w-0 truncate" data-cv-only-project>{t("Your CV: {name}", { name: current?.name ?? "…" })}</span>
          <Button size="sm" variant="ghost" onClick={() => setManage(true)} disabled={!state}>{t("Manage my CVs")}</Button>
        </div>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {how.length ? (
        <details className="group rounded-lg border border-line bg-raised/40 px-3 py-2 text-[13px] text-muted" data-cv-how={tab}>
          <summary className="cursor-pointer font-medium text-ink select-none">{t("How this works")}</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {how.map((line) => <li key={line}>{t(line)}</li>)}
          </ul>
        </details>
      ) : null}
      <ProjectsDrawer
        open={manage}
        onClose={() => setManage(false)}
        state={state}
        current={current}
        onChanged={async () => {
          await refresh();
          announceProjectChange();
        }}
      />
    </div>
  );
}

function ProjectsDrawer({ open, onClose, state, current, onChanged }: {
  open: boolean;
  onClose: () => void;
  state: { active: string; projects: CvProjectInfo[] } | null;
  current: CvProjectInfo | undefined;
  onChanged: () => Promise<void>;
}) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title={t("My CVs")}>
      <p className="text-sm text-muted">{t("Each CV here is completely separate, with its own details, CVs for a job, job offers, applications, photo and website. Keep one for each person, or one for each line of work.")}</p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          void run(async () => {
            await createProject(name.trim());
            setName("");
          });
        }}
      >
        <Field label={t("New CV")} hint={t("For example a person's name, or “Sales jobs”.")}>
          <TextInput value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder={t("Name")} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{t("Create empty")}</Button>
          {current ? (
            <Button disabled={busy || !name.trim()} onClick={() => void run(async () => {
              await createProject(name.trim(), current.id);
              setName("");
            })}>
              {t("Create as a copy of “{name}”", { name: current.name })}
            </Button>
          ) : null}
        </div>
      </form>
      <ul className="divide-y divide-line rounded-lg border border-line" aria-label={t("My CVs")}>
        {(state?.projects ?? []).map((project) => {
          const active = project.id === state?.active;
          return (
            <li key={project.id} className="space-y-2 px-3 py-2.5" data-cv-project={project.id}>
              {rename?.id === project.id ? (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      await renameProject(project.id, rename.name);
                      setRename(null);
                    });
                  }}
                >
                  <TextInput aria-label={t("CV name")} value={rename.name} onChange={(event) => setRename({ id: project.id, name: event.target.value })} maxLength={80} className="min-w-40 flex-1" />
                  <Button size="sm" type="submit" variant="primary" disabled={busy || !rename.name.trim()}>{t("Save")}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setRename(null)}>{t("Cancel")}</Button>
                </form>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium text-ink">
                    {project.name}
                    {active ? <span className="ml-2 text-xs font-normal text-accent">{t("open now")}</span> : null}
                  </span>
                  <span className="flex flex-wrap gap-1.5">
                    {!active ? <Button size="sm" disabled={busy} onClick={() => void run(() => switchProject(project.id))}>{t("Open")}</Button> : null}
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRename({ id: project.id, name: project.name })}>{t("Rename")}</Button>
                    {(state?.projects.length ?? 0) > 1 ? (
                      <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirmDelete(project.id)}>{t("Delete")}</Button>
                    ) : null}
                  </span>
                </div>
              )}
              {confirmDelete === project.id ? (
                <ConfirmRow
                  text={t("Delete “{name}” with its details, CVs for a job, job offers, applications, photo and website connection? This cannot be undone.", { name: project.name })}
                  onCancel={() => setConfirmDelete(null)}
                  onConfirm={() => void run(async () => {
                    await deleteProject(project.id);
                    setConfirmDelete(null);
                  })}
                  busy={busy}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </Drawer>
  );
}

function ConfirmRow({ text, onCancel, onConfirm, busy }: { text: ReactNode; onCancel: () => void; onConfirm: () => void; busy: boolean }) {
  const { t } = useT();
  return (
    <div className="space-y-2 rounded-md border border-danger/40 bg-danger/10 p-2.5 text-[13px] text-danger" role="alert">
      <p>{text}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="danger" disabled={busy} onClick={onConfirm}>{t("Delete for good")}</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>{t("Keep it")}</Button>
      </div>
    </div>
  );
}
