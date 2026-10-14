"use client";

import { useState } from "react";
import { Badge, Button, Notice, Panel, TextInput } from "@/components/ui";
import { openAssistant } from "@/lib/agent-client/bridge";
import { errorText, projectFromGithub, type GithubProjectResult } from "@/lib/cv/client";
import { uniqueId } from "@/lib/cv/collections";
import { SECTION_TITLES } from "@/lib/cv/render/view";
import type { CvLang, Profile } from "@/lib/cv/schema";
import { effectiveSectionOrder } from "@/lib/cv/variant";
import { AddRow, EditableField, ItemCard, PinButton, RemoveButton, useHidden, useProfileEnv } from "./profile-fields";

/**
 * Profile tab, the "what should stand out" parts: tailoring notes for the assistant, the section print order, the
 * user's own sections (open source, certificates, awards…) and adding a project from a GitHub link.
 */

/** Human name of a section key in the UI language of the tab. */
export function sectionLabel(profile: Profile, key: string, lang: CvLang): string {
  if (key.startsWith("custom:")) {
    const s = profile.customSections.find((c) => `custom:${c.id}` === key);
    return s ? s.title[lang] || s.title[lang === "pl" ? "en" : "pl"] || s.id : key;
  }
  return (SECTION_TITLES as Record<string, Record<CvLang, string>>)[key]?.[lang] ?? key;
}

/** Up/down list of section keys; `onChange(null)` = back to the standard order. */
export function SectionOrderEditor({ profile, order, isCustom, onChange, label, lang }: { profile: Profile; order: string[]; isCustom: boolean; onChange: (next: string[] | null) => void; label: string; lang: CvLang }) {
  const move = (i: number, by: number) => {
    const next = [...order];
    const [item] = next.splice(i, 1);
    next.splice(i + by, 0, item);
    onChange(next);
  };
  return (
    <div className="space-y-1.5">
      <ol className="space-y-1" aria-label={label}>
        {order.map((key, i) => (
          <li key={key} className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-raised/40 px-2.5 py-1">
            <span className="w-5 shrink-0 text-xs text-faint tabular-nums">{i + 1}.</span>
            <span className="min-w-0 flex-1 truncate text-sm text-ink">{sectionLabel(profile, key, lang)}</span>
            <Button size="sm" variant="ghost" aria-label={`Move ${sectionLabel(profile, key, lang)} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
            <Button size="sm" variant="ghost" aria-label={`Move ${sectionLabel(profile, key, lang)} down`} disabled={i === order.length - 1} onClick={() => move(i, 1)}>↓</Button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={isCustom ? "accent" : "neutral"}>{isCustom ? "custom order" : "standard order"}</Badge>
        {isCustom ? <Button size="sm" variant="ghost" onClick={() => onChange(null)}>Reset to standard</Button> : null}
      </div>
    </div>
  );
}

export function TailoringSection({ profile }: { profile: Profile }) {
  const env = useProfileEnv();
  const order = effectiveSectionOrder(profile);
  const pinned = profile.experience.filter((e) => e.pinned).length + profile.projects.filter((p) => p.pinned).length + profile.skills.filter((s) => s.pinned).length
    + profile.customSections.filter((c) => c.pinned).length + profile.experience.reduce((n, e) => n + e.bullets.filter((b) => b.pinned).length, 0) + profile.projects.reduce((n, p) => n + p.bullets.filter((b) => b.pinned).length, 0);
  return (
    <div data-cv-path="/guidance">
      <Panel title="Tailoring priorities">
        <div className="space-y-4">
          <div className="space-y-1">
            <span className="sk-label">Notes for tailoring (never printed)</span>
            <EditableField
              path="/guidance"
              value={profile.guidance}
              label="Notes for tailoring"
              placeholder="What should stand out, e.g. “My commercial years are few; lead with my projects (Finetune Studio, the homelab) and what they prove.”"
              multiline
            />
            <p className="px-2.5 text-xs text-muted">The assistant reads this every time it tailors your CV. Truthfulness rules still apply.</p>
          </div>
          <div className="space-y-1">
            <span className="sk-label">Priority items</span>
            <p className="px-2.5 text-sm text-muted">
              {pinned ? `${pinned} pinned ${pinned === 1 ? "item" : "items"}: always kept and listed first in tailored versions.` : "None yet. Use ☆ pin on a role, bullet, project, skill group or your own section to make it a priority."}
            </p>
          </div>
          <div className="space-y-1">
            <span className="sk-label">Section order</span>
            <SectionOrderEditor
              profile={profile}
              order={order}
              isCustom={Boolean(profile.sectionOrder)}
              label="Section order"
              lang={env.lang}
              onChange={(next) => void env.save([{ op: "set", path: "/sectionOrder", value: next }])}
            />
          </div>
        </div>
      </Panel>
    </div>
  );
}

/* ---------------------------------------------------------- custom sections */

export function CustomSectionsSection({ profile }: { profile: Profile }) {
  const env = useProfileEnv();
  const hidden = useHidden("/customSections");
  if (hidden) return null;
  return (
    <div data-cv-path="/customSections">
      <Panel title="Your own sections">
        <div className="space-y-3">
          {profile.customSections.length === 0 && !env.onlyMissing ? (
            <p className="text-sm text-muted">Add a section of your own, e.g. Open source, Certificates, Awards, Talks. It prints like the built-in ones.</p>
          ) : null}
          {profile.customSections.map((section) => <CustomSectionCard key={section.id} section={section} />)}
          {!env.onlyMissing ? (
            <AddRow
              label="New section title"
              buttonLabel="Add section"
              placeholder={`Section title in ${env.lang.toUpperCase()}, e.g. ${env.lang === "pl" ? "Certyfikaty" : "Certificates"}`}
              onAdd={(title) => {
                const id = uniqueId(title, new Set(profile.customSections.map((x) => x.id)));
                return env.save([{ op: "add", path: "/customSections/-", value: { id, title: { pl: env.lang === "pl" ? title : "", en: env.lang === "en" ? title : "" }, items: [] } }]);
              }}
            />
          ) : null}
        </div>
      </Panel>
    </div>
  );
}

function CustomSectionCard({ section }: { section: Profile["customSections"][number] }) {
  const env = useProfileEnv();
  const { lang, other } = env;
  const L = lang.toUpperCase();
  const base = `/customSections/id=${section.id}`;
  if (useHidden(base)) return null;
  const name = section.title[lang] || section.title[other] || section.id;
  return (
    <ItemCard
      path={base}
      title={<EditableField path={`${base}/title/${lang}`} biPath={`${base}/title`} keepInFilter value={section.title[lang]} reference={section.title[other]} label={`Section ${section.id} title (${L})`} placeholder={`Section title in ${L}`} />}
      right={!env.onlyMissing ? <span className="flex items-center gap-1"><PinButton path={base} pinned={section.pinned} name={`section ${name}`} /><RemoveButton label={`Remove section ${name}`} onClick={() => void env.save([{ op: "remove", path: base }])} /></span> : undefined}
    >
      <div className="space-y-2">
        {section.items.map((item) => {
          const ib = `${base}/items/id=${item.id}`;
          const itemName = item.title[lang] || item.title[other] || item.id;
          return (
            <div key={item.id} data-cv-path={ib} className="space-y-1 rounded-lg border border-line/70 p-2">
              <div className="flex min-w-0 items-start gap-2">
                <div className="min-w-0 flex-1">
                  <EditableField path={`${ib}/title/${lang}`} biPath={`${ib}/title`} value={item.title[lang]} reference={item.title[other]} label={`${name} item ${item.id} title (${L})`} placeholder={`Title in ${L}`} />
                </div>
                {!env.onlyMissing ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <PinButton path={ib} pinned={item.pinned} name={`${name} item ${itemName}`} />
                    <RemoveButton label={`Remove ${name} item ${itemName}`} onClick={() => void env.save([{ op: "remove", path: ib }])} />
                  </span>
                ) : null}
              </div>
              <EditableField path={`${ib}/text/${lang}`} biPath={`${ib}/text`} value={item.text[lang]} reference={item.text[other]} label={`${name} item ${item.id} text (${L})`} placeholder={`Description in ${L} (optional)`} multiline />
              {!env.onlyMissing ? (
                <div className="grid min-w-0 gap-x-2 @md:grid-cols-[minmax(0,1fr)_12rem]">
                  <EditableField path={`${ib}/url`} value={item.url} label={`${name} item ${item.id} link`} placeholder="https://… (optional)" />
                  <EditableField path={`${ib}/date`} value={item.date} label={`${name} item ${item.id} date`} placeholder="Date, e.g. 2025" />
                </div>
              ) : null}
            </div>
          );
        })}
        {!env.onlyMissing ? (
          <AddRow
            label={`New item in ${name}`}
            buttonLabel="Add item"
            placeholder={`Item title in ${L}`}
            onAdd={(title) => {
              const id = uniqueId(title, new Set(section.items.map((x) => x.id)));
              return env.save([{ op: "add", path: `${base}/items/-`, value: { id, title: { pl: lang === "pl" ? title : "", en: lang === "en" ? title : "" }, text: { pl: "", en: "" } } }]);
            }}
          />
        ) : null}
      </div>
    </ItemCard>
  );
}

/* ------------------------------------------------------- project from GitHub */

export function GithubProjectAdd() {
  const env = useProfileEnv();
  const [repo, setRepo] = useState("");
  const [pinned, setPinned] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<GithubProjectResult | null>(null);

  const add = async () => {
    if (!repo.trim() || busy) return;
    setBusy(true);
    setError("");
    setDone(null);
    try {
      const res = await projectFromGithub(repo.trim(), pinned);
      setDone(res);
      setRepo("");
      env.reload?.(); // the server already saved the project
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const describe = (res: GithubProjectResult) =>
    `Write the CV description of my project “${res.project.name}” (${res.project.url}, path /projects/id=${res.project.id}): fetch its facts with knife_cv_github_repo_facts, then write the summary in Polish and English and 2-4 bullets in both languages that show what it proves (architecture, scale, what I built myself), from the repo's facts only. Keep the technologies list accurate.`;

  return (
    <div className="space-y-2 rounded-xl border border-dashed border-line-strong p-3" aria-label="Add a project from GitHub">
      <p className="text-[13px] font-semibold text-ink">Add from GitHub</p>
      <div className="flex flex-wrap items-center gap-2">
        <TextInput
          aria-label="GitHub repository link"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
          placeholder="https://github.com/you/project"
          className="min-w-0 flex-1 basis-56"
        />
        <label className="flex items-center gap-1.5 text-sm text-muted">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="accent-[var(--color-accent)]" />
          Pin as priority
        </label>
        <Button size="sm" variant="primary" onClick={() => void add()} disabled={!repo.trim() || busy}>{busy ? "Reading the repo…" : "Add from GitHub"}</Button>
      </div>
      <p className="text-xs text-muted">Takes the name, link, technologies and description from the repo. The assistant can then write the summary and bullets from its README and history.</p>
      {error ? <div role="alert"><Notice tone="error">{error}</Notice></div> : null}
      {done ? (
        <div role="status" className="space-y-2">
          <Notice tone="good">
            {done.created ? `Added “${done.project.name}”` : `Updated “${done.project.name}” (your wording was kept)`}: {done.project.tech.join(", ") || "no technologies detected"}.
          </Notice>
          <Button size="sm" onClick={() => openAssistant(describe(done))}>Ask the assistant to describe it</Button>
        </div>
      ) : null}
    </div>
  );
}
