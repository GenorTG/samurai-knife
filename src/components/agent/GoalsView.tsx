"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n/react";

type GoalStep = { id: string; title: string; status: "pending" | "in_progress" | "completed" };
type Goal = {
  id: string; title: string; objective: string; project: string;
  status: "active" | "paused" | "completed" | "archived"; nextAction: string;
  steps: GoalStep[]; events: Array<{ id: string; at: string; text: string }>;
  createdAt: string; updatedAt: string;
};

/** What to do next: the saved next action, else the first step not done yet. */
function nextStep(goal: Goal): string {
  return goal.nextAction || goal.steps.find((step) => step.status !== "completed")?.title || "";
}

const inputClass = "sk-input w-full px-3 py-2 text-sm";
const buttonClass = "cursor-pointer rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs text-ink hover:bg-raised disabled:opacity-50";

export function GoalsView({ onContinue }: { onContinue: (goalId: string, goalTitle: string) => void }) {
  const { t } = useT();
  const statusLabel = (status: Goal["status"]) => status === "active" ? t("Active") : status === "paused" ? t("Paused") : status === "completed" ? t("Completed") : t("Archived");
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState({ title: "", objective: "", project: "", steps: "", nextAction: "" });
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState({ title: "", objective: "", project: "", nextAction: "", steps: "" });

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/agent/goals", { cache: "no-store" });
      const data = await response.json() as { goals?: Goal[]; error?: string };
      if (!response.ok) throw new Error(data.error || t("Could not load goals."));
      setGoals(data.goals ?? []);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not load goals."));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  async function submit(action: Record<string, unknown>) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/agent/goals", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || t("Could not save the goal."));
      await refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not save the goal."));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await submit({
      action: "create", ...draft,
      steps: draft.steps.split("\n").map((line) => line.trim()).filter(Boolean),
    });
    if (ok) setDraft({ title: "", objective: "", project: "", steps: "", nextAction: "" });
  }

  function beginEdit(goal: Goal) {
    setEditing(goal.id);
    setEdit({ title: goal.title, objective: goal.objective, project: goal.project, nextAction: goal.nextAction, steps: goal.steps.map((step) => step.title).join("\n") });
  }

  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-3" aria-label={t("Tasks")}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">{t("Tasks")}</h3>
          <p className="mt-1 text-xs text-muted">{t("Saved to your account. Progress stays available across chats and providers.")}</p>
        </div>
        <button type="button" onClick={() => void refresh()} className={buttonClass}>{t("Refresh")}</button>
      </div>

      {error ? <p role="alert" className="mb-3 rounded-lg border border-danger/30 bg-danger/5 p-2 text-xs text-danger">{error}</p> : null}
      {loading ? <p className="py-4 text-sm text-muted">{t("Loading…")}</p> : null}

      <div className="space-y-3">
        {goals.map((goal) => (
          <article key={goal.id} className="rounded-xl border border-line bg-surface p-3">
            {editing === goal.id ? (
              <div className="space-y-2">
                <input className={inputClass} aria-label={t("Task title")} value={edit.title} onChange={(event) => setEdit({ ...edit, title: event.currentTarget.value })} />
                <textarea className={inputClass} aria-label={t("Objective")} rows={3} value={edit.objective} onChange={(event) => setEdit({ ...edit, objective: event.currentTarget.value })} />
                <input className={inputClass} aria-label={t("Project or website")} placeholder={t("Project or website")} value={edit.project} onChange={(event) => setEdit({ ...edit, project: event.currentTarget.value })} />
                <input className={inputClass} aria-label={t("Next action")} placeholder={t("Next action")} value={edit.nextAction} onChange={(event) => setEdit({ ...edit, nextAction: event.currentTarget.value })} />
                <textarea className={inputClass} aria-label={t("Steps (one per line)")} rows={3} value={edit.steps} onChange={(event) => setEdit({ ...edit, steps: event.currentTarget.value })} />
                <div className="flex gap-2">
                  <button type="button" className={buttonClass} disabled={saving} onClick={async () => {
                    const steps = edit.steps.split("\n").map((line) => line.trim()).filter(Boolean).map((title) => {
                      const existing = goal.steps.find((step) => step.title === title);
                      return { title, ...(existing ? { id: existing.id, status: existing.status } : { status: "pending" as const }) };
                    });
                    if (await submit({ action: "update", id: goal.id, title: edit.title, objective: edit.objective, project: edit.project, nextAction: edit.nextAction, steps })) setEditing(null);
                  }}>{t("Save")}</button>
                  <button type="button" className={buttonClass} onClick={() => setEditing(null)}>{t("Cancel")}</button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="text-sm font-semibold text-ink">{goal.title}</h4>
                    {goal.project ? <p className="mt-0.5 text-[11px] text-faint">{goal.project}</p> : null}
                  </div>
                  <span className="shrink-0 rounded-full bg-raised px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted">{statusLabel(goal.status)}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted">{goal.objective}</p>
                {goal.steps.length ? <p className="mt-2 text-[11px] text-faint" data-goal-progress>{t("{done} of {total} steps done", { done: goal.steps.filter((step) => step.status === "completed").length, total: goal.steps.length })}</p> : null}
                {nextStep(goal) ? <p className="mt-2 rounded-lg bg-raised/60 px-2.5 py-2 text-xs text-ink" data-goal-next><strong>{t("Next:")}</strong> {nextStep(goal)}</p> : null}
                {goal.steps.length ? <ol className="mt-3 space-y-1.5">
                  {goal.steps.map((step) => <li key={step.id} className="flex items-center gap-2 text-xs text-muted"><span aria-hidden="true" className={step.status === "completed" ? "text-good" : step.status === "in_progress" ? "text-ai" : "text-faint"}>{step.status === "completed" ? "✓" : step.status === "in_progress" ? "◉" : "○"}</span><span>{step.title}</span></li>)}
                </ol> : null}
                <details className="mt-3 text-xs text-muted">
                  <summary className="cursor-pointer">{t("Checkpoint history ({count})", { count: goal.events.length })}</summary>
                  <ul className="mt-2 space-y-2 border-l border-line pl-3">
                    {goal.events.slice().reverse().map((event) => <li key={event.id}><time className="mr-1 text-faint">{new Date(event.at).toLocaleString()}</time>{event.text}</li>)}
                  </ul>
                </details>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className={buttonClass} onClick={() => beginEdit(goal)}>{t("Edit")}</button>
                  {goal.status === "active" || goal.status === "paused" ? <button type="button" className={buttonClass} onClick={() => onContinue(goal.id, goal.title)}>{t("Continue with assistant")}</button> : null}
                  {goal.status === "active" ? <button type="button" className={buttonClass} disabled={saving} onClick={() => void submit({ action: "update", id: goal.id, status: "paused" })}>{t("Pause")}</button> : null}
                  {goal.status === "paused" ? <button type="button" className={buttonClass} disabled={saving} onClick={() => void submit({ action: "update", id: goal.id, status: "active" })}>{t("Resume")}</button> : null}
                  {goal.status !== "completed" && goal.status !== "archived" ? <button type="button" className={buttonClass} disabled={saving} onClick={() => void submit({ action: "update", id: goal.id, status: "completed" })}>{t("Complete")}</button> : null}
                  {goal.status === "completed" || goal.status === "archived" ? <button type="button" className={buttonClass} disabled={saving} onClick={() => { if (window.confirm(t("Delete the task \"{title}\" and its history?", { title: goal.title }))) void submit({ action: "delete", id: goal.id }); }}>{t("Delete")}</button> : null}
                </div>
              </>
            )}
          </article>
        ))}
        {!loading && goals.length === 0 ? <p className="rounded-xl border border-dashed border-line-strong p-4 text-center text-xs text-muted">{t("No saved tasks yet. Create one here, or ask the assistant to track a project.")}</p> : null}
      </div>

      <form onSubmit={(event) => void create(event)} className="mt-4 space-y-2 rounded-xl border border-line-strong bg-surface p-3">
        <h4 className="text-sm font-semibold text-ink">{t("New task")}</h4>
        <input required maxLength={160} className={inputClass} aria-label={t("Task title")} placeholder={t("Task title")} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })} />
        <textarea required maxLength={4000} rows={3} className={inputClass} aria-label={t("Objective")} placeholder={t("What does done look like?")} value={draft.objective} onChange={(event) => setDraft({ ...draft, objective: event.currentTarget.value })} />
        <input maxLength={160} className={inputClass} aria-label={t("Project or website")} placeholder={t("Project or website")} value={draft.project} onChange={(event) => setDraft({ ...draft, project: event.currentTarget.value })} />
        <textarea rows={3} className={inputClass} aria-label={t("Steps (one per line)")} placeholder={t("Steps (one per line)")} value={draft.steps} onChange={(event) => setDraft({ ...draft, steps: event.currentTarget.value })} />
        <input maxLength={1000} className={inputClass} aria-label={t("Next action")} placeholder={t("Next action")} value={draft.nextAction} onChange={(event) => setDraft({ ...draft, nextAction: event.currentTarget.value })} />
        <button disabled={saving} className="w-full cursor-pointer rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg disabled:opacity-50">{saving ? t("Saving…") : t("Save task")}</button>
      </form>
    </section>
  );
}
