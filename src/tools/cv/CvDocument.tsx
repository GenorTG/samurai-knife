"use client";

import { Fragment, useMemo, type CSSProperties, type ReactNode } from "react";
import { buildCvView, type CvContactKind, type CvView } from "@/lib/cv/render/view";
import { accentOf, CV_LAYOUT_INFO, DEFAULT_LOOK, fontsOf, iconsOf, PAPER_MM, tintOf, type CvLayout, type CvLook, type CvPageMode, type PhotoShape } from "@/lib/cv/render/layout";
import type { CvLang, Profile } from "@/lib/cv/schema";
import "./cv-document.css";
import { useT } from "@/lib/i18n/react";

const EMPTY_NOTE: Record<CvLang, string> = {
  en: "Nothing to show in English yet.",
  pl: "Nothing to show in Polish yet.",
};

/**
 * Print the CV. The print stylesheet in `cv-document.css` hides everything on the page except the sheet and flattens
 * its ancestors, so this is `window.print()` plus a sensible PDF file name (Chrome derives it from `document.title`).
 * Browser only: call it from an event handler.
 */
export function printCv(el?: HTMLElement | null): void {
  const sheet = el ?? document.querySelector<HTMLElement>("[data-cv-document]");
  if (!sheet) throw new Error("There is no CV on the page to print.");
  const previous = document.title;
  const title = sheet.dataset.cvTitle;
  if (title) document.title = title;
  const restore = () => {
    document.title = previous;
    window.removeEventListener("afterprint", restore);
  };
  window.addEventListener("afterprint", restore);
  window.print();
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return href ? (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

/** Small line icons for contact items (inline SVG: prints and exports as vectors, no icon font). */
const ICON_PATHS: Record<CvContactKind, string> = {
  place: "M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21zm0-9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  email: "M3 6h18v12H3zM3 6l9 7 9-7",
  phone: "M6.6 3.5l2.6 4-1.7 1.7a12 12 0 0 0 7.3 7.3l1.7-1.7 4 2.6-1.3 2.9C12 20 4 12 3.7 4.8z",
  linkedin: "M4 9h4v11H4zM6 3.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM10 9h4v1.6c.6-1 1.8-1.9 3.6-1.9 3 0 3.4 2 3.4 4.6V20h-4v-6c0-1.4-.3-2.5-1.7-2.5S14 12.6 14 14v6h-4z",
  github: "M12 3a9 9 0 0 0-2.8 17.6c.4 0 .6-.2.6-.5v-1.7c-2.5.5-3-1.1-3-1.1-.4-1-1-1.3-1-1.3-.8-.6.1-.6.1-.6.9.1 1.4 1 1.4 1 .8 1.4 2.1 1 2.6.8.1-.6.3-1 .6-1.2-2-.2-4.1-1-4.1-4.4 0-1 .4-1.8.9-2.4-.1-.2-.4-1.2.1-2.4 0 0 .8-.2 2.5.9a8.6 8.6 0 0 1 4.5 0c1.7-1.1 2.5-.9 2.5-.9.5 1.2.2 2.2.1 2.4.6.6.9 1.4.9 2.4 0 3.4-2.1 4.2-4.1 4.4.3.3.6.8.6 1.6v2.4c0 .3.2.6.6.5A9 9 0 0 0 12 3z",
  web: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z",
};

function Icon({ kind }: { kind: CvContactKind }) {
  const filled = kind === "linkedin" || kind === "github";
  return (
    <svg className="cv-icon" viewBox="0 0 24 24" width="9" height="9" aria-hidden="true" focusable="false">
      <path d={ICON_PATHS[kind]} fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Bullets({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="cv-bullets">
      {items.map((text, i) => (
        <li key={i}>{text}</li>
      ))}
    </ul>
  );
}

/** Entries of up to 4 bullets stay in one piece across a page break; longer ones may split after the first bullet. */
function Entry({ bullets, children }: { bullets: string[]; children: ReactNode }) {
  return <article className={bullets.length <= 4 ? "cv-entry is-short" : "cv-entry"}>{children}</article>;
}

interface Opts {
  icons: boolean;
  /** Skills as tags (Technical). */
  tags: boolean;
}

function Masthead({ cv, photo, opts, contact = true }: { cv: CvView; photo?: ReactNode; opts: Opts; contact?: boolean }) {
  return (
    <header className={photo ? "cv-masthead has-photo" : "cv-masthead"}>
      {photo}
      <div className="cv-masthead-text">
        {cv.name && <h1>{cv.name}</h1>}
        {cv.headline && <p className="cv-headline">{cv.headline}</p>}
        {contact && cv.contact.length > 0 && <Contact cv={cv} opts={opts} />}
      </div>
    </header>
  );
}

function Contact({ cv, opts }: { cv: CvView; opts: Opts }) {
  return (
    <ul className="cv-contact">
      {cv.contact.map((c, i) => (
        <li key={i}>
          {opts.icons ? <Icon kind={c.kind} /> : null}
          <Link href={c.href}>{c.text}</Link>
        </li>
      ))}
    </ul>
  );
}

function Summary({ cv }: { cv: CvView }) {
  if (!cv.summary) return null;
  return (
    <section className="cv-section cv-summary">
      <h2>{cv.titles.summary}</h2>
      <div className="cv-body">
        <p>{cv.summary}</p>
      </div>
    </section>
  );
}

function Experience({ cv }: { cv: CvView }) {
  if (cv.experience.length === 0) return null;
  return (
    <section className="cv-section cv-experience">
      <h2>{cv.titles.experience}</h2>
      <div className="cv-body">
        {cv.experience.map((e, i) => (
          <Entry key={i} bullets={e.bullets}>
            <div className="cv-entry-head">
              <h3>
                {e.role && <span className="cv-role">{e.role}</span>}
                {e.role && e.org ? ", " : ""}
                {e.org && <span className="cv-org">{e.org}</span>}
              </h3>
              {e.dates && <span className="cv-dates">{e.dates}</span>}
            </div>
            {(e.place || e.note) && <p className="cv-meta">{[e.place, e.note].filter(Boolean).join(" · ")}</p>}
            <Bullets items={e.bullets} />
          </Entry>
        ))}
      </div>
    </section>
  );
}

function Projects({ cv }: { cv: CvView }) {
  if (cv.projects.length === 0) return null;
  return (
    <section className="cv-section cv-projects">
      <h2>{cv.titles.projects}</h2>
      <div className="cv-body">
        {cv.projects.map((p, i) => (
          <Entry key={i} bullets={p.bullets}>
            <div className="cv-entry-head">
              <h3>{p.name}</h3>
              {p.urlText && (
                <span className="cv-dates cv-url">
                  <Link href={p.href}>{p.urlText}</Link>
                </span>
              )}
            </div>
            {p.summary && <p>{p.summary}</p>}
            {p.tech && <p className="cv-meta">{p.tech}</p>}
            <Bullets items={p.bullets} />
          </Entry>
        ))}
      </div>
    </section>
  );
}

function Skills({ cv, stacked, tags }: { cv: CvView; stacked?: boolean; tags?: boolean }) {
  if (cv.skills.length === 0) return null;
  return (
    <section className="cv-section cv-skills">
      <h2>{cv.titles.skills}</h2>
      <div className="cv-body">
        {cv.skills.map((g, i) =>
          tags ? (
            <div key={i} className="cv-skill cv-skill-tags">
              {g.name && <h3>{g.name}</h3>}
              <ul className="cv-tags">
                {g.items.split(", ").map((item, j) => <li key={j}>{item}</li>)}
              </ul>
            </div>
          ) : stacked ? (
            <div key={i} className="cv-skill">
              {g.name && <h3>{g.name}</h3>}
              <p>{g.items}</p>
            </div>
          ) : (
            <p key={i} className="cv-skill">
              {g.name && (
                <Fragment>
                  <b>{g.name}:</b>{" "}
                </Fragment>
              )}
              {g.items}
            </p>
          ),
        )}
      </div>
    </section>
  );
}

function Education({ cv }: { cv: CvView }) {
  if (cv.education.length === 0) return null;
  return (
    <section className="cv-section cv-education">
      <h2>{cv.titles.education}</h2>
      <div className="cv-body">
        {cv.education.map((ed, i) => (
          <Entry key={i} bullets={[]}>
            <div className="cv-entry-head">
              <h3>{ed.institution}</h3>
              {ed.dates && <span className="cv-dates">{ed.dates}</span>}
            </div>
            {ed.detail && <p>{ed.detail}</p>}
          </Entry>
        ))}
      </div>
    </section>
  );
}

function Languages({ cv }: { cv: CvView }) {
  if (cv.languages.length === 0) return null;
  return (
    <section className="cv-section cv-languages">
      <h2>{cv.titles.languages}</h2>
      <div className="cv-body">
        <ul className="cv-inline">
          {cv.languages.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Extras({ cv }: { cv: CvView }) {
  if (!cv.extras) return null;
  return (
    <section className="cv-section cv-extras">
      <h2>{cv.titles.extras}</h2>
      <div className="cv-body">
        <p>{cv.extras}</p>
      </div>
    </section>
  );
}

function Custom({ cv, sectionKey }: { cv: CvView; sectionKey: string }) {
  const section = cv.custom.find((c) => c.key === sectionKey);
  if (!section) return null;
  return (
    <section className="cv-section cv-custom">
      <h2>{section.title}</h2>
      <div className="cv-body">
        {section.items.map((item, i) => (
          <Entry key={i} bullets={[]}>
            {(item.title || item.date || item.urlText) && (
              <div className="cv-entry-head">
                <h3>
                  {item.title}
                  {item.urlText && (
                    <>
                      {item.title ? " · " : ""}
                      <Link href={item.href}>{item.urlText}</Link>
                    </>
                  )}
                </h3>
                {item.date && <span className="cv-dates">{item.date}</span>}
              </div>
            )}
            {item.text && <p>{item.text}</p>}
          </Entry>
        ))}
      </div>
    </section>
  );
}

/** One section by its order key (`custom:<id>` for the user's own sections). */
function Section({ cv, sectionKey, stacked, tags }: { cv: CvView; sectionKey: string; stacked?: boolean; tags?: boolean }) {
  switch (sectionKey) {
    case "summary": return <Summary cv={cv} />;
    case "experience": return <Experience cv={cv} />;
    case "projects": return <Projects cv={cv} />;
    case "skills": return <Skills cv={cv} stacked={stacked} tags={tags} />;
    case "education": return <Education cv={cv} />;
    case "languages": return <Languages cv={cv} />;
    case "extras": return <Extras cv={cv} />;
    default: return <Custom cv={cv} sectionKey={sectionKey} />;
  }
}

/** Sections the side-column layouts put in their narrow column. */
const SIDE_SECTIONS = new Set(["skills", "languages", "education"]);

function Consent({ cv }: { cv: CvView }) {
  if (!cv.consent) return null;
  return (
    <footer className="cv-consent">
      <p>{cv.consent}</p>
    </footer>
  );
}

function Photo({ src, name }: { src: string; name: string }) {
  const { t } = useT();
  // eslint-disable-next-line @next/next/no-img-element -- private, authenticated image that must print as is
  return <img className="cv-photo" src={src} alt={name ? t("Photo of {name}", { name }) : t("Photo")} />;
}

/** Technical puts the skills right after the profile (the user's own order otherwise). */
function orderFor(cv: CvView, layout: CvLayout): string[] {
  if (layout !== "technical" || !cv.order.includes("skills")) return cv.order;
  const rest = cv.order.filter((key) => key !== "skills");
  const at = rest[0] === "summary" ? 1 : 0;
  return [...rest.slice(0, at), "skills", ...rest.slice(at)];
}

/** One flow: masthead, then every section in reading order. */
function SingleColumn({ cv, photo, layout, opts }: { cv: CvView; photo?: ReactNode; layout: CvLayout; opts: Opts }) {
  return (
    <>
      <Masthead cv={cv} photo={photo} opts={opts} />
      {orderFor(cv, layout).map((key) => <Section key={key} cv={cv} sectionKey={key} tags={opts.tags} />)}
      <Consent cv={cv} />
    </>
  );
}

/** Side column (left or right): photo, contact and the short lists; the story in the main column. */
function TwoColumn({ cv, photo, side, opts }: { cv: CvView; photo?: ReactNode; side: "left" | "right"; opts: Opts }) {
  const aside = (
    <aside className="cv-side">
      {photo}
      {cv.contact.length > 0 && (
        <section className="cv-section cv-side-contact">
          <Contact cv={cv} opts={opts} />
        </section>
      )}
      {cv.order.filter((key) => SIDE_SECTIONS.has(key)).map((key) => <Section key={key} cv={cv} sectionKey={key} stacked />)}
    </aside>
  );
  const main = (
    <div className="cv-main">
      <header className="cv-masthead">
        {cv.name && <h1>{cv.name}</h1>}
        {cv.headline && <p className="cv-headline">{cv.headline}</p>}
      </header>
      {cv.order.filter((key) => !SIDE_SECTIONS.has(key)).map((key) => <Section key={key} cv={cv} sectionKey={key} />)}
    </div>
  );
  return (
    <>
      <div className={side === "left" ? "cv-cols" : "cv-cols is-right"}>
        {side === "left" ? aside : main}
        {side === "left" ? main : aside}
      </div>
      <Consent cv={cv} />
    </>
  );
}

/** Showcase pages: one page per project that has one, after the CV or alone. */
function ProjectPages({ cv, opts }: { cv: CvView; opts: Opts }) {
  if (cv.pages.length === 0) return null;
  const t = cv.pageTitles;
  return (
    <div className="cv-pages">
      {cv.pages.map((p, i) => (
        <section key={i} className="cv-page" data-cv-page={p.name}>
          <header className="cv-page-head">
            <p className="cv-page-kicker">{t.heading}{cv.name ? ` · ${cv.name}` : ""}</p>
            <h1>{p.name}</h1>
            {p.urlText ? (
              <p className="cv-page-link">
                {opts.icons ? <Icon kind={p.href.includes("github.com") ? "github" : "web"} /> : null}
                <Link href={p.href}>{p.urlText}</Link>
              </p>
            ) : null}
            {p.summary ? <p className="cv-page-lead">{p.summary}</p> : null}
          </header>
          <div className="cv-page-grid">
            <div className="cv-page-story">
              {p.story.map((para, j) => <p key={j}>{para}</p>)}
              {p.bullets.length ? (
                <div className="cv-section">
                  <h2>{t.highlights}</h2>
                  <Bullets items={p.bullets} />
                </div>
              ) : null}
            </div>
            <aside className="cv-page-facts">
              {p.role ? (
                <div className="cv-fact">
                  <h2>{t.role}</h2>
                  <p>{p.role}</p>
                </div>
              ) : null}
              {p.outcome ? (
                <div className="cv-fact">
                  <h2>{t.outcome}</h2>
                  <p>{p.outcome}</p>
                </div>
              ) : null}
              {p.tech.length ? (
                <div className="cv-fact">
                  <h2>{t.tech}</h2>
                  <ul className="cv-tags">{p.tech.map((x, j) => <li key={j}>{x}</li>)}</ul>
                </div>
              ) : null}
            </aside>
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * The printable CV for a resolved profile in `lang`: a white sheet of the chosen paper size and dark ink whatever the
 * app theme. `look` (layout.ts) picks the layout, accent, fonts, density, paper, link form and contact icons;
 * `pageMode` adds the projects' showcase pages after the CV (or shows only them). Everything comes from `buildCvView`,
 * the same view model as the DOCX export and `knife_cv_preview_text`. The server PDF and HTML exports render the very
 * markup this component produces, so the preview is what the file looks like.
 */
export function CvDocument({ profile, lang, theme, look, photoUrl = null, photoShape = "round", pageMode = "cv", thumbnail = false }: {
  profile: Profile;
  lang: CvLang;
  /** The layout (kept for callers that only pick a layout); `look.layout` wins when both are given. */
  theme?: CvLayout;
  look?: Partial<CvLook>;
  /** Image URL of the photo to print, or null; ignored by layouts without a photo slot. */
  photoUrl?: string | null;
  photoShape?: PhotoShape;
  pageMode?: CvPageMode;
  /** A gallery thumbnail: not the page's sheet (no data-cv-document, never printed or exported). */
  thumbnail?: boolean;
}) {
  const full: CvLook = { ...DEFAULT_LOOK, ...(theme ? { layout: theme } : {}), ...look };
  const layout = full.layout;
  const cv = useMemo(() => buildCvView(profile, lang, { fullUrls: full.fullUrls }), [profile, lang, full.fullUrls]);
  const info = CV_LAYOUT_INFO[layout];
  const photo = photoUrl && info.photo ? <Photo src={photoUrl} name={cv.name} /> : undefined;
  const opts: Opts = { icons: iconsOf(full), tags: layout === "technical" };
  const [w, h] = PAPER_MM[full.paper];
  const accent = accentOf(full);
  const style = { "--cv-accent": accent, "--cv-tint": tintOf(accent, 0.9), "--cv-tint-strong": tintOf(accent, 0.78), "--cv-paper-w": `${w}mm`, "--cv-paper-h": `${h}mm` } as CSSProperties;
  const showCv = pageMode !== "pages";
  const showPages = pageMode !== "cv" && cv.pages.length > 0;
  const body = cv.isEmpty && !showPages ? (
    <p className="cv-empty">{EMPTY_NOTE[lang]}</p>
  ) : (
    <>
      {showCv && !cv.isEmpty ? (
        info.structure === "left" || info.structure === "right" ? (
          <TwoColumn cv={cv} photo={photo} side={info.structure} opts={opts} />
        ) : (
          <SingleColumn cv={cv} photo={photo} layout={layout} opts={opts} />
        )
      ) : null}
      {showPages ? <ProjectPages cv={cv} opts={opts} /> : null}
      {pageMode === "pages" && !showPages ? <p className="cv-empty">{EMPTY_NOTE[lang]}</p> : null}
    </>
  );
  return (
    <article
      className="cvdoc"
      data-cv-document={thumbnail ? undefined : ""}
      aria-hidden={thumbnail || undefined}
      data-lang={lang}
      data-theme={layout}
      data-fonts={fontsOf(full)}
      data-density={full.density}
      data-paper={full.paper}
      data-structure={info.structure}
      data-pages={showCv ? (showPages ? "after" : undefined) : "only"}
      data-photo={photo ? photoShape : undefined}
      data-cv-title={cv.name ? `${cv.name} - CV` : "CV"}
      lang={lang}
      style={style}
    >
      {full.paper === "letter" ? <style>{"@page { size: letter; }"}</style> : null}
      {body}
    </article>
  );
}
