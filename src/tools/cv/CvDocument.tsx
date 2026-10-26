"use client";

import { Fragment, useMemo, type ReactNode } from "react";
import { buildCvView, type CvView } from "@/lib/cv/render/view";
import { CV_LAYOUT_INFO, type CvLayout, type PhotoShape } from "@/lib/cv/render/layout";
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

function Link({ href, children }: { href: string; children: string }) {
  return href ? (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ) : (
    <>{children}</>
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

function Masthead({ cv, photo }: { cv: CvView; photo?: ReactNode }) {
  return (
    <header className={photo ? "cv-masthead has-photo" : "cv-masthead"}>
      {photo}
      <div className="cv-masthead-text">
        {cv.name && <h1>{cv.name}</h1>}
        {cv.headline && <p className="cv-headline">{cv.headline}</p>}
        {cv.contact.length > 0 && <Contact cv={cv} />}
      </div>
    </header>
  );
}

function Contact({ cv }: { cv: CvView }) {
  return (
    <ul className="cv-contact">
      {cv.contact.map((c, i) => (
        <li key={i}>
          <Link href={c.href}>{c.text}</Link>
        </li>
      ))}
    </ul>
  );
}

function Summary({ cv }: { cv: CvView }) {
  if (!cv.summary) return null;
  return (
    <section className="cv-section">
      <h2>{cv.titles.summary}</h2>
      <p>{cv.summary}</p>
    </section>
  );
}

function Experience({ cv }: { cv: CvView }) {
  if (cv.experience.length === 0) return null;
  return (
    <section className="cv-section">
      <h2>{cv.titles.experience}</h2>
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
    </section>
  );
}

function Projects({ cv }: { cv: CvView }) {
  if (cv.projects.length === 0) return null;
  return (
    <section className="cv-section">
      <h2>{cv.titles.projects}</h2>
      {cv.projects.map((p, i) => (
        <Entry key={i} bullets={p.bullets}>
          <div className="cv-entry-head">
            <h3>{p.name}</h3>
            {p.urlText && (
              <span className="cv-dates">
                <Link href={p.href}>{p.urlText}</Link>
              </span>
            )}
          </div>
          {p.summary && <p>{p.summary}</p>}
          {p.tech && <p className="cv-meta">{p.tech}</p>}
          <Bullets items={p.bullets} />
        </Entry>
      ))}
    </section>
  );
}

function Skills({ cv, stacked }: { cv: CvView; stacked?: boolean }) {
  if (cv.skills.length === 0) return null;
  return (
    <section className="cv-section">
      <h2>{cv.titles.skills}</h2>
      {cv.skills.map((g, i) =>
        stacked ? (
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
    </section>
  );
}

function Education({ cv }: { cv: CvView }) {
  if (cv.education.length === 0) return null;
  return (
    <section className="cv-section">
      <h2>{cv.titles.education}</h2>
      {cv.education.map((ed, i) => (
        <Entry key={i} bullets={[]}>
          <div className="cv-entry-head">
            <h3>{ed.institution}</h3>
            {ed.dates && <span className="cv-dates">{ed.dates}</span>}
          </div>
          {ed.detail && <p>{ed.detail}</p>}
        </Entry>
      ))}
    </section>
  );
}

function Languages({ cv }: { cv: CvView }) {
  if (cv.languages.length === 0) return null;
  return (
    <section className="cv-section">
      <h2>{cv.titles.languages}</h2>
      <ul className="cv-inline">
        {cv.languages.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </section>
  );
}

function Extras({ cv }: { cv: CvView }) {
  if (!cv.extras) return null;
  return (
    <section className="cv-section">
      <h2>{cv.titles.extras}</h2>
      <p>{cv.extras}</p>
    </section>
  );
}

function Custom({ cv, sectionKey }: { cv: CvView; sectionKey: string }) {
  const section = cv.custom.find((c) => c.key === sectionKey);
  if (!section) return null;
  return (
    <section className="cv-section">
      <h2>{section.title}</h2>
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
    </section>
  );
}

/** One section by its order key (`custom:<id>` for the user's own sections). */
function Section({ cv, sectionKey, stacked }: { cv: CvView; sectionKey: string; stacked?: boolean }) {
  switch (sectionKey) {
    case "summary": return <Summary cv={cv} />;
    case "experience": return <Experience cv={cv} />;
    case "projects": return <Projects cv={cv} />;
    case "skills": return <Skills cv={cv} stacked={stacked} />;
    case "education": return <Education cv={cv} />;
    case "languages": return <Languages cv={cv} />;
    case "extras": return <Extras cv={cv} />;
    default: return <Custom cv={cv} sectionKey={sectionKey} />;
  }
}

/** Sections the Sidebar layout puts in its narrow left column. */
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

/** One flow: masthead, then every section in reading order (ATS, Modern, Elegant). */
function SingleColumn({ cv, photo }: { cv: CvView; photo?: ReactNode }) {
  return (
    <>
      <Masthead cv={cv} photo={photo} />
      {cv.order.map((key) => <Section key={key} cv={cv} sectionKey={key} />)}
      <Consent cv={cv} />
    </>
  );
}

/** Sidebar: photo, contact and the short lists on the left; the story on the right. */
function TwoColumn({ cv, photo }: { cv: CvView; photo?: ReactNode }) {
  return (
    <>
      <div className="cv-cols">
        <aside className="cv-side">
          {photo}
          {cv.contact.length > 0 && (
            <section className="cv-section cv-side-contact">
              <Contact cv={cv} />
            </section>
          )}
          {cv.order.filter((key) => SIDE_SECTIONS.has(key)).map((key) => <Section key={key} cv={cv} sectionKey={key} stacked />)}
        </aside>
        <div className="cv-main">
          <header className="cv-masthead">
            {cv.name && <h1>{cv.name}</h1>}
            {cv.headline && <p className="cv-headline">{cv.headline}</p>}
          </header>
          {cv.order.filter((key) => !SIDE_SECTIONS.has(key)).map((key) => <Section key={key} cv={cv} sectionKey={key} />)}
        </div>
      </div>
      <Consent cv={cv} />
    </>
  );
}

/**
 * The printable CV for a resolved profile in `lang`. A white sheet with A4 proportions (210 mm wide, 17 mm side padding =
 * the printed text width, so line breaks match the PDF) and dark ink whatever the app theme. Layouts (`layout.ts`):
 * `ats` = plain black single flow, never a photo; `modern` = the same flow with a blue accent, photo beside the name;
 * `sidebar` = two columns; `elegant` = centred serif header, photo above the name. Everything comes from `buildCvView`,
 * the same view model as the DOCX export and `knife_cv_preview_text`.
 */
export function CvDocument({ profile, lang, theme, photoUrl = null, photoShape = "round" }: {
  profile: Profile;
  lang: CvLang;
  theme: CvLayout;
  /** Image URL of the photo to print, or null; ignored by layouts without a photo slot. */
  photoUrl?: string | null;
  photoShape?: PhotoShape;
}) {
  const cv = useMemo(() => buildCvView(profile, lang), [profile, lang]);
  const photo = photoUrl && CV_LAYOUT_INFO[theme].photo ? <Photo src={photoUrl} name={cv.name} /> : undefined;
  return (
    <article
      className="cvdoc"
      data-cv-document
      data-lang={lang}
      data-theme={theme}
      data-photo={photo ? photoShape : undefined}
      data-cv-title={cv.name ? `${cv.name} - CV` : "CV"}
      lang={lang}
    >
      {cv.isEmpty ? <p className="cv-empty">{EMPTY_NOTE[lang]}</p> : theme === "sidebar" ? <TwoColumn cv={cv} photo={photo} /> : <SingleColumn cv={cv} photo={photo} />}
    </article>
  );
}
