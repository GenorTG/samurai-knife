"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { Badge, Button, Drawer, EmptyState, Field, Notice, Select, TextArea, TextInput } from "@/components/ui";
import { deleteApplication, errorText, saveApplication } from "@/lib/cv/client";
import { daysBetween, dueApplications, todayIso } from "@/lib/cv/collections";
import { APPLICATION_STATUSES, OPEN_STATUSES, type Application, type ApplicationStatus, type CvData } from "@/lib/cv/schema";
import { cx } from "@/lib/format";
import { CvFrame, externalUrl, SafeLink } from "./shared";
import { useCvData } from "./useCvData";
import { useT } from "@/lib/i18n/react";

const STATUS_LABEL: Record<ApplicationStatus, string> = {
  wishlist: "Wishlist", applied: "Applied", screening: "Screening", interview: "Interview", offer: "Offer",
  rejected: "Rejected", withdrawn: "Withdrawn", ghosted: "Ghosted",
};
const STATUS_TONE: Record<ApplicationStatus, "neutral" | "accent" | "good" | "warn" | "danger"> = {
  wishlist: "neutral", applied: "accent", screening: "accent", interview: "warn", offer: "good",
  rejected: "danger", withdrawn: "neutral", ghosted: "neutral",
};
const PIPELINE: ApplicationStatus[] = ["wishlist", "applied", "screening", "interview", "offer"];
const CLOSED: ApplicationStatus[] = ["rejected", "withdrawn", "ghosted"];
/** One click moves along the usual path; the exits are always offered too. */
const NEXT: Record<ApplicationStatus, ApplicationStatus[]> = {
  wishlist: ["applied", "withdrawn"],
  applied: ["screening", "rejected", "ghosted"],
  screening: ["interview", "rejected"],
  interview: ["offer", "rejected"],
  offer: ["withdrawn"],
  rejected: ["applied"],
  withdrawn: ["wishlist"],
  ghosted: ["applied"],
};

function hostOf(url: string): string {
  const safe = externalUrl(url);
  return safe ? new URL(safe).host : url;
}

interface Draft {
  id: string;
  company: string;
  role: string;
  status: ApplicationStatus;
  url: string;
  jobId: string;
  variantId: string;
  lang: "pl" | "en";
  nextAction: string;
  nextActionDue: string;
  appliedOn: string;
  notes: string;
  note: string;
}

function emptyDraft(): Draft {
  return { id: "", company: "", role: "", status: "wishlist", url: "", jobId: "", variantId: "", lang: "en", nextAction: "", nextActionDue: "", appliedOn: "", notes: "", note: "" };
}

function toDraft(a: Application): Draft {
  return { id: a.id, company: a.company, role: a.role, status: a.status, url: a.url, jobId: a.jobId ?? "", variantId: a.variantId ?? "", lang: a.lang, nextAction: a.nextAction, nextActionDue: a.nextActionDue ?? "", appliedOn: a.appliedOn ?? "", notes: a.notes, note: "" };
}

/** "today" / "1 day ago" / "12 days ago": how long an open application has been waiting. */
function waiting(appliedOn: string, today: string): string {
  const days = daysBetween(appliedOn, today);
  if (days <= 0) return "today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/* ------------------------------------------------------------------- card */

function AppCard({ app, data, today, onEdit, onMove, busy }: { app: Application; data: CvData; today: string; onEdit: () => void; onMove: (status: ApplicationStatus) => void; busy: boolean }) {
  const { t } = useT();
  const open = (OPEN_STATUSES as readonly ApplicationStatus[]).includes(app.status);
  const due = open && app.nextActionDue !== null && app.nextActionDue <= today;
  const job = app.jobId ? data.jobs.find((j) => j.id === app.jobId) : undefined;
  const variant = app.variantId ? data.variants.find((v) => v.id === app.variantId) : undefined;
  const last = app.history.at(-1);
  return (
    <article
      data-cv-path={`/applications/id=${app.id}`}
      data-due={due ? "true" : undefined}
      className={cx("min-w-0 rounded-xl border bg-surface p-3 shadow-xs", due ? "border-danger/60 bg-danger/5" : "border-line")}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink wrap-anywhere">{app.company}</h3>
          <p className="text-[13px] text-muted wrap-anywhere">{app.role}</p>
        </div>
        <Badge tone={STATUS_TONE[app.status]}>{STATUS_LABEL[app.status]}</Badge>
      </div>

      <dl className="mt-2 space-y-1 text-xs text-muted">
        {app.url ? <div className="flex gap-1.5"><dt className="text-faint">{t("Link")}</dt><dd className="min-w-0"><SafeLink href={app.url}>{hostOf(app.url)} ↗</SafeLink></dd></div> : null}
        {job ? <div className="flex gap-1.5"><dt className="text-faint">{t("Offer")}</dt><dd className="min-w-0"><Link className="text-accent-soft underline underline-offset-2" href={`/tools/cv-studio?tab=jobs&job=${encodeURIComponent(job.id)}`}>{job.title || job.id}</Link></dd></div> : null}
        {app.appliedOn ? <div className="flex gap-1.5"><dt className="text-faint">{t("Applied")}</dt><dd className="min-w-0 font-mono text-[12px] text-ink" data-applied-on={app.appliedOn}>{app.appliedOn}{open ? ` · ${waiting(app.appliedOn, today)}` : ""}</dd></div> : null}
        {variant ? <div className="flex gap-1.5"><dt className="text-faint">{t("CV sent")}</dt><dd className="min-w-0 wrap-anywhere">{variant.name}</dd></div> : null}
        {app.nextAction ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <dt className="text-faint">{t("Next")}</dt>
            <dd className={cx("min-w-0 wrap-anywhere", due && "font-medium text-danger")}>{app.nextAction}{app.nextActionDue ? ` · ${app.nextActionDue}` : ""}</dd>
            {due ? <Badge tone="danger">{t("Due now")}</Badge> : null}
          </div>
        ) : null}
        {last ? <div className="flex gap-1.5 text-faint"><dt>{t("Last")}</dt><dd>{last.on} {STATUS_LABEL[last.status]}{last.note && last.note !== "created" ? ` · ${last.note}` : ""}</dd></div> : null}
      </dl>

      <div className="mt-2.5 flex flex-wrap gap-1.5" role="group" aria-label={t("Move {company} to", { company: app.company })}>
        {NEXT[app.status].map((status) => (
          <Button key={status} size="sm" disabled={busy} aria-label={t("Move {company} {role} to {value}", { company: app.company, role: app.role, value: STATUS_LABEL[status] })} onClick={() => onMove(status)}>
            {STATUS_LABEL[status]}
          </Button>
        ))}
        <Button size="sm" variant="ghost" aria-label={t("Edit {company} {role}", { company: app.company, role: app.role })} onClick={onEdit}>{t("Edit")}</Button>
      </div>
    </article>
  );
}

/* ----------------------------------------------------------------- drawer */

function AppDrawer({ draft, setDraft, data, history, onClose, onSave, onDelete, error, busy }: {
  draft: Draft | null;
  setDraft: (d: Draft) => void;
  data: CvData;
  history: Application["history"];
  onClose: () => void;
  onSave: () => void;
  onDelete: () => void;
  error: string;
  busy: boolean;
}) {
  const { t } = useT();
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => draft && setDraft({ ...draft, [key]: value });
  const editing = Boolean(draft?.id);
  return (
    <Drawer
      open={draft !== null}
      title={editing ? t("Edit application") : t("Add application")}
      onClose={onClose}
      footer={
        <>
          {editing ? <Button variant="danger" onClick={onDelete} disabled={busy} className="mr-auto">{t("Delete application")}</Button> : null}
          <Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" onClick={onSave} disabled={busy || !draft?.company.trim() || !draft?.role.trim()}>{t("Save application")}</Button>
        </>
      }
    >
      {draft ? (
        <form aria-label={t("Application form")} className="space-y-3" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("Company")}><TextInput value={draft.company} onChange={(e) => set("company", e.target.value)} /></Field>
            <Field label={t("Role")}><TextInput value={draft.role} onChange={(e) => set("role", e.target.value)} /></Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("Status")}>
              <Select value={draft.status} onChange={(e) => set("status", e.target.value as ApplicationStatus)}>
                {APPLICATION_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </Select>
            </Field>
            <Field label={t("CV language")}>
              <Select value={draft.lang} onChange={(e) => set("lang", e.target.value === "pl" ? "pl" : "en")}>
                <option value="pl">{t("Polish")}</option>
                <option value="en">{t("English")}</option>
              </Select>
            </Field>
          </div>
          <Field label={t("Saved link")} hint={t("The job posting or application page. Opens in a new tab.")}>
            <TextInput aria-label={t("Saved link")} value={draft.url} onChange={(e) => set("url", e.target.value)} placeholder={t("https://…")} inputMode="url" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("Linked offer")}>
              <Select value={draft.jobId} onChange={(e) => set("jobId", e.target.value)}>
                <option value="">{t("None")}</option>
                {data.jobs.map((j) => <option key={j.id} value={j.id}>{`${j.company} — ${j.title}`.slice(0, 60)}</option>)}
              </Select>
            </Field>
            <Field label={t("CV version sent")}>
              <Select value={draft.variantId} onChange={(e) => set("variantId", e.target.value)}>
                <option value="">{t("None")}</option>
                {data.variants.map((v) => <option key={v.id} value={v.id}>{v.name.slice(0, 60)}</option>)}
              </Select>
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9.5rem]">
            <Field label={t("Next action")}><TextInput value={draft.nextAction} onChange={(e) => set("nextAction", e.target.value)} placeholder={t("e.g. Send a follow-up")} /></Field>
            <Field label={t("Due date")}><TextInput type="date" value={draft.nextActionDue} onChange={(e) => set("nextActionDue", e.target.value)} /></Field>
            <Field label={t("Applied on")} hint={t("Set automatically the first time it is marked Applied. Enter a date to record an earlier one.")}><TextInput type="date" value={draft.appliedOn} onChange={(e) => set("appliedOn", e.target.value)} /></Field>
          </div>
          <Field label={t("Notes")}><TextArea rows={4} value={draft.notes} onChange={(e) => set("notes", e.target.value)} className="font-sans" /></Field>
          {editing ? <Field label={t("Note for the status history")} hint={t("Added to the dated history when the status changes.")}><TextInput aria-label={t("Note for the status history")} value={draft.note} onChange={(e) => set("note", e.target.value)} /></Field> : null}
          {error ? <div role="alert"><Notice tone="error">{error}</Notice></div> : null}
          {editing && history.length > 0 ? (
            <section aria-label={t("Status history")}>
              <h3 className="sk-label mb-1.5">{t("Status history")}</h3>
              <ol className="space-y-1 border-l border-line pl-3 text-xs text-muted">
                {[...history].reverse().map((h, i) => (
                  <li key={`${h.on}-${h.status}-${i}`} className="wrap-anywhere"><span className="font-mono text-faint">{h.on}</span> · <span className="text-ink">{STATUS_LABEL[h.status]}</span>{h.note ? ` · ${h.note}` : ""}</li>
                ))}
              </ol>
            </section>
          ) : null}
        </form>
      ) : null}
    </Drawer>
  );
}

/* --------------------------------------------------------------------- tab */

export default function ApplicationsTab() {
  const { t } = useT();
  const live = useCvData();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [moveError, setMoveError] = useState("");
  const { reload } = live;

  const today = todayIso();
  const data = live.data;
  const due = useMemo(() => (data ? dueApplications(data.applications, today, 0) : []), [data, today]);
  const historyOf = (id: string) => data?.applications.find((a) => a.id === id)?.history ?? [];

  const move = useCallback(
    async (app: Application, status: ApplicationStatus) => {
      setBusy(true);
      setMoveError("");
      try {
        await saveApplication({ id: app.id, status });
        await reload();
      } catch (e) {
        setMoveError(errorText(e));
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const body: Partial<Application> & { company: string; role: string } = {
        company: draft.company.trim(),
        role: draft.role.trim(),
        status: draft.status,
        url: draft.url.trim(),
        jobId: draft.jobId || null,
        variantId: draft.variantId || null,
        lang: draft.lang,
        nextAction: draft.nextAction,
        nextActionDue: draft.nextActionDue || null,
        appliedOn: draft.appliedOn || null,
        notes: draft.notes,
        ...(draft.id ? { id: draft.id } : {}),
      };
      await saveApplication(body);
      await reload();
      setDraft(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!draft?.id) return;
    setBusy(true);
    try {
      await deleteApplication(draft.id);
      await reload();
      setDraft(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const openDrawer = (d: Draft) => {
    setError("");
    setDraft(d);
  };

  return (
    <CvFrame live={live}>
      {(cv) => {
        const by = (status: ApplicationStatus) => cv.applications.filter((a) => a.status === status);
        const closedCount = CLOSED.reduce((n, s) => n + by(s).length, 0);
        const column = (status: ApplicationStatus) => (
          <section key={status} aria-label={t("{value} applications", { value: STATUS_LABEL[status] })} className="min-w-0 space-y-2 rounded-tool border border-line bg-raised/30 p-2.5">
            <h2 className="flex items-center justify-between px-1 text-[13px] font-semibold text-ink">
              {STATUS_LABEL[status]}
              <Badge tone={STATUS_TONE[status]}>{by(status).length}</Badge>
            </h2>
            {by(status).length === 0 ? <p className="px-1 py-3 text-xs text-faint">{t("Nothing here.")}</p> : by(status).map((app) => (
              <AppCard key={app.id} app={app} data={cv} today={today} busy={busy} onEdit={() => openDrawer(toDraft(app))} onMove={(s) => void move(app, s)} />
            ))}
          </section>
        );
        return (
          <div className="@container space-y-4">
            <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label={t("Application actions")}>
              <Button variant="primary" onClick={() => openDrawer(emptyDraft())}>{t("Add application")}</Button>
              <Badge tone="accent">{cv.applications.filter((a) => (OPEN_STATUSES as readonly ApplicationStatus[]).includes(a.status)).length} {" "}{t("open")}</Badge>
              <Badge tone={due.length > 0 ? "danger" : "neutral"} title={t("Open applications whose next action is due today or earlier")}>{due.length} {" "}{t("due now")}</Badge>
            </div>
            {moveError ? <div role="alert"><Notice tone="error">{moveError}</Notice></div> : null}

            {due.length > 0 ? (
              <section aria-label={t("Due now")} className="rounded-tool border border-danger/40 bg-danger/5 p-3">
                <h2 className="mb-1.5 text-[13px] font-semibold text-danger">{t("Due now ({due})", { due: due.length })}</h2>
                <ul className="space-y-1 text-[13px] text-ink">
                  {due.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 wrap-anywhere">
                      <button autoComplete="off" type="button" aria-label={t("Open {company} {role}", { company: a.company, role: a.role })} onClick={() => openDrawer(toDraft(a))} className="cursor-pointer font-medium underline underline-offset-2">{a.company}</button>
                      <span className="text-muted">{a.nextAction || t("Follow up")}</span>
                      <span className="font-mono text-xs text-danger">{a.nextActionDue}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {cv.applications.length === 0 ? (
              <EmptyState
                title={t("No applications tracked yet")}
                action={<Button variant="primary" onClick={() => openDrawer(emptyDraft())}>{t("Add your first application")}</Button>}
              >
                {t("Save the link to every job you apply to, with the CV version you sent and the next step. Offers saved in the Job offers tab can be tracked in one click.")}
              </EmptyState>
            ) : (
              <>
                <div className="grid min-w-0 gap-3 @2xl:grid-cols-2 @4xl:grid-cols-3 @7xl:grid-cols-5">{PIPELINE.map(column)}</div>
                {closedCount > 0 ? (
                  <details className="rounded-tool border border-line bg-surface px-3 py-2" open={closedCount <= 6}>
                    <summary className="cursor-pointer text-[13px] font-semibold text-muted">{t("Closed ({closedCount})", { closedCount })}</summary>
                    <div className="mt-3 grid min-w-0 gap-3 @2xl:grid-cols-3">{CLOSED.map(column)}</div>
                  </details>
                ) : null}
              </>
            )}

            <AppDrawer draft={draft} setDraft={setDraft} data={cv} history={draft?.id ? historyOf(draft.id) : []} onClose={() => setDraft(null)} onSave={() => void save()} onDelete={() => void remove()} error={error} busy={busy} />
          </div>
        );
      }}
    </CvFrame>
  );
}
