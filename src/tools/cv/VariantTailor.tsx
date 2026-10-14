"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Meter, Notice, Panel, TextArea } from "@/components/ui";
import { openAssistant } from "@/lib/agent-client/bridge";
import { errorText, getAts, rewriteVariant, type AtsResult } from "@/lib/cv/client";
import type { CvLang, Job, Profile, Variant } from "@/lib/cv/schema";
import { cx } from "@/lib/format";

/**
 * Versions tab, the tailoring parts: the ATS check of what the version prints, and per-version wording (rewrites of
 * bullet texts / project summaries for this offer only; the master profile is untouched).
 */

/* ------------------------------------------------------------------- ATS */

type AtsState = { key: string; phase: "loading" | "ready" | "error"; result: AtsResult | null; error: string };

const LEVEL_TONE = { ok: "good", warn: "warn", fail: "danger", info: "neutral" } as const;

export function AtsPanel({ variant, job, stateKey, dirty }: { variant: Variant; job: Job | null; stateKey: string; dirty: boolean }) {
  const [state, setState] = useState<AtsState>({ key: "", phase: "loading", result: null, error: "" });
  const [showText, setShowText] = useState(false);
  const key = `${variant.id}:${stateKey}`;

  useEffect(() => {
    if (!job || dirty) return;
    let alive = true;
    getAts({ variantId: variant.id }).then(
      (result) => alive && setState({ key, phase: "ready", result, error: "" }),
      (e: unknown) => alive && setState({ key, phase: "error", result: null, error: errorText(e) }),
    );
    return () => {
      alive = false;
    };
    // key encodes the variant id and the saved CV revision
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, dirty, job?.id]);

  if (!job) {
    return (
      <Panel title="ATS check">
        <p className="text-sm text-muted">Link this version to a saved offer (create it from the Job offers tab) to check it against the offer&apos;s keywords.</p>
      </Panel>
    );
  }
  const view = state.key === key ? state : { ...state, phase: "loading" as const };
  const r = view.result;
  const fixPrompt = `Run the ATS check on my CV version “${variant.name}” (variantId: ${variant.id}) for ${job.title || "the offer"}${job.company ? ` at ${job.company}` : ""} and fix what it finds: bring back keywords I have but the version leaves out, use the offer's spelling where it is true, tighten anything too long. Do not add anything my profile does not show; tell me the real gaps.`;
  const chip = (k: AtsResult["keywords"][number]) => (
    <Badge
      key={`${k.term}-${k.section}`}
      tone={k.status === "present" ? (k.spellingDiffers ? "warn" : "good") : k.status === "dropped" ? "warn" : "danger"}
      title={k.status === "present" ? (k.spellingDiffers ? `In the CV, but spelled differently than the offer (“${k.postingSpelling}”)` : "In this version") : k.status === "dropped" ? "In your profile, left out of this version" : "Not in your profile: a real gap"}
    >
      {k.status === "present" ? "✓" : k.status === "dropped" ? "↩" : "✗"} {k.term}
    </Badge>
  );
  return (
    <Panel title="ATS check" right={r ? <Badge tone={r.score >= 75 ? "good" : r.score >= 50 ? "warn" : "danger"}>{r.score}/100</Badge> : undefined}>
      <div className="space-y-3" data-agent-region="cv-ats">
        {dirty ? <Notice tone="info">Save the version to check it.</Notice> : null}
        {!dirty && view.phase === "loading" ? <p role="status" className="text-sm text-muted">Checking…</p> : null}
        {view.phase === "error" ? <Notice tone="error">ATS check failed: {view.error}</Notice> : null}
        {r ? (
          <>
            <div className="grid gap-3 @md:grid-cols-2">
              <div className="space-y-1">
                <div className="flex items-baseline justify-between"><span className="sk-label">Required keywords</span><span className="font-mono text-sm font-semibold tabular-nums text-ink">{r.requiredCoveragePct === null ? "n/a" : `${Math.round(r.requiredCoveragePct)}%`}</span></div>
                <Meter value={r.requiredCoveragePct ?? 0} label="Required keyword coverage" />
              </div>
              <div className="space-y-1">
                <div className="flex items-baseline justify-between"><span className="sk-label">Nice to have</span><span className="font-mono text-sm font-semibold tabular-nums text-ink">{r.niceCoveragePct === null ? "n/a" : `${Math.round(r.niceCoveragePct)}%`}</span></div>
                <Meter value={r.niceCoveragePct ?? 0} label="Nice-to-have keyword coverage" />
              </div>
            </div>
            {r.keywords.length > 0 ? (
              <section aria-label="Offer keywords" className="space-y-1.5">
                <h3 className="text-[13px] font-semibold text-ink">Offer keywords <span className="font-normal text-faint">✓ in this CV · ↩ yours, left out · ✗ gap</span></h3>
                {(["required", "nice", "text"] as const).map((section) => {
                  const ks = r.keywords.filter((k) => k.section === section);
                  if (!ks.length) return null;
                  return (
                    <div key={section} className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-muted">{section === "required" ? "Required:" : section === "nice" ? "Nice to have:" : "Mentioned:"}</span>
                      {ks.map(chip)}
                    </div>
                  );
                })}
              </section>
            ) : null}
            {r.actions.length > 0 ? (
              <section aria-label="What to do" className="space-y-1">
                <h3 className="text-[13px] font-semibold text-ink">What to do</h3>
                <ol className="list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-muted">
                  {r.actions.map((a, i) => <li key={i} className="wrap-anywhere">{a}</li>)}
                </ol>
              </section>
            ) : null}
            <details className="rounded-lg border border-line bg-raised/30 px-3 py-2">
              <summary className="cursor-pointer text-[13px] font-medium text-muted">Checks ({r.checks.filter((c) => c.level === "ok").length}/{r.checks.filter((c) => c.level !== "info").length} passed · about {r.pages} pages)</summary>
              <ul className="mt-2 space-y-1">
                {r.checks.map((c, i) => (
                  <li key={`${c.id}-${i}`} className="flex items-start gap-2 text-[13px] text-muted">
                    <Badge tone={LEVEL_TONE[c.level]}>{c.level}</Badge>
                    <span className="min-w-0 wrap-anywhere">{c.message}</span>
                  </li>
                ))}
              </ul>
            </details>
            <div className="flex flex-wrap items-center gap-2">
              {r.fixable.length > 0
                ? <Button variant="primary" onClick={() => openAssistant(fixPrompt)}>Fix with the assistant</Button>
                : <span className="text-[13px] text-muted">Nothing left to fix truthfully.</span>}
              <Button size="sm" variant="ghost" aria-pressed={showText} onClick={() => setShowText((v) => !v)}>{showText ? "Hide" : "Show"} what an ATS reads</Button>
            </div>
            {showText ? <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-raised/40 p-3 text-xs leading-relaxed whitespace-pre-wrap text-ink">{r.printed}</pre> : null}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

/* --------------------------------------------------------------- wording */

interface WordingRow {
  path: string;
  label: string;
  master: string;
  current: string;
  rewritten: boolean;
}

/** The texts this version can reword: bullets of the included roles and projects, project summaries. */
export function wordingRows(resolvedMaster: Profile, variant: Variant, master: Profile, lang: CvLang): WordingRow[] {
  const byPath = new Map(variant.rewrites.map((r) => [r.path, r]));
  const rows: WordingRow[] = [];
  const push = (path: string, label: string, masterText: string) => {
    const rw = byPath.get(path);
    const current = rw?.text[lang].trim() ? rw.text[lang] : masterText;
    rows.push({ path, label, master: masterText, current, rewritten: Boolean(rw?.text[lang].trim()) });
  };
  const masterRole = new Map(master.experience.map((e) => [e.id, e]));
  for (const e of resolvedMaster.experience) {
    const role = masterRole.get(e.id);
    for (const b of e.bullets) {
      const mb = role?.bullets.find((x) => x.id === b.id);
      push(`/experience/id=${e.id}/bullets/id=${b.id}/text`, e.org, mb?.text[lang] ?? "");
    }
  }
  const masterProject = new Map(master.projects.map((p) => [p.id, p]));
  for (const p of resolvedMaster.projects) {
    const mp = masterProject.get(p.id);
    push(`/projects/id=${p.id}/summary`, `${p.name} · summary`, mp?.summary[lang] ?? "");
    for (const b of p.bullets) push(`/projects/id=${p.id}/bullets/id=${b.id}/text`, p.name, mp?.bullets.find((x) => x.id === b.id)?.text[lang] ?? "");
  }
  return rows;
}

export function WordingPanel({ variant, master, selection, onSaved }: { variant: Variant; master: Profile; selection: Profile; onSaved: () => void }) {
  const lang = variant.lang;
  const rows = wordingRows(selection, variant, master, lang);
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "good" | "warn" | "error"; text: string } | null>(null);

  const save = async (path: string, text: string | null) => {
    setBusy(true);
    setNote(null);
    try {
      const res = text === null ? await rewriteVariant(variant.id, [], [path]) : await rewriteVariant(variant.id, [{ path, text: { [lang]: text } }]);
      setEditing("");
      onSaved();
      // the warnings name the field by its id-path (for the assistant); the person sees the row they just edited
      const plain = res.warnings.map((w) => w.replace(/^\/\S+?\/(?:pl|en): /, ""));
      setNote(plain.length ? { tone: "warn", text: `Saved, but check it: ${plain.join(" ")}` } : { tone: "good", text: text === null ? "Back to the profile wording." : "Saved for this version." });
    } catch (e) {
      setNote({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const reworded = rows.filter((r) => r.rewritten).length;
  return (
    <Panel title="Wording for this version" right={reworded ? <Badge tone="accent">{reworded} reworded</Badge> : undefined}>
      <div className="space-y-2" data-agent-region="cv-wording">
        <p className="text-xs text-muted">Reword a bullet for this offer only; your profile keeps the original. Numbers and names must stay, nothing new may be added: a warning shows when that happens.</p>
        {note ? <div role={note.tone === "error" ? "alert" : "status"}><Notice tone={note.tone}>{note.text}</Notice></div> : null}
        {rows.length === 0 ? <p className="text-sm text-muted">No bullets or project summaries in this version yet.</p> : null}
        <ul className="space-y-1.5">
          {rows.map((row) => (
            <li key={row.path} className={cx("rounded-lg border p-2", row.rewritten ? "border-accent/40 bg-accent/5" : "border-line bg-raised/30")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wide text-faint">{row.label}</span>
                {row.rewritten ? <Badge tone="accent">reworded</Badge> : null}
              </div>
              {editing === row.path ? (
                <div className="mt-1 space-y-1.5">
                  <TextArea rows={3} aria-label={`Wording for this version: ${row.label}`} value={draft} onChange={(e) => setDraft(e.target.value)} className="font-sans" />
                  {row.master ? <p className="text-xs text-faint wrap-anywhere"><span className="sk-label">Profile</span> {row.master}</p> : null}
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="primary" disabled={busy || !draft.trim()} onClick={() => void save(row.path, draft)}>Save for this version</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing("")}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="mt-0.5 flex min-w-0 items-start gap-2">
                  <p className={cx("min-w-0 flex-1 text-[13px] leading-relaxed wrap-anywhere", row.current ? "text-ink" : "text-faint italic")}>{row.current || `(empty in ${lang.toUpperCase()})`}</p>
                  <span className="flex shrink-0 gap-1">
                    <Button size="sm" variant="ghost" aria-label={`Reword for this version: ${row.label} ${row.path}`} onClick={() => { setEditing(row.path); setDraft(row.current); }}>Reword</Button>
                    {row.rewritten ? <Button size="sm" variant="ghost" aria-label={`Restore profile wording: ${row.path}`} disabled={busy} onClick={() => void save(row.path, null)}>Restore</Button> : null}
                  </span>
                </div>
              )}
              {row.rewritten && editing !== row.path && row.master ? <p className="mt-1 text-xs text-faint wrap-anywhere"><span className="sk-label">Profile</span> {row.master}</p> : null}
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}
