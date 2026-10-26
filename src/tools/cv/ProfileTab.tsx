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
import { useT } from "@/lib/i18n/react";

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
  const { t } = useT();
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
                label={t("{owner} bullet {id} text ({value})", { owner, id: b.id, value: lang.toUpperCase() })}
                placeholder={t("Write this bullet in {value}", { value: lang === "pl" ? "Polish" : "English" })}
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
                  aria-label={t("{value} {owner} bullet {id} as verified", { value: b.verified ? "Unmark" : "Mark", owner, id: b.id })}
                  title={t("Verified = you confirmed this claim is true")}
                  onClick={() => void env.save([{ op: "set", path: `${path}/verified`, value: !b.verified }])}
                  className="cursor-pointer"
                >
                  <Badge tone={b.verified ? "good" : "neutral"}>{b.verified ? t("verified") : t("unverified")}</Badge>
                </button>
                <RemoveButton label={t("Remove {owner} bullet {id}", { owner, id: b.id })} onClick={() => void env.save([{ op: "remove", path }])} />
              </div>
            ) : null}
          </div>
        );
      })}
      {!env.onlyMissing ? (
        <Button
          size="sm"
          aria-label={t("Add bullet to {owner}", { owner })}
          onClick={() => {
            const id = uniqueId("bullet", new Set(bullets.map((b) => b.id)));
            void env.save([{ op: "add", path: `${base}/bullets/-`, value: { id, text: { pl: "", en: "" } } }], `${base}/bullets/id=${id}/text/${lang}`);
          }}
        >
          {t("Add bullet")}
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
  const { t } = useT();
  const { lang, other, onlyMissing } = useProfileEnv();
  const c = profile.contact;
  const L = lang.toUpperCase();
  return (
    <Section id="contact" title={t("Contact")}>
      {!onlyMissing ? (
        <>
          <Row label={t("Name")}><EditableField path="/contact/name" value={c.name} label={t("Name")} placeholder={t("Full name")} /></Row>
          <Row label={t("E-mail")}><EditableField path="/contact/email" value={c.email} label={t("E-mail")} placeholder={t("name@example.com")} /></Row>
          <Row label={t("Phone")}><EditableField path="/contact/phone" value={c.phone} label={t("Phone")} placeholder="+48 …" /></Row>
        </>
      ) : null}
      <Row label={t("Headline {l}", { l: L })}>
        <EditableField path={`/contact/headline/${lang}`} biPath="/contact/headline" value={c.headline[lang]} reference={c.headline[other]} label={t("Headline ({l})", { l: L })} placeholder={t("One-line positioning")} />
      </Row>
      <Row label={t("Location {l}", { l: L })}>
        <EditableField path={`/contact/location/${lang}`} biPath="/contact/location" value={c.location[lang]} reference={c.location[other]} label={t("Location ({l})", { l: L })} placeholder={t("City, country")} />
      </Row>
      {!onlyMissing ? <LinksEditor links={c.links} /> : null}
    </Section>
  );
}

function LinksEditor({ links }: { links: Profile["contact"]["links"] }) {
  const { t } = useT();
  const env = useProfileEnv();
  return (
    <Row label={t("Links")}>
      <div className="space-y-1">
        {links.map((link, i) => (
          <div key={`${i}-${link.url}`} className="flex min-w-0 items-start gap-2" data-cv-path={`/contact/links/${i}`}>
            <div className="grid min-w-0 flex-1 gap-x-2 @md:grid-cols-[10rem_minmax(0,1fr)]">
              <EditableField path={`/contact/links/${i}/label`} value={link.label} label={t("Link {value} label", { value: i + 1 })} placeholder={t("Label")} />
              <EditableField path={`/contact/links/${i}/url`} value={link.url} label={t("Link {value} URL", { value: i + 1 })} placeholder={t("https://…")} />
            </div>
            <RemoveButton label={t("Remove link {value}", { value: i + 1 })} onClick={() => void env.save([{ op: "remove", path: `/contact/links/${i}` }])} />
          </div>
        ))}
        <AddRow
          label={t("New link URL")}
          buttonLabel={t("Add link")}
          placeholder={t("https://github.com/…")}
          onAdd={(url) => env.save([{ op: "add", path: "/contact/links/-", value: { label: url.replace(/^https?:\/\//, "").split("/")[0], url } }])}
        />
      </div>
    </Row>
  );
}

function SummarySection({ profile }: { profile: Profile }) {
  const { t } = useT();
  const { lang, other } = useProfileEnv();
  return (
    <Section id="summary" title={t("Summary")}>
      <EditableField path={`/summary/${lang}`} biPath="/summary" value={profile.summary[lang]} reference={profile.summary[other]} label={t("Summary ({value})", { value: lang.toUpperCase() })} placeholder={t("Two or three sentences about you")} multiline />
    </Section>
  );
}

function ExperienceSection({ profile }: { profile: Profile }) {
  const { t } = useT();
  const env = useProfileEnv();
  const { lang, other } = env;
  const L = lang.toUpperCase();
  return (
    <Section id="experience" title={t("Experience")}>
      {profile.experience.map((e) => (
        <ExperienceCard key={e.id} exp={e} lang={lang} other={other} L={L} />
      ))}
      {!env.onlyMissing ? (
        <AddRow
          label={t("New employer")}
          buttonLabel={t("Add experience")}
          placeholder={t("Employer name")}
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
  const { t } = useT();
  const env = useProfileEnv();
  const base = `/experience/id=${exp.id}`;
  const hidden = useHidden(base);
  if (hidden) return null;
  return (
    <ItemCard
      path={base}
      title={<EditableField path={`${base}/org`} value={exp.org} label={t("Employer {id}", { id: exp.id })} placeholder={t("Employer")} keepInFilter />}
      right={!env.onlyMissing ? <span className="flex items-center gap-1"><PinButton path={base} pinned={exp.pinned} name={`experience ${exp.org || exp.id}`} /><RemoveButton label={t("Remove experience {value}", { value: exp.org || exp.id })} onClick={() => void env.save([{ op: "remove", path: base }])} /></span> : undefined}
    >
      <div className="grid min-w-0 gap-x-3 @md:grid-cols-2">
        <EditableField path={`${base}/role/${lang}`} biPath={`${base}/role`} value={exp.role[lang]} reference={exp.role[other]} label={t("{org} role ({l})", { org: exp.org, l: L })} placeholder={t("Role in {l}", { l: L })} />
        {!env.onlyMissing ? (
          <div className="grid grid-cols-2 gap-x-2">
            <EditableField path={`${base}/start`} value={exp.start} label={t("{org} start (YYYY-MM)", { org: exp.org })} placeholder={t("Start YYYY-MM")} />
            <EditableField path={`${base}/end`} value={exp.end ?? ""} label={t("{org} end (YYYY-MM)", { org: exp.org })} placeholder={t("Present")} nullable />
          </div>
        ) : null}
      </div>
      {!env.onlyMissing ? <EditableField path={`${base}/location`} value={exp.location} label={t("{org} location", { org: exp.org })} placeholder={t("Location")} /> : null}
      <EditableField path={`${base}/note/${lang}`} biPath={`${base}/note`} value={exp.note[lang]} reference={exp.note[other]} label={t("{org} note ({l})", { org: exp.org, l: L })} placeholder={t("Note in {l} (optional)", { l: L })} multiline />
      <BulletList base={base} bullets={exp.bullets} owner={exp.org || exp.id} />
    </ItemCard>
  );
}

function ProjectsSection({ profile }: { profile: Profile }) {
  const { t } = useT();
  const env = useProfileEnv();
  const { lang, other } = env;
  const L = lang.toUpperCase();
  return (
    <Section id="projects" title={t("Projects")}>
      {profile.projects.map((p) => (
        <ProjectCard key={p.id} project={p} lang={lang} other={other} L={L} />
      ))}
      {!env.onlyMissing ? (
        <AddRow
          label={t("New project name")}
          buttonLabel={t("Add project")}
          placeholder={t("Project name")}
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
  const { t } = useT();
  const env = useProfileEnv();
  const base = `/projects/id=${p.id}`;
  if (useHidden(base)) return null;
  return (
    <ItemCard
      path={base}
      title={<EditableField path={`${base}/name`} value={p.name} label={t("Project {id} name", { id: p.id })} placeholder={t("Project")} keepInFilter />}
      right={!env.onlyMissing ? <span className="flex items-center gap-1"><PinButton path={base} pinned={p.pinned} name={`project ${p.name || p.id}`} /><RemoveButton label={t("Remove project {value}", { value: p.name || p.id })} onClick={() => void env.save([{ op: "remove", path: base }])} /></span> : undefined}
    >
      {!env.onlyMissing ? (
        <div className="grid min-w-0 gap-x-3 @md:grid-cols-2">
          <EditableField path={`${base}/url`} value={p.url} label={t("{name} link", { name: p.name })} placeholder={t("https://…")} />
          <EditableField path={`${base}/tech`} value={p.tech.join(", ")} label={t("{name} tech (comma separated)", { name: p.name })} placeholder={t("Tech, comma separated")} list />
        </div>
      ) : null}
      <EditableField path={`${base}/summary/${lang}`} biPath={`${base}/summary`} value={p.summary[lang]} reference={p.summary[other]} label={t("{name} summary ({l})", { name: p.name, l: L })} placeholder={t("Summary in {l}", { l: L })} multiline />
      <BulletList base={base} bullets={p.bullets} owner={p.name || p.id} />
    </ItemCard>
  );
}

function SkillsSection({ profile }: { profile: Profile }) {
  const { t } = useT();
  const env = useProfileEnv();
  const { lang, other } = env;
  const L = lang.toUpperCase();
  return (
    <Section id="skills" title={t("Skills")}>
      {profile.skills.map((s) => (
        <SkillCard key={s.id} group={s} lang={lang} other={other} L={L} />
      ))}
      {!env.onlyMissing ? (
        <AddRow
          label={t("New skill group name")}
          buttonLabel={t("Add skill group")}
          placeholder={t("Group name in {l}, e.g. Languages", { l: L })}
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
  const { t } = useT();
  const env = useProfileEnv();
  const base = `/skills/id=${s.id}`;
  if (useHidden(base)) return null;
  return (
    <ItemCard
      path={base}
      title={<EditableField path={`${base}/name/${lang}`} biPath={`${base}/name`} keepInFilter value={s.name[lang]} reference={s.name[other]} label={t("Skill group {id} name ({l})", { id: s.id, l: L })} placeholder={t("Group name in {l}", { l: L })} />}
      right={!env.onlyMissing ? <span className="flex items-center gap-1"><PinButton path={base} pinned={s.pinned} name={`skill group ${s.name[lang] || s.id}`} /><RemoveButton label={t("Remove skill group {value}", { value: s.name[lang] || s.id })} onClick={() => void env.save([{ op: "remove", path: base }])} /></span> : undefined}
    >
      {!env.onlyMissing ? <EditableField path={`${base}/items`} value={s.items.join(", ")} label={t("{value} items (comma separated)", { value: s.name[lang] || s.id })} placeholder={t("Skills, comma separated")} list /> : null}
    </ItemCard>
  );
}

function EducationSection({ profile }: { profile: Profile }) {
  const { t } = useT();
  const env = useProfileEnv();
  const { lang, other } = env;
  const L = lang.toUpperCase();
  return (
    <Section id="education" title={t("Education")}>
      {profile.education.map((ed) => {
        const base = `/education/id=${ed.id}`;
        return (
          <EducationCard key={ed.id} base={base}>
            <ItemCard
              path={base}
              title={<EditableField path={`${base}/institution`} value={ed.institution} label={t("Institution {id}", { id: ed.id })} placeholder={t("Institution")} keepInFilter />}
              right={!env.onlyMissing ? <RemoveButton label={t("Remove education {value}", { value: ed.institution || ed.id })} onClick={() => void env.save([{ op: "remove", path: base }])} /> : undefined}
            >
              <EditableField path={`${base}/detail/${lang}`} biPath={`${base}/detail`} value={ed.detail[lang]} reference={ed.detail[other]} label={t("{institution} detail ({l})", { institution: ed.institution, l: L })} placeholder={t("Degree / field in {l}", { l: L })} />
              {!env.onlyMissing ? (
                <div className="grid grid-cols-2 gap-x-2">
                  <EditableField path={`${base}/start`} value={ed.start} label={t("{institution} start (YYYY-MM)", { institution: ed.institution })} placeholder={t("Start YYYY-MM")} />
                  <EditableField path={`${base}/end`} value={ed.end ?? ""} label={t("{institution} end (YYYY-MM)", { institution: ed.institution })} placeholder={t("End YYYY-MM")} nullable />
                </div>
              ) : null}
            </ItemCard>
          </EducationCard>
        );
      })}
      {!env.onlyMissing ? (
        <AddRow
          label={t("New institution")}
          buttonLabel={t("Add education")}
          placeholder={t("School or university")}
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
  const { t } = useT();
  const env = useProfileEnv();
  const { lang, other } = env;
  const L = lang.toUpperCase();
  return (
    <Section id="languages" title={t("Spoken languages")}>
      {profile.languages.map((l) => {
        const base = `/languages/id=${l.id}`;
        return (
          <EducationCard key={l.id} base={base}>
            <div data-cv-path={base} className="flex min-w-0 items-start gap-2">
              <div className="grid min-w-0 flex-1 gap-x-3 @md:grid-cols-2">
                <EditableField path={`${base}/name/${lang}`} biPath={`${base}/name`} value={l.name[lang]} reference={l.name[other]} label={t("Language {id} name ({l})", { id: l.id, l: L })} placeholder={t("Language in {l}", { l: L })} />
                <EditableField path={`${base}/level/${lang}`} biPath={`${base}/level`} value={l.level[lang]} reference={l.level[other]} label={t("Language {id} level ({l})", { id: l.id, l: L })} placeholder={t("Level in {l}", { l: L })} />
              </div>
              {!env.onlyMissing ? <RemoveButton label={t("Remove language {value}", { value: l.name[lang] || l.id })} onClick={() => void env.save([{ op: "remove", path: base }])} /> : null}
            </div>
          </EducationCard>
        );
      })}
      {!env.onlyMissing ? (
        <AddRow
          label={t("New spoken language")}
          buttonLabel={t("Add language")}
          placeholder={t("Language in {l}, e.g. English", { l: L })}
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
  const { t } = useT();
  const { lang, other } = useProfileEnv();
  const L = lang.toUpperCase();
  return (
    <>
      <Section id="consent" title={t("Consent clause (RODO / GDPR)")}>
        <EditableField path={`/consent/${lang}`} biPath="/consent" value={profile.consent[lang]} reference={profile.consent[other]} label={t("Consent clause ({l})", { l: L })} placeholder={t("Clause printed on {l} applications", { l: L })} multiline />
      </Section>
      <Section id="extras" title={t("How I work")}>
        <EditableField path={`/extras/${lang}`} biPath="/extras" value={profile.extras[lang]} reference={profile.extras[other]} label={t("How I work ({l})", { l: L })} placeholder={t("Free-form paragraph in {l}", { l: L })} multiline />
      </Section>
    </>
  );
}

/* --------------------------------------------------------------------- tab */

export default function ProfileTab() {
  const { t } = useT();
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
            <EmptyState title={t("Your master profile starts here")}>
              {t("One bilingual profile feeds every CV version, the audit and the offer matching. Paste it below, or ask the assistant to structure your CV text and import it.")}
            </EmptyState>
            <ProfileImport existing={null} onImported={() => void live.reload()} />
          </div>
        ) : (
          <div className="@container space-y-4">
            <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label={t("Profile actions")}>
              <LangToggle tab={TAB} />
              {missing.size > 0 ? (
                <Badge tone="warn" title={t("{missing} fields are written in {value} but empty in {value2}", { missing: missing.size, value: env.other.toUpperCase(), value2: lang.toUpperCase() })}>
                  {t("{missing} untranslated in {value}", { missing: missing.size, value: lang.toUpperCase() })}
                </Badge>
              ) : (
                <Badge tone="good">{t("Fully translated to")}{" "} {lang.toUpperCase()}</Badge>
              )}
              <Button size="sm" aria-pressed={onlyMissing} variant={onlyMissing ? "primary" : "subtle"} disabled={missing.size === 0 && !onlyMissing} onClick={() => setOnlyMissing((v) => !v)}>
                {onlyMissing ? t("Show everything") : t("Show untranslated")}
              </Button>
              <span className="flex-1" />
              <Button
                size="sm"
                onClick={async () => setUndoError(await live.undo())}
                aria-label={t("Undo the last change")}
              >
                {t("Undo")}
              </Button>
              <Button size="sm" onClick={() => setReplacing((v) => !v)}>{replacing ? t("Close import") : t("Replace profile…")}</Button>
            </div>
            <StatGrid aria-label={t("Profile overview")}>
              <Stat label={t("Roles")} value={String(cv.profile.experience.length)} />
              <Stat label={t("Bullets")} value={String(cv.profile.experience.reduce((n, e) => n + e.bullets.length, 0) + cv.profile.projects.reduce((n, p) => n + p.bullets.length, 0))} />
              <Stat label={t("Projects")} value={String(cv.profile.projects.length)} />
              <Stat label={t("Skill groups")} value={String(cv.profile.skills.length)} />
              <Stat label={t("To translate ({value})", { value: lang.toUpperCase() })} value={String(missing.size)} />
              <Stat label={t("Audit findings")} value={audit.result ? String(Object.values(audit.result.findings).reduce((n, f) => n + f.length, 0)) : "–"} />
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
                  {onlyMissing && missing.size === 0 ? <Notice tone="good">{t("Nothing left to translate.")}</Notice> : null}
                </div>
                <aside className="min-w-0 space-y-4 @4xl:sticky @4xl:top-4 @4xl:self-start" aria-label={t("Profile checks")}>
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
