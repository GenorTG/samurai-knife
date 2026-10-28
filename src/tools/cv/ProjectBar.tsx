"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, Drawer, Field, Notice, Select, TextInput } from "@/components/ui";
import { createProject, deleteProject, errorText, renameProject, switchProject, type CvProjectInfo } from "@/lib/cv/client";
import { msg } from "@/lib/i18n/msg";
import { useT } from "@/lib/i18n/react";
import { announceProjectChange, CV_PROJECT_EVENT, setShownProject } from "@/lib/cv/shown-project";


/** What each CV studio tab is for, in a few plain words (shown under "How this works"). */
const HOW: Record<string, string[]> = {
  profile: [
    msg("Your master CV: every job, project, skill and school once, in Polish and English. Nothing here is sent anywhere."),
    msg("Click any text to edit it. The assistant can fill it in for you; you see each change and can undo it."),
    msg("Tailored CVs for job offers are made from this profile in CV versions; keep the facts complete here."),
  ],
  jobs: [
    msg("Save the job offers you are interested in: paste a link (justjoin.it, nofluffjobs.com read best) or the posting text."),
    msg("Each offer shows what it asks for and how your profile matches; “Tailor with the assistant” makes a CV version for it."),
  ],
  variants: [
    msg("A CV version is a copy of your profile fitted to one offer or one purpose: which jobs, bullets and projects it shows, in which order and language."),
    msg("Pick a layout, check it against the offer (ATS check), then download it as a document or print it to PDF."),
  ],
  applications: [
    msg("Track where you applied, when, with which CV version, and what to do next. Overdue follow-ups are marked."),
  ],
  showcase: [
    msg("Find which of your GitHub projects are worth showing, and add them to your profile with facts read from the repository."),
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
 * Top of every CV studio tab: which CV project the tab shows (switch, create, rename, duplicate, delete) and a short
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
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t("CV project")} className="min-w-52 flex-1 sm:max-w-sm">
          <Select value={state?.active ?? ""} disabled={!state} onChange={(event) => void choose(event.target.value)} aria-label={t("CV project")}>
            {(state?.projects ?? []).map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </Select>
        </Field>
        <Button onClick={() => setManage(true)} disabled={!state}>{t("Manage CV projects")}</Button>
      </div>
      {state && state.projects.length === 1 ? (
        <p className="text-xs text-muted">{t("Need a CV for someone else, or a separate one for another kind of job? Add another CV project; each has its own profile, versions, offers, photo and website.")}</p>
      ) : null}
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
    <Drawer open={open} onClose={onClose} title={t("CV projects")}>
      <p className="text-sm text-muted">{t("Each CV project is a separate CV with its own profile, versions, job offers, applications, photo and website. Use one per person, or one per kind of job.")}</p>
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
        <Field label={t("New CV project")} hint={t("For example a person's name, or “Backend roles”.")}>
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
      <ul className="divide-y divide-line rounded-lg border border-line" aria-label={t("CV projects")}>
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
                  <TextInput aria-label={t("Project name")} value={rename.name} onChange={(event) => setRename({ id: project.id, name: event.target.value })} maxLength={80} className="min-w-40 flex-1" />
                  <Button size="sm" type="submit" variant="primary" disabled={busy || !rename.name.trim()}>{t("Save")}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setRename(null)}>{t("Cancel")}</Button>
                </form>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium text-ink">
                    {project.name}
                    {active ? <span className="ml-2 text-xs font-normal text-accent">{t("shown now")}</span> : null}
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
                  text={t("Delete “{name}” with its profile, versions, job offers, applications, photo and website connection? This cannot be undone.", { name: project.name })}
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
