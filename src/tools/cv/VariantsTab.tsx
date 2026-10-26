"use client";

import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Badge, Button, EmptyState, Field, Notice, Panel, SegmentedControl, TextArea, TextInput } from "@/components/ui";
import { deleteVariant, errorText, saveVariant } from "@/lib/cv/client";
import { uniqueId } from "@/lib/cv/collections";
import { downloadCvDocx } from "@/lib/cv/render/docx-client";
import type { CvData, CvLang, Profile, Variant } from "@/lib/cv/schema";
import { danglingIds, effectiveSectionOrder, resolveVariant } from "@/lib/cv/variant";
import { SectionOrderEditor } from "./ProfilePriority";
import { AtsPanel, WordingPanel } from "./VariantTailor";
import { cx } from "@/lib/format";
import { CvDocument } from "./CvDocument";
import { DocumentOptions, useDocLook, type DocLook } from "./DocumentOptions";
import { usePref } from "./prefs";
import { CvFrame, NoProfileNotice, profileIsEmpty, useLang } from "./shared";
import { useCvData } from "./useCvData";
import {
  applySelection, moveId, moveRole, pruneDangling, selectionCounts, selectionOf, toggleId, toggleRole, updateBullets, type Selection,
} from "./variant-edit";
import { useT } from "@/lib/i18n/react";

const TAB = "variants";
const MASTER = "__master__";

/* ---------------------------------------------------------------- preview */

function Preview({ profile, lang, look }: { profile: Profile; lang: CvLang; look: DocLook }) {
  const { t } = useT();
  const root = useRef<HTMLDivElement>(null);
  // CvDocument's own print stylesheet hides everything but the sheet; we only name the file (Chrome uses document.title).
  const print = () => {
    const previous = document.title;
    const title = root.current?.querySelector<HTMLElement>("[data-cv-document]")?.dataset.cvTitle;
    if (title) document.title = title;
    window.addEventListener("afterprint", () => { document.title = previous; }, { once: true });
    window.print();
  };
  return (
    <Panel title={t("Live preview")} right={<Button size="sm" onClick={print}>{t("Print / Save as PDF")}</Button>} bodyClassName="p-2 sm:p-3">
      <div ref={root} data-agent-region="cv-preview" className="max-h-[80vh] overflow-auto rounded-lg border border-line bg-raised/60 p-2 sm:p-3">
        <CvDocument profile={profile} lang={lang} theme={look.options.layout} photoUrl={look.photoUrl} photoShape={look.options.shape} />
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------ list + create */

function VersionList({ variants, selected, onSelect, master, jobs }: { variants: Variant[]; selected: string; onSelect: (id: string) => void; master: Profile; jobs: CvData["jobs"] }) {
  const { t, tn } = useT();
  const items: { id: string; title: string; sub: string; warn: number; badges: string[] }[] = [
    { id: MASTER, title: t("Master profile"), sub: t("Everything, as written in the Profile tab"), warn: 0, badges: [] },
    ...variants.map((v) => ({
      id: v.id,
      title: v.name,
      sub: v.target || (v.jobId ? jobs.find((j) => j.id === v.jobId)?.company ?? "" : ""),
      warn: danglingIds(master, v).length,
      badges: [v.lang.toUpperCase()],
    })),
  ];
  return (
    <ul className="grid min-w-0 gap-2 @2xl:grid-cols-2 @5xl:grid-cols-3" aria-label={t("CV versions")}>
      {items.map((item) => (
        <li key={item.id} data-cv-path={item.id === MASTER ? undefined : `/variants/id=${item.id}`} className="min-w-0 rounded-xl">
          <button
            autoComplete="off"
            type="button"
            aria-pressed={item.id === selected}
            aria-label={t("Open version {title}", { title: item.title })}
            onClick={() => onSelect(item.id)}
            className={cx(
              "block h-full w-full cursor-pointer rounded-xl border p-3 text-left transition-colors",
              item.id === selected ? "border-accent/60 bg-accent/10" : "border-line bg-surface hover:border-line-strong hover:bg-raised/60",
            )}
          >
            <span className="block text-sm font-semibold text-ink wrap-anywhere">{item.title}</span>
            {item.sub ? <span className="block text-xs text-muted wrap-anywhere">{item.sub}</span> : null}
            <span className="mt-1.5 flex flex-wrap gap-1.5">
              {item.badges.map((b) => <Badge key={b}>{b}</Badge>)}
              {item.warn > 0 ? <Badge tone="warn">{tn("{n} broken reference", "{n} broken references", item.warn)}</Badge> : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function NewVersion({ taken, lang, onCreated }: { taken: Set<string>; lang: CvLang; onCreated: (v: Variant) => void }) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await saveVariant({ id: uniqueId(name, taken), name: name.trim(), lang });
      setName("");
      onCreated(res.variant);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="space-y-1" aria-label={t("New CV version")} onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <div className="flex flex-wrap items-center gap-2">
        <TextInput aria-label={t("New version name")} className="h-9 min-w-0 flex-1 basis-48" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Name, e.g. Backend at Gamma")} />
        <Button type="submit" disabled={!name.trim() || busy}>{t("Create version")}</Button>
      </div>
      {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
    </form>
  );
}

/* ------------------------------------------------------------ editor pieces */

function Checkbox({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return <input type="checkbox" aria-label={label} checked={checked} onChange={onChange} className="size-4 shrink-0 cursor-pointer accent-[var(--c-accent)]" />;
}

function Mover({ name, onUp, onDown, canUp, canDown }: { name: string; onUp: () => void; onDown: () => void; canUp: boolean; canDown: boolean }) {
  const { t } = useT();
  return (
    <span className="flex shrink-0 gap-0.5">
      <Button size="sm" variant="ghost" aria-label={t("Move {name} up", { name })} disabled={!canUp} onClick={onUp} className="px-2">↑</Button>
      <Button size="sm" variant="ghost" aria-label={t("Move {name} down", { name })} disabled={!canDown} onClick={onDown} className="px-2">↓</Button>
    </span>
  );
}

/** Items of one list: the selected ones in version order first, then the left-out ones in master order. */
function ordered<T extends { id: string }>(all: readonly T[], selected: readonly string[]): { item: T; on: boolean }[] {
  const byId = new Map(all.map((x) => [x.id, x]));
  return [...selected.flatMap((id) => byId.get(id) ?? []).map((item) => ({ item, on: true })), ...all.filter((x) => !selected.includes(x.id)).map((item) => ({ item, on: false }))];
}

function ListEditor<T extends { id: string }>({ title, items, selected, label, onToggle, onMove }: {
  title: string; items: readonly T[]; selected: readonly string[]; label: (item: T) => string; onToggle: (id: string) => void; onMove: (id: string, delta: -1 | 1) => void;
}) {
  const { t } = useT();
  if (items.length === 0) return null;
  const rows = ordered(items, selected);
  return (
    <section aria-label={title} className="space-y-1">
      <h3 className="sk-label">{title}</h3>
      <ul className="space-y-0.5">
        {rows.map(({ item, on }) => {
          const i = selected.indexOf(item.id);
          return (
            <li key={item.id} className={cx("flex items-center gap-2 rounded-md px-1.5 py-1", on ? "" : "opacity-60")}>
              <Checkbox checked={on} label={t("Include {item}", { item: label(item) })} onChange={() => onToggle(item.id)} />
              <span className="min-w-0 flex-1 text-[13px] text-ink wrap-anywhere">{label(item)}</span>
              {on ? <Mover name={label(item)} canUp={i > 0} canDown={i < selected.length - 1} onUp={() => onMove(item.id, -1)} onDown={() => onMove(item.id, 1)} /> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Rewrites are saved through their own route (with fact checks), never by the editor's Save: leave them out of "dirty". */
const editorKey = (v: Variant): string => JSON.stringify({ ...v, rewrites: null });

function Editor({ master, stored, look, onDone, jobs, revision, onReload }: {
  master: Profile; stored: Variant; look: DocLook; onDone: () => void; jobs: CvData["jobs"]; revision: number; onReload: () => void;
}) {
  const { t, tn } = useT();
  const baseKey = editorKey(stored);
  const [draft, setDraft] = useState<{ base: string; v: Variant }>({ base: baseKey, v: stored });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "good" | "error"; text: string } | null>(null);
  const [docxBusy, setDocxBusy] = useState(false);

  // The stored version moved (assistant edit, another tab, our own save): adopt it unless the user has unsaved edits.
  const dirty = editorKey(draft.v) !== draft.base;
  if (draft.base !== baseKey && (!dirty || editorKey(draft.v) === baseKey)) setDraft({ base: baseKey, v: stored });

  const v: Variant = useMemo(() => ({ ...draft.v, rewrites: stored.rewrites }), [draft.v, stored.rewrites]);
  const sel = useMemo(() => selectionOf(master, v), [master, v]);
  const counts = selectionCounts(sel);
  const dangling = danglingIds(master, v);
  const resolved = useMemo(() => resolveVariant(master, v), [master, v]);
  const edit = (next: Variant) => { setDraft({ ...draft, v: next }); setMessage(null); };
  const editSel = (next: Selection) => edit(applySelection(master, v, next));

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await saveVariant(v);
      setDraft({ base: editorKey(res.variant), v: res.variant });
      setMessage({ tone: "good", text: t("Version saved.") });
    } catch (e) {
      setMessage({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteVariant(v.id);
      onDone();
    } catch (e) {
      setMessage({ tone: "error", text: errorText(e) });
      setBusy(false);
    }
  };

  const docx = async () => {
    setDocxBusy(true);
    setMessage(null);
    try {
      await downloadCvDocx({ variantId: v.id, lang: v.lang, ...look.exportOptions });
    } catch (e) {
      setMessage({ tone: "error", text: errorText(e) });
    } finally {
      setDocxBusy(false);
    }
  };

  const customHeadline = v.headline !== null;
  const customSummary = v.summary !== null;

  return (
    <div className="grid min-w-0 gap-4 @5xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]" data-cv-path={`/variants/id=${v.id}`}>
      <div className="min-w-0 space-y-4">
        <Panel title={t("Version")} right={dirty ? <Badge tone="warn">{t("Unsaved changes")}</Badge> : <Badge tone="good">{t("Saved")}</Badge>}>
          <div className="space-y-3">
            <Field label={t("Version name")}><TextInput value={v.name} onChange={(e) => edit({ ...v, name: e.target.value })} /></Field>
            <Field label={t("Target (company or role)")}><TextInput value={v.target} onChange={(e) => edit({ ...v, target: e.target.value })} placeholder={t("Optional")} /></Field>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <span className="sk-label block">{t("Language")}</span>
                <SegmentedControl<CvLang>
                  label={t("Version language")}
                  value={v.lang}
                  onChange={(next) => edit({ ...v, lang: next })}
                  options={[{ value: "pl", label: "PL", ariaLabel: "Polish" }, { value: "en", label: "EN", ariaLabel: "English" }]}
                />
              </div>
            </div>
            <DocumentOptions look={look} />
            <p className="text-xs text-muted">{[tn("{n} role", "{n} roles", counts.roles), tn("{n} bullet", "{n} bullets", counts.bullets), tn("{n} project", "{n} projects", counts.projects), tn("{n} skill group", "{n} skill groups", counts.skills)].join(" · ")}</p>
            {dangling.length > 0 ? (
              <div className="space-y-2" role="alert">
                <Notice tone="warn">{tn("This version points at {n} item the profile no longer has ({items}). Saving is blocked until it is removed.", "This version points at {n} items the profile no longer has ({items}). Saving is blocked until they are removed.", dangling.length, { items: dangling.slice(0, 4).join(", ") + (dangling.length > 4 ? "…" : "") })}</Notice>
                <Button size="sm" onClick={() => edit(pruneDangling(master, v))}>{t("Remove broken references")}</Button>
              </div>
            ) : null}
            {message ? <div role={message.tone === "error" ? "alert" : "status"}><Notice tone={message.tone}>{message.text}</Notice></div> : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => void save()} disabled={busy || !dirty || dangling.length > 0 || !v.name.trim()}>{t("Save version")}</Button>
              <Button onClick={() => setDraft({ base: baseKey, v: stored })} disabled={!dirty}>{t("Discard changes")}</Button>
              <Button onClick={() => void docx()} disabled={docxBusy || dirty} title={dirty ? t("Save the version first") : undefined}>{docxBusy ? t("Preparing…") : t("Download DOCX")}</Button>
              <Button variant="danger" onClick={() => void remove()} disabled={busy} aria-label={t("Delete version {name}", { name: stored.name })}>{t("Delete version")}</Button>
            </div>
          </div>
        </Panel>

        <Panel title={t("Headline and summary")}>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-[13px] text-ink">
                <Checkbox checked={customHeadline} label={t("Use a custom headline")} onChange={() => edit({ ...v, headline: customHeadline ? null : { ...master.contact.headline } })} />
                {t("Custom headline")}
              </label>
              {v.headline ? <TextInput aria-label={t("Headline ({value})", { value: v.lang.toUpperCase() })} value={v.headline[v.lang]} onChange={(e) => v.headline && edit({ ...v, headline: { ...v.headline, [v.lang]: e.target.value } })} /> : <p className="text-xs text-faint">{t("Uses the profile headline.")}</p>}
            </div>
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-[13px] text-ink">
                <Checkbox checked={customSummary} label={t("Use a custom summary")} onChange={() => edit({ ...v, summary: customSummary ? null : { ...master.summary } })} />
                {t("Custom summary")}
              </label>
              {v.summary ? <TextArea rows={4} aria-label={t("Summary ({value})", { value: v.lang.toUpperCase() })} className="font-sans" value={v.summary[v.lang]} onChange={(e) => v.summary && edit({ ...v, summary: { ...v.summary, [v.lang]: e.target.value } })} /> : <p className="text-xs text-faint">{t("Uses the profile summary.")}</p>}
            </div>
          </div>
        </Panel>

        <Panel title={t("What goes in")}>
          <div className="space-y-4">
            <section aria-label={t("Experience")} className="space-y-1">
              <h3 className="sk-label">{t("Experience")}</h3>
              <ul className="space-y-2">
                {ordered(master.experience, sel.experience.map((e) => e.id)).map(({ item: role, on }) => {
                  const picked = sel.experience.find((e) => e.id === role.id);
                  const i = sel.experience.findIndex((e) => e.id === role.id);
                  const name = `${role.org} (${role.role[v.lang] || role.role[v.lang === "pl" ? "en" : "pl"] || role.id})`;
                  return (
                    <li key={role.id} className={cx("rounded-lg border border-line p-2", on ? "bg-raised/30" : "opacity-60")}>
                      <div className="flex items-center gap-2">
                        <Checkbox checked={on} label={t("Include {name}", { name })} onChange={() => editSel(toggleRole(master, sel, role.id))} />
                        <span className="min-w-0 flex-1 text-[13px] font-medium text-ink wrap-anywhere">{name}</span>
                        {on ? <Mover name={name} canUp={i > 0} canDown={i < sel.experience.length - 1} onUp={() => editSel(moveRole(sel, role.id, -1))} onDown={() => editSel(moveRole(sel, role.id, 1))} /> : null}
                      </div>
                      {picked ? (
                        <ul className="mt-1.5 space-y-0.5 border-t border-line pt-1.5">
                          {ordered(role.bullets, picked.bulletIds).map(({ item: b, on: bOn }) => {
                            const bi = picked.bulletIds.indexOf(b.id);
                            const text = b.text[v.lang] || b.text[v.lang === "pl" ? "en" : "pl"] || b.id;
                            return (
                              <li key={b.id} className={cx("flex items-start gap-2 px-1 py-0.5", bOn ? "" : "opacity-60")}>
                                <span className="mt-0.5"><Checkbox checked={bOn} label={t("Include bullet {id} of {org}", { id: b.id, org: role.org })} onChange={() => editSel(updateBullets(master, sel, role.id, { toggle: b.id }))} /></span>
                                <span className="min-w-0 flex-1 text-xs leading-relaxed text-muted wrap-anywhere">{text.length > 110 ? `${text.slice(0, 109)}…` : text}</span>
                                {bOn ? <Mover name={`bullet ${b.id}`} canUp={bi > 0} canDown={bi < picked.bulletIds.length - 1} onUp={() => editSel(updateBullets(master, sel, role.id, { move: b.id, delta: -1 }))} onDown={() => editSel(updateBullets(master, sel, role.id, { move: b.id, delta: 1 }))} /> : null}
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
            <ListEditor
              title={t("Projects")}
              items={master.projects}
              selected={sel.projectIds}
              label={(p) => p.name || p.id}
              onToggle={(id) => editSel({ ...sel, projectIds: toggleId(sel.projectIds, id, master.projects.map((p) => p.id)) })}
              onMove={(id, d) => editSel({ ...sel, projectIds: moveId(sel.projectIds, id, d) })}
            />
            <ListEditor
              title={t("Your own sections")}
              items={master.customSections}
              selected={sel.customSectionIds}
              label={(c) => c.title[v.lang] || c.title[v.lang === "pl" ? "en" : "pl"] || c.id}
              onToggle={(id) => editSel({ ...sel, customSectionIds: toggleId(sel.customSectionIds, id, master.customSections.map((c) => c.id)) })}
              onMove={(id, d) => editSel({ ...sel, customSectionIds: moveId(sel.customSectionIds, id, d) })}
            />
            <ListEditor
              title={t("Skill groups")}
              items={master.skills}
              selected={sel.skillGroupIds}
              label={(s) => s.name[v.lang] || s.name[v.lang === "pl" ? "en" : "pl"] || s.id}
              onToggle={(id) => editSel({ ...sel, skillGroupIds: toggleId(sel.skillGroupIds, id, master.skills.map((s) => s.id)) })}
              onMove={(id, d) => editSel({ ...sel, skillGroupIds: moveId(sel.skillGroupIds, id, d) })}
            />
          </div>
        </Panel>

        <Panel title={t("Section order")}>
          <SectionOrderEditor
            profile={master}
            order={v.sectionOrder ? effectiveSectionOrder({ ...master, sectionOrder: v.sectionOrder }) : effectiveSectionOrder(master)}
            isCustom={v.sectionOrder !== null}
            label={t("Section order of this version")}
            lang={v.lang}
            onChange={(next) => edit({ ...v, sectionOrder: next })}
          />
        </Panel>

        <WordingPanel variant={stored} master={master} selection={resolveVariant(master, { ...stored, rewrites: [] })} onSaved={onReload} />
      </div>
      <div className="min-w-0 space-y-4">
        <AtsPanel variant={stored} job={jobs.find((j) => j.id === stored.jobId) ?? null} stateKey={String(revision)} dirty={dirty} />
        <div className="@5xl:sticky @5xl:top-4">
          <Preview profile={resolved} lang={v.lang} look={look} />
        </div>
      </div>
    </div>
  );
}

function MasterView({ master, lang, look, onLang }: { master: Profile; lang: CvLang; look: DocLook; onLang: (l: CvLang) => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="grid min-w-0 gap-4 @5xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
      <Panel title={t("Master profile")}>
        <div className="space-y-3">
          <p className="text-[13px] leading-relaxed text-muted">{t("Everything in your profile, unfiltered. Create a version to pick and order what goes into a CV for one offer.")}</p>
          <div className="flex flex-wrap items-end gap-3">
            <SegmentedControl<CvLang> label={t("Document language")} value={lang} onChange={onLang} options={[{ value: "pl", label: "PL", ariaLabel: "Polish" }, { value: "en", label: "EN", ariaLabel: "English" }]} />
          </div>
          <DocumentOptions look={look} />
          {error ? <div role="alert"><Notice tone="error">{error}</Notice></div> : null}
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await downloadCvDocx({ variantId: null, lang, ...look.exportOptions });
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? t("Preparing…") : t("Download DOCX")}
          </Button>
        </div>
      </Panel>
      <div className="min-w-0 @5xl:sticky @5xl:top-4 @5xl:self-start"><Preview profile={master} lang={lang} look={look} /></div>
    </div>
  );
}

/* --------------------------------------------------------------------- tab */

export default function VariantsTab() {
  const { t } = useT();
  const live = useCvData();
  const lang = useLang(TAB);
  const [, setLang] = usePref<CvLang>(`lang:${TAB}`, "pl", ["pl", "en"]);
  const look = useDocLook(TAB);
  const [picked, setPicked] = useState("");
  const { reload } = live;
  // deep link (?variant=<id>, e.g. from an agent's knife_ui_show): wins until the user picks another version
  const wanted = useSearchParams().get("variant") ?? "";

  return (
    <CvFrame live={live}>
      {(cv) => {
        if (profileIsEmpty(cv)) return <NoProfileNotice />;
        const selected = picked === MASTER || cv.variants.some((v) => v.id === picked) ? picked : cv.variants.some((v) => v.id === wanted) ? wanted : cv.variants.at(-1)?.id ?? MASTER;
        const stored = cv.variants.find((v) => v.id === selected);
        return (
          <div className="@container space-y-4">
            <Panel title={t("CV versions")}>
              <div className="space-y-4">
                {cv.variants.length === 0 ? (
                  <EmptyState title={t("No versions yet")}>{t("A version is your master profile trimmed and reordered for one offer. Create one here, or open an offer in the Job offers tab and let the assistant suggest it.")}</EmptyState>
                ) : null}
                <VersionList variants={cv.variants} selected={selected} onSelect={setPicked} master={cv.profile} jobs={cv.jobs} />
                <NewVersion taken={new Set(cv.variants.map((v) => v.id))} lang={lang} onCreated={(v) => { setPicked(v.id); void reload(); }} />
              </div>
            </Panel>
            {stored ? (
              <Editor key={stored.id} master={cv.profile} stored={stored} look={look} jobs={cv.jobs} revision={cv.revision} onReload={() => void reload()} onDone={() => { setPicked(MASTER); void reload(); }} />
            ) : (
              <MasterView master={cv.profile} lang={lang} look={look} onLang={setLang} />
            )}
          </div>
        );
      }}
    </CvFrame>
  );
}
