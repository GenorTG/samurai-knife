"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Badge, Button, EmptyState, Notice, Panel, Stat, StatGrid } from "@/components/ui";
import { errorText, patchCv } from "@/lib/cv/client";
import { uniqueId } from "@/lib/cv/collections";
import type { CvOp } from "@/lib/cv/ops";
import { missingTranslations } from "@/lib/cv/ops";
import type { Bullet } from "./types";
import type { CvLang, Profile } from "@/lib/cv/schema";
import { AuditPanel, useAudit } from "./ProfileAudit";
import { PhotoPanel } from "./PhotoPanel";
import { ProfileImport } from "./ProfileImport";
import { AddRow, EditableField, ItemCard, PinButton, ProfileEnvProvider, RemoveButton, useHidden, useProfileEnv, type ProfileEnv } from "./profile-fields";
import { CustomSectionsSection, GithubProjectAdd, TailoringSection } from "./ProfilePriority";
import { CvFrame, flashElement, LangToggle, profileIsEmpty, useLang } from "./shared";
import { useCvData } from "./useCvData";

const TAB = "profile";

/* ------------------------------------------------------------------ helpers */

function scrollToPath(path: string, lang: CvLang): boolean {
  const all = Array.from(document.querySelectorAll<HTMLElement>("[data-cv-path]"));
  let probe = path;
  while (probe) {
    const el = all.find((e) => e.dataset.cvPath === probe) ?? all.find((e) => e.dataset.cvPath === `${probe}/${lang}`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      flashElement(el);
      return true;
    }
    probe = probe.slice(0, Math.max(0, probe.lastIndexOf("/")));
  }
  return false;
}

const bi = (lang: CvLang, text: string) => ({ pl: lang === "pl" ? text : "", en: lang === "en" ? text : "" });

/* ------------------------------------------------------------------ bullets */

function BulletList({ base, bullets, owner }: { base: string; bullets: Bullet[]; owner: string }) {
  const env = useProfileEnv();
  const { lang, other } = env;
  return (
    <div className="mt-2 space-y-1">
      {bullets.map((b) => {
        const path = `${base}/bullets/id=${b.id}`;
        const textPath = `${path}/text/${lang}`;
        return (
          <div key={b.id} className="flex min-w-0 items-start gap-2" data-cv-path={path}>
            <span className="mt-2 size-1.5 shrink-0 rounded-full bg-faint" aria-hidden />
            <div className="min-w-0 flex-1">
              <EditableField
                path={textPath}
                biPath={`${path}/text`}
                value={b.text[lang]}
                reference={b.text[other]}
                label={`${owner} bullet ${b.id} text (${lang.toUpperCase()})`}
                placeholder={`Write this bullet in ${lang === "pl" ? "Polish" : "English"}`}
                multiline
              />
            </div>
            {!env.onlyMissing ? (
              <div className="flex shrink-0 items-center gap-1">
                <PinButton path={path} pinned={b.pinned} name={`${owner} bullet ${b.id}`} />
                <button
                  autoComplete="off"
                  type="button"
                  aria-pressed={b.verified}
                  aria-label={`${b.verified ? "Unmark" : "Mark"} ${owner} bullet ${b.id} as verified`}
                  title="Verified = you confirmed this claim is true"
                  onClick={() => void env.save([{ op: "set", path: `${path}/verified`, value: !b.verified }])}
                  className="cursor-pointer"
                >
                  <Badge tone={b.verified ? "good" : "neutral"}>{b.verified ? "verified" : "unverified"}</Badge>
                </button>
                <RemoveButton label={`Remove ${owner} bullet ${b.id}`} onClick={() => void env.save([{ op: "remove", path }])} />
              </div>
            ) : null}
          </div>
        );
      })}
      {!env.onlyMissing ? (
        <Button
          size="sm"
          aria-label={`Add bullet to ${owner}`}
          onClick={() => {
            const id = uniqueId("bullet", new Set(bullets.map((b) => b.id)));
            void env.save([{ op: "add", path: `${base}/bullets/-`, value: { id, text: { pl: "", en: "" } } }], `${base}/bullets/id=${id}/text/${lang}`);
          }}
        >
          Add bullet
        </Button>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- sections */

function Section({ id, title, children, right }: { id: string; title: string; children: React.ReactNode; right?: React.ReactNode }) {
  const hidden = useHidden(`/${id}`);
  if (hidden) return null;
  return (
    <div data-cv-path={`/${id}`}>
      <Panel title={title} right={right}>
        <div className="space-y-3">{children}</div>
      </Panel>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 items-start gap-x-3 @md:grid-cols-[8.5rem_minmax(0,1fr)]">
      <span className="sk-label pt-1.5">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function ContactSection({ profile }: { profile: Profile }) {
  const { lang, other, onlyMissing } = useProfileEnv();
  const c = profile.contact;
  const L = lang.toUpperCase();
  return (
    <Section id="contact" title="Contact">
      {!onlyMissing ? (
        <>
          <Row label="Name"><EditableField path="/contact/name" value={c.name} label="Name" placeholder="Full name" /></Row>
          <Row label="E-mail"><EditableField path="/contact/email" value={c.email} label="E-mail" placeholder="name@example.com" /></Row>
          <Row label="Phone"><EditableField path="/contact/phone" value={c.phone} label="Phone" placeholder="+48 …" /></Row>
        </>
      ) : null}
      <Row label={`Headline ${L}`}>
        <EditableField path={`/contact/headline/${lang}`} biPath="/contact/headline" value={c.headline[lang]} reference={c.headline[other]} label={`Headline (${L})`} placeholder="One-line positioning" />
      </Row>
      <Row label={`Location ${L}`}>
        <EditableField path={`/contact/location/${lang}`} biPath="/contact/location" value={c.location[lang]} reference={c.location[other]} label={`Location (${L})`} placeholder="City, country" />
      </Row>
      {!onlyMissing ? <LinksEditor links={c.links} /> : null}
    </Section>
  );
}

function LinksEditor({ links }: { links: Profile["contact"]["links"] }) {
  const env = useProfileEnv();
  return (
    <Row label="Links">
      <div className="space-y-1">
        {links.map((link, i) => (
          <div key={`${i}-${link.url}`} className="flex min-w-0 items-start gap-2" data-cv-path={`/contact/links/${i}`}>
            <div className="grid min-w-0 flex-1 gap-x-2 @md:grid-cols-[10rem_minmax(0,1fr)]">
              <EditableField path={`/contact/links/${i}/label`} value={link.label} label={`Link ${i + 1} label`} placeholder="Label" />
              <EditableField path={`/contact/links/${i}/url`} value={link.url} label={`Link ${i + 1} URL`} placeholder="https://…" />
            </div>
            <RemoveButton label={`Remove link ${i + 1}`} onClick={() => void env.save([{ op: "remove", path: `/contact/links/${i}` }])} />
          </div>
        ))}
        <AddRow
          label="New link URL"
          buttonLabel="Add link"
          placeholder="https://github.com/…"
          onAdd={(url) => env.save([{ op: "add", path: "/contact/links/-", value: { label: url.replace(/^https?:\/\//, "").split("/")[0], url } }])}
        />
      </div>
    </Row>
  );
}

function SummarySection({ profile }: { profile: Profile }) {
  const { lang, other } = useProfileEnv();
  return (
    <Section id="summary" title="Summary">
      <EditableField path={`/summary/${lang}`} biPath="/summary" value={profile.summary[lang]} reference={profile.summary[other]} label={`Summary (${lang.toUpperCase()})`} placeholder="Two or three sentences about you" multiline />
    </Section>
  );
}

function ExperienceSection({ profile }: { profile: Profile }) {
  const env = useProfileEnv();
  const { lang, other } = env;
  const L = lang.toUpperCase();
  return (
    <Section id="experience" title="Experience">
      {profile.experience.map((e) => (
        <ExperienceCard key={e.id} exp={e} lang={lang} other={other} L={L} />
      ))}
      {!env.onlyMissing ? (
        <AddRow
          label="New employer"
          buttonLabel="Add experience"
          placeholder="Employer name"
          onAdd={(org) => {
            const id = uniqueId(org, new Set(profile.experience.map((x) => x.id)));
            return env.save([{ op: "add", path: "/experience/-", value: { id, org, role: { pl: "", en: "" }, start: "", end: null, bullets: [] } }]);
          }}
        />
      ) : null}
    </Section>
  );
}

function ExperienceCard({ exp, lang, other, L }: { exp: Profile["experience"][number]; lang: CvLang; other: CvLang; L: string }) {
  const env = useProfileEnv();
  const base = `/experience/id=${exp.id}`;
  const hidden = useHidden(base);
  if (hidden) return null;
  return (
    <ItemCard
      path={base}
      title={<EditableField path={`${base}/org`} value={exp.org} label={`Employer ${exp.id}`} placeholder="Employer" keepInFilter />}
      right={!env.onlyMissing ? <span className="flex items-center gap-1"><PinButton path={base} pinned={exp.pinned} name={`experience ${exp.org || exp.id}`} /><RemoveButton label={`Remove experience ${exp.org || exp.id}`} onClick={() => void env.save([{ op: "remove", path: base }])} /></span> : undefined}
    >
      <div className="grid min-w-0 gap-x-3 @md:grid-cols-2">
        <EditableField path={`${base}/role/${lang}`} biPath={`${base}/role`} value={exp.role[lang]} reference={exp.role[other]} label={`${exp.org} role (${L})`} placeholder={`Role in ${L}`} />
        {!env.onlyMissing ? (
          <div className="grid grid-cols-2 gap-x-2">
            <EditableField path={`${base}/start`} value={exp.start} label={`${exp.org} start (YYYY-MM)`} placeholder="Start YYYY-MM" />
            <EditableField path={`${base}/end`} value={exp.end ?? ""} label={`${exp.org} end (YYYY-MM)`} placeholder="Present" nullable />
          </div>
        ) : null}
      </div>
      {!env.onlyMissing ? <EditableField path={`${base}/location`} value={exp.location} label={`${exp.org} location`} placeholder="Location" /> : null}
      <EditableField path={`${base}/note/${lang}`} biPath={`${base}/note`} value={exp.note[lang]} reference={exp.note[other]} label={`${exp.org} note (${L})`} placeholder={`Note in ${L} (optional)`} multiline />
      <BulletList base={base} bullets={exp.bullets} owner={exp.org || exp.id} />
    </ItemCard>
  );
}

function ProjectsSection({ profile }: { profile: Profile }) {
  const env = useProfileEnv();
  const { lang, other } = env;
  const L = lang.toUpperCase();
  return (
    <Section id="projects" title="Projects">
      {profile.projects.map((p) => (
        <ProjectCard key={p.id} project={p} lang={lang} other={other} L={L} />
      ))}
      {!env.onlyMissing ? (
        <AddRow
          label="New project name"
          buttonLabel="Add project"
          placeholder="Project name"
          onAdd={(name) => {
            const id = uniqueId(name, new Set(profile.projects.map((x) => x.id)));
            return env.save([{ op: "add", path: "/projects/-", value: { id, name, url: "", summary: { pl: "", en: "" }, tech: [], bullets: [] } }]);
          }}
        />
      ) : null}
      {!env.onlyMissing ? <GithubProjectAdd /> : null}
    </Section>
  );
}

function ProjectCard({ project: p, lang, other, L }: { project: Profile["projects"][number]; lang: CvLang; other: CvLang; L: string }) {
  const env = useProfileEnv();
  const base = `/projects/id=${p.id}`;
  if (useHidden(base)) return null;
  return (
    <ItemCard
      path={base}
      title={<EditableField path={`${base}/name`} value={p.name} label={`Project ${p.id} name`} placeholder="Project" keepInFilter />}
      right={!env.onlyMissing ? <span className="flex items-center gap-1"><PinButton path={base} pinned={p.pinned} name={`project ${p.name || p.id}`} /><RemoveButton label={`Remove project ${p.name || p.id}`} onClick={() => void env.save([{ op: "remove", path: base }])} /></span> : undefined}
    >
      {!env.onlyMissing ? (
        <div className="grid min-w-0 gap-x-3 @md:grid-cols-2">
          <EditableField path={`${base}/url`} value={p.url} label={`${p.name} link`} placeholder="https://…" />
          <EditableField path={`${base}/tech`} value={p.tech.join(", ")} label={`${p.name} tech (comma separated)`} placeholder="Tech, comma separated" list />
        </div>
      ) : null}
      <EditableField path={`${base}/summary/${lang}`} biPath={`${base}/summary`} value={p.summary[lang]} reference={p.summary[other]} label={`${p.name} summary (${L})`} placeholder={`Summary in ${L}`} multiline />
      <BulletList base={base} bullets={p.bullets} owner={p.name || p.id} />
    </ItemCard>
  );
}

function SkillsSection({ profile }: { profile: Profile }) {
  const env = useProfileEnv();
  const { lang, other } = env;
  const L = lang.toUpperCase();
  return (
    <Section id="skills" title="Skills">
      {profile.skills.map((s) => (
        <SkillCard key={s.id} group={s} lang={lang} other={other} L={L} />
      ))}
      {!env.onlyMissing ? (
        <AddRow
          label="New skill group name"
          buttonLabel="Add skill group"
          placeholder={`Group name in ${L}, e.g. Languages`}
          onAdd={(name) => {
            const id = uniqueId(name, new Set(profile.skills.map((x) => x.id)));
            return env.save([{ op: "add", path: "/skills/-", value: { id, name: bi(lang, name), items: [] } }]);
          }}
        />
      ) : null}
    </Section>
  );
}

function SkillCard({ group: s, lang, other, L }: { group: Profile["skills"][number]; lang: CvLang; other: CvLang; L: string }) {
  const env = useProfileEnv();
  const base = `/skills/id=${s.id}`;
  if (useHidden(base)) return null;
  return (
    <ItemCard
      path={base}
      title={<EditableField path={`${base}/name/${lang}`} biPath={`${base}/name`} keepInFilter value={s.name[lang]} reference={s.name[other]} label={`Skill group ${s.id} name (${L})`} placeholder={`Group name in ${L}`} />}
      right={!env.onlyMissing ? <span className="flex items-center gap-1"><PinButton path={base} pinned={s.pinned} name={`skill group ${s.name[lang] || s.id}`} /><RemoveButton label={`Remove skill group ${s.name[lang] || s.id}`} onClick={() => void env.save([{ op: "remove", path: base }])} /></span> : undefined}
    >
      {!env.onlyMissing ? <EditableField path={`${base}/items`} value={s.items.join(", ")} label={`${s.name[lang] || s.id} items (comma separated)`} placeholder="Skills, comma separated" list /> : null}
    </ItemCard>
  );
}

function EducationSection({ profile }: { profile: Profile }) {
  const env = useProfileEnv();
  const { lang, other } = env;
  const L = lang.toUpperCase();
  return (
    <Section id="education" title="Education">
      {profile.education.map((ed) => {
        const base = `/education/id=${ed.id}`;
        return (
          <EducationCard key={ed.id} base={base}>
            <ItemCard
              path={base}
              title={<EditableField path={`${base}/institution`} value={ed.institution} label={`Institution ${ed.id}`} placeholder="Institution" keepInFilter />}
              right={!env.onlyMissing ? <RemoveButton label={`Remove education ${ed.institution || ed.id}`} onClick={() => void env.save([{ op: "remove", path: base }])} /> : undefined}
            >
              <EditableField path={`${base}/detail/${lang}`} biPath={`${base}/detail`} value={ed.detail[lang]} reference={ed.detail[other]} label={`${ed.institution} detail (${L})`} placeholder={`Degree / field in ${L}`} />
              {!env.onlyMissing ? (
                <div className="grid grid-cols-2 gap-x-2">
                  <EditableField path={`${base}/start`} value={ed.start} label={`${ed.institution} start (YYYY-MM)`} placeholder="Start YYYY-MM" />
                  <EditableField path={`${base}/end`} value={ed.end ?? ""} label={`${ed.institution} end (YYYY-MM)`} placeholder="End YYYY-MM" nullable />
                </div>
              ) : null}
            </ItemCard>
          </EducationCard>
        );
      })}
      {!env.onlyMissing ? (
        <AddRow
          label="New institution"
          buttonLabel="Add education"
          placeholder="School or university"
          onAdd={(institution) => {
            const id = uniqueId(institution, new Set(profile.education.map((x) => x.id)));
            return env.save([{ op: "add", path: "/education/-", value: { id, institution, detail: { pl: "", en: "" }, start: "", end: null } }]);
          }}
        />
      ) : null}
    </Section>
  );
}

function EducationCard({ base, children }: { base: string; children: React.ReactNode }) {
  return useHidden(base) ? null : <>{children}</>;
}

function LanguagesSection({ profile }: { profile: Profile }) {
  const env = useProfileEnv();
  const { lang, other } = env;
  const L = lang.toUpperCase();
  return (
    <Section id="languages" title="Spoken languages">
      {profile.languages.map((l) => {
        const base = `/languages/id=${l.id}`;
        return (
          <EducationCard key={l.id} base={base}>
            <div data-cv-path={base} className="flex min-w-0 items-start gap-2">
              <div className="grid min-w-0 flex-1 gap-x-3 @md:grid-cols-2">
                <EditableField path={`${base}/name/${lang}`} biPath={`${base}/name`} value={l.name[lang]} reference={l.name[other]} label={`Language ${l.id} name (${L})`} placeholder={`Language in ${L}`} />
                <EditableField path={`${base}/level/${lang}`} biPath={`${base}/level`} value={l.level[lang]} reference={l.level[other]} label={`Language ${l.id} level (${L})`} placeholder={`Level in ${L}`} />
              </div>
              {!env.onlyMissing ? <RemoveButton label={`Remove language ${l.name[lang] || l.id}`} onClick={() => void env.save([{ op: "remove", path: base }])} /> : null}
            </div>
          </EducationCard>
        );
      })}
      {!env.onlyMissing ? (
        <AddRow
          label="New spoken language"
          buttonLabel="Add language"
          placeholder={`Language in ${L}, e.g. English`}
          onAdd={(name) => {
            const id = uniqueId(name, new Set(profile.languages.map((x) => x.id)));
            return env.save([{ op: "add", path: "/languages/-", value: { id, name: bi(lang, name), level: { pl: "", en: "" } } }]);
          }}
        />
      ) : null}
    </Section>
  );
}

function FreeTextSection({ profile }: { profile: Profile }) {
  const { lang, other } = useProfileEnv();
  const L = lang.toUpperCase();
  return (
    <>
      <Section id="consent" title="Consent clause (RODO / GDPR)">
        <EditableField path={`/consent/${lang}`} biPath="/consent" value={profile.consent[lang]} reference={profile.consent[other]} label={`Consent clause (${L})`} placeholder={`Clause printed on ${L} applications`} multiline />
      </Section>
      <Section id="extras" title="How I work">
        <EditableField path={`/extras/${lang}`} biPath="/extras" value={profile.extras[lang]} reference={profile.extras[other]} label={`How I work (${L})`} placeholder={`Free-form paragraph in ${L}`} multiline />
      </Section>
    </>
  );
}

/* --------------------------------------------------------------------- tab */

export default function ProfileTab() {
  const live = useCvData();
  const lang = useLang(TAB);
  const params = useSearchParams();
  const focus = params.get("focus") ?? "";
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [autoEdit, setAutoEdit] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [undoError, setUndoError] = useState("");
  const data = live.data;
  const profile = data?.profile ?? null;
  const audit = useAudit(lang, data ? data.revision : null);

  const missing = useMemo(() => new Set(profile ? missingTranslations(profile, lang) : []), [profile, lang]);
  const { reload } = live;

  const save = useCallback(
    async (ops: CvOp[], openAfter?: string): Promise<string> => {
      try {
        await patchCv(ops);
        await reload();
        if (openAfter) setAutoEdit(openAfter);
        return "";
      } catch (e) {
        return errorText(e);
      }
    },
    [reload],
  );

  useEffect(() => {
    if (!autoEdit) return;
    const timer = setTimeout(() => setAutoEdit(""), 600);
    return () => clearTimeout(timer);
  }, [autoEdit]);

  // Deep link from the other tabs (?focus=<id-path>): scroll to the field once the profile is on screen.
  const [handledFocus, setHandledFocus] = useState("");
  useEffect(() => {
    if (!focus || !profile || handledFocus === focus) return;
    const timer = setTimeout(() => {
      scrollToPath(focus, lang);
      setHandledFocus(focus);
    }, 150);
    return () => clearTimeout(timer);
  }, [focus, profile, handledFocus, lang]);

  const go = (path: string) => {
    if (onlyMissing) setOnlyMissing(false);
    setTimeout(() => scrollToPath(path, lang), onlyMissing ? 80 : 0);
  };

  const env: ProfileEnv = { lang, other: lang === "pl" ? "en" : "pl", onlyMissing, missing, findings: audit.result?.findings ?? {}, save, autoEdit, reload: () => void reload() };

  return (
    <CvFrame live={live}>
      {(cv) =>
        profileIsEmpty(cv) && !replacing ? (
          <div className="space-y-4">
            <EmptyState title="Your master profile starts here">
              One bilingual profile feeds every CV version, the audit and the offer matching. Paste it below, or ask the assistant to structure your CV text and import it.
            </EmptyState>
            <ProfileImport existing={null} onImported={() => void live.reload()} />
          </div>
        ) : (
          <div className="@container space-y-4">
            <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Profile actions">
              <LangToggle tab={TAB} />
              {missing.size > 0 ? (
                <Badge tone="warn" title={`${missing.size} fields are written in ${env.other.toUpperCase()} but empty in ${lang.toUpperCase()}`}>
                  {missing.size} untranslated in {lang.toUpperCase()}
                </Badge>
              ) : (
                <Badge tone="good">Fully translated to {lang.toUpperCase()}</Badge>
              )}
              <Button size="sm" aria-pressed={onlyMissing} variant={onlyMissing ? "primary" : "subtle"} disabled={missing.size === 0 && !onlyMissing} onClick={() => setOnlyMissing((v) => !v)}>
                {onlyMissing ? "Show everything" : "Show untranslated"}
              </Button>
              <span className="flex-1" />
              <Button
                size="sm"
                onClick={async () => setUndoError(await live.undo())}
                aria-label="Undo the last change"
              >
                Undo
              </Button>
              <Button size="sm" onClick={() => setReplacing((v) => !v)}>{replacing ? "Close import" : "Replace profile…"}</Button>
            </div>
            <StatGrid aria-label="Profile overview">
              <Stat label="Roles" value={String(cv.profile.experience.length)} />
              <Stat label="Bullets" value={String(cv.profile.experience.reduce((n, e) => n + e.bullets.length, 0) + cv.profile.projects.reduce((n, p) => n + p.bullets.length, 0))} />
              <Stat label="Projects" value={String(cv.profile.projects.length)} />
              <Stat label="Skill groups" value={String(cv.profile.skills.length)} />
              <Stat label={`To translate (${lang.toUpperCase()})`} value={String(missing.size)} />
              <Stat label="Audit findings" value={audit.result ? String(Object.values(audit.result.findings).reduce((n, f) => n + f.length, 0)) : "–"} />
            </StatGrid>
            {undoError ? <div role="alert"><Notice tone="warn">{undoError}</Notice></div> : null}
            {replacing ? <ProfileImport existing={cv.profile} onImported={() => { setReplacing(false); void live.reload(); }} onCancel={() => setReplacing(false)} /> : null}
            <ProfileEnvProvider value={env}>
              <div className="grid min-w-0 gap-4 @4xl:grid-cols-[minmax(0,1fr)_22rem]">
                <div className="min-w-0 space-y-4">
                  <ContactSection profile={cv.profile} />
                  {!onlyMissing ? <PhotoPanel /> : null}
                  {!onlyMissing ? <TailoringSection profile={cv.profile} /> : null}
                  <SummarySection profile={cv.profile} />
                  <ExperienceSection profile={cv.profile} />
                  <ProjectsSection profile={cv.profile} />
                  <SkillsSection profile={cv.profile} />
                  <EducationSection profile={cv.profile} />
                  <LanguagesSection profile={cv.profile} />
                  <CustomSectionsSection profile={cv.profile} />
                  <FreeTextSection profile={cv.profile} />
                  {onlyMissing && missing.size === 0 ? <Notice tone="good">Nothing left to translate.</Notice> : null}
                </div>
                <aside className="min-w-0 space-y-4 @4xl:sticky @4xl:top-4 @4xl:self-start" aria-label="Profile checks">
                  <AuditPanel audit={audit} profile={cv.profile} lang={lang} onGo={go} />
                </aside>
              </div>
            </ProfileEnvProvider>
          </div>
        )
      }
    </CvFrame>
  );
}
