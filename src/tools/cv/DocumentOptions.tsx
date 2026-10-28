"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { radioGroupKeys, SegmentedControl, Select } from "@/components/ui";
import {
  accentOf, CV_ACCENT_IDS, CV_ACCENTS, CV_DENSITIES, CV_FONT_LABELS, CV_FONTS, CV_LAYOUT_INFO, CV_LAYOUTS, CV_PAGE_MODES, CV_PAPERS, PHOTO_SHAPES, showsPhoto,
  type CvAccent, type CvDensity, type CvFonts, type CvLayout, type CvLook, type CvPageMode, type CvPaper, type PhotoShape,
} from "@/lib/cv/render/layout";
import type { CvLang, Profile } from "@/lib/cv/schema";
import { cx } from "@/lib/format";
import { msg } from "@/lib/i18n/msg";
import { useT } from "@/lib/i18n/react";
import { CvDocument } from "./CvDocument";
import { usePref } from "./prefs";
import { useCvPhoto } from "./usePhoto";

/** How a CV document looks. Remembered per tab (localStorage), not per version. */
export interface DocOptions extends CvLook {
  photo: boolean;
  shape: PhotoShape;
  pageMode: CvPageMode;
}

export interface DocLook {
  options: DocOptions;
  set: (next: Partial<DocOptions>) => void;
  /** URL of the photo this document prints, or null (no photo stored, switched off, or the layout has no slot). */
  photoUrl: string | null;
  /** What the server export needs besides the format. */
  exportOptions: { theme: CvLayout; photo: boolean; photoShape: PhotoShape; look: Partial<Omit<CvLook, "layout">>; pageMode: CvPageMode };
}

const ACCENT_PREF = [...CV_ACCENT_IDS, "auto"] as const;

export function useDocLook(tab: string): DocLook {
  const [layout, setLayout] = usePref<CvLayout>(`theme:${tab}`, "ats", CV_LAYOUTS);
  const [photoPref, setPhoto] = usePref<"on" | "off">(`photo:${tab}`, "on", ["on", "off"]);
  const [shape, setShape] = usePref<PhotoShape>(`shape:${tab}`, "round", PHOTO_SHAPES);
  const [accent, setAccent] = usePref<CvAccent | "auto">(`accent:${tab}`, "auto", ACCENT_PREF);
  const [fonts, setFonts] = usePref<CvFonts>(`fonts:${tab}`, "auto", CV_FONTS);
  const [density, setDensity] = usePref<CvDensity>(`density:${tab}`, "comfortable", CV_DENSITIES);
  const [paper, setPaper] = usePref<CvPaper>(`paper:${tab}`, "a4", CV_PAPERS);
  const [urls, setUrls] = usePref<"short" | "full">(`urls:${tab}`, "short", ["short", "full"]);
  const [icons, setIcons] = usePref<"on" | "off">(`icons:${tab}`, "on", ["on", "off"]);
  const [pageMode, setPageMode] = usePref<CvPageMode>(`pages:${tab}`, "cv", CV_PAGE_MODES);
  const photo = useCvPhoto();
  const prints = showsPhoto(layout, photoPref === "on", photo.url !== null);
  const options: DocOptions = { layout, accent, fonts, density, paper, fullUrls: urls === "full", icons: icons === "on", photo: photoPref === "on", shape, pageMode };
  return {
    options,
    set: (next) => {
      if (next.layout) setLayout(next.layout);
      if (next.photo !== undefined) setPhoto(next.photo ? "on" : "off");
      if (next.shape) setShape(next.shape);
      if (next.accent) setAccent(next.accent);
      if (next.fonts) setFonts(next.fonts);
      if (next.density) setDensity(next.density);
      if (next.paper) setPaper(next.paper);
      if (next.fullUrls !== undefined) setUrls(next.fullUrls ? "full" : "short");
      if (next.icons !== undefined) setIcons(next.icons ? "on" : "off");
      if (next.pageMode) setPageMode(next.pageMode);
    },
    photoUrl: prints ? photo.url : null,
    exportOptions: {
      theme: layout,
      photo: prints,
      photoShape: shape,
      look: { accent, fonts, density, paper, fullUrls: urls === "full", icons: icons === "on" },
      pageMode,
    },
  };
}

/** One gallery tile: the user's own CV in that layout, scaled down. */
function Thumb({ profile, lang, layout, look, photoUrl, shape }: { profile: Profile; lang: CvLang; layout: CvLayout; look: DocOptions; photoUrl: string | null; shape: PhotoShape }) {
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.16);
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => setScale(el.clientWidth / 793.7);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={frame} className="cv-thumb-frame" aria-hidden="true">
      <div style={{ transform: `scale(${scale})`, transformOrigin: "top left", width: "210mm" }}>
        <CvDocument
          thumbnail
          profile={profile}
          lang={lang}
          look={{ ...look, layout, accent: look.accent }}
          photoUrl={CV_LAYOUT_INFO[layout].photo ? photoUrl : null}
          photoShape={shape}
        />
      </div>
    </div>
  );
}

const PAGE_LABELS: Record<CvPageMode, string> = { cv: msg("CV"), "cv+pages": msg("CV + pages"), pages: msg("Pages only") };
const PAGE_HINTS: Record<CvPageMode, string> = { cv: msg("CV only"), "cv+pages": msg("CV + project pages"), pages: msg("Project pages only") };

export function DocumentOptions({ look, profile, lang }: { look: DocLook; profile?: Profile; lang?: CvLang }) {
  const { t } = useT();
  const photo = useCvPhoto();
  const o = look.options;
  const info = CV_LAYOUT_INFO[o.layout];
  const [showAll, setShowAll] = useState(false);
  const hasPages = (profile?.projects ?? []).some((p) => p.page);
  return (
    <div className="space-y-3" data-cv-look>
      <div className="space-y-1.5">
        <span className="sk-label block">{t("Layout")}</span>
        {profile && lang ? (
          <>
            <div role="radiogroup" aria-label={t("Document layout")} className="grid grid-cols-3 gap-2">
              {(showAll ? CV_LAYOUTS : [...CV_LAYOUTS.filter((id) => id !== o.layout).slice(0, 5), o.layout].sort((a, b) => CV_LAYOUTS.indexOf(a) - CV_LAYOUTS.indexOf(b))).map((id) => {
                const l = CV_LAYOUT_INFO[id];
                const selected = id === o.layout;
                return (
                  <button
                    key={id}
                    type="button"
                    autoComplete="off"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={selected ? 0 : -1}
                    onKeyDown={radioGroupKeys}
                    aria-label={t("{name} layout", { name: t(l.label) })}
                    title={t(l.description)}
                    onClick={() => look.set({ layout: id })}
                    className={cx("group min-w-0 rounded-lg border p-1.5 text-left transition-colors", selected ? "border-accent bg-accent/10" : "border-line hover:border-line-strong")}
                  >
                    <Thumb profile={profile} lang={lang} layout={id} look={o} photoUrl={look.photoUrl ?? photo.url} shape={o.shape} />
                    <span className="mt-1 flex items-center justify-between gap-1">
                      <span className="truncate text-xs font-medium text-ink">{t(l.label)}</span>
                      {l.atsSafe ? <span className="shrink-0 rounded bg-good/15 px-1 text-[10px] font-semibold text-good">ATS</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
            <button type="button" autoComplete="off" className="text-xs text-accent-soft underline" onClick={() => setShowAll((v) => !v)}>
              {showAll ? t("Show fewer layouts") : t("Show all {n} layouts", { n: CV_LAYOUTS.length })}
            </button>
          </>
        ) : (
          <Select aria-label={t("Document layout")} value={o.layout} onChange={(event) => look.set({ layout: event.target.value as CvLayout })}>
            {CV_LAYOUTS.map((id) => <option key={id} value={id}>{t(CV_LAYOUT_INFO[id].label)}{CV_LAYOUT_INFO[id].atsSafe ? " · ATS" : ""}</option>)}
          </Select>
        )}
        <p className="text-xs text-muted">
          {t(info.description)}
          {info.atsSafe ? ` ${t("Safe for applicant tracking systems.")}` : ` ${t("For people to read; send an ATS-safe layout where a portal parses the file.")}`}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        {info.accent ? (
          <div className="space-y-1.5">
            <span className="sk-label block">{t("Colour")}</span>
            <div role="radiogroup" aria-label={t("Accent colour")} className="flex flex-wrap gap-1.5">
              {(["auto", ...CV_ACCENT_IDS] as const).map((id) => {
                const colour = id === "auto" ? accentOf({ layout: o.layout, accent: "auto" }) : CV_ACCENTS[id];
                const selected = o.accent === id;
                return (
                  <button
                    key={id}
                    type="button"
                    autoComplete="off"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={selected ? 0 : -1}
                    onKeyDown={radioGroupKeys}
                    aria-label={id === "auto" ? t("Layout's own colour") : t("Accent {name}", { name: id })}
                    title={id === "auto" ? t("Layout's own colour") : id}
                    onClick={() => look.set({ accent: id })}
                    className={cx("grid h-7 w-7 place-items-center rounded-full border-2", selected ? "border-ink" : "border-transparent")}
                  >
                    <span className="h-5 w-5 rounded-full" style={{ background: colour, outline: id === "auto" ? "2px dashed rgb(255 255 255 / .7)" : undefined, outlineOffset: -5 }} />
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        <label className="space-y-1.5">
          <span className="sk-label block">{t("Fonts")}</span>
          <Select value={o.fonts} onChange={(event) => look.set({ fonts: event.target.value as CvFonts })}>
            {CV_FONTS.map((id) => <option key={id} value={id}>{t(CV_FONT_LABELS[id])}</option>)}
          </Select>
        </label>
        <div className="space-y-1.5">
          <span className="sk-label block">{t("Spacing")}</span>
          <SegmentedControl<CvDensity>
            label={t("Spacing")}
            value={o.density}
            onChange={(next) => look.set({ density: next })}
            options={[{ value: "comfortable", label: t("Comfortable") }, { value: "compact", label: t("Compact") }]}
          />
        </div>
        <div className="space-y-1.5">
          <span className="sk-label block">{t("Paper")}</span>
          <SegmentedControl<CvPaper>
            label={t("Paper size")}
            value={o.paper}
            onChange={(next) => look.set({ paper: next })}
            options={[{ value: "a4", label: "A4" }, { value: "letter", label: "Letter" }]}
          />
        </div>
        <div className="space-y-1.5">
          <span className="sk-label block">{t("Links")}</span>
          <SegmentedControl<"short" | "full">
            label={t("How links print")}
            value={o.fullUrls ? "full" : "short"}
            onChange={(next) => look.set({ fullUrls: next === "full" })}
            options={[{ value: "short", label: t("Short"), ariaLabel: t("Short links, e.g. github.com/name") }, { value: "full", label: t("Full"), ariaLabel: t("Full links with https://") }]}
          />
        </div>
        {!info.atsSafe ? (
          <div className="space-y-1.5">
            <span className="sk-label block">{t("Icons")}</span>
            <SegmentedControl<"on" | "off">
              label={t("Contact icons")}
              value={o.icons ? "on" : "off"}
              onChange={(next) => look.set({ icons: next === "on" })}
              options={[{ value: "on", label: t("Show") }, { value: "off", label: t("Hide") }]}
            />
          </div>
        ) : null}
      </div>

      {info.photo ? (
        photo.meta ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <span className="sk-label block">{t("Photo")}</span>
              <SegmentedControl<"on" | "off">
                label={t("Print the photo")}
                value={o.photo ? "on" : "off"}
                onChange={(next) => look.set({ photo: next === "on" })}
                options={[{ value: "on", label: "Show", ariaLabel: t("Show the photo") }, { value: "off", label: "Hide", ariaLabel: t("Hide the photo") }]}
              />
            </div>
            {o.photo ? (
              <div className="space-y-1.5">
                <span className="sk-label block">{t("Shape")}</span>
                <SegmentedControl<PhotoShape>
                  label={t("Photo shape")}
                  value={o.shape}
                  onChange={(next) => look.set({ shape: next })}
                  options={[{ value: "round", label: "Round", ariaLabel: t("Round photo") }, { value: "square", label: "Square", ariaLabel: t("Square photo") }]}
                />
              </div>
            ) : null}
          </div>
        ) : photo.phase === "ready" ? (
          <p className="text-xs text-muted">
            {t("No photo yet:")}{" "} <Link className="text-accent-soft underline" href="/tools/cv-studio?tab=profile">{t("add one in the Profile tab")}</Link>.
          </p>
        ) : null
      ) : null}

      <div className="space-y-1.5">
        <span className="sk-label block">{t("Project pages")}</span>
        <SegmentedControl<CvPageMode>
          label={t("Project showcase pages")}
          value={o.pageMode}
          onChange={(next) => look.set({ pageMode: next })}
          options={CV_PAGE_MODES.map((id) => ({ value: id, label: t(PAGE_LABELS[id]), ariaLabel: t(PAGE_HINTS[id]) }))}
        />
        {!hasPages ? <p className="text-xs text-muted">{t("No project has a showcase page yet: turn one on for a project in the Profile tab (Projects, “Showcase page”).")}</p> : null}
      </div>
    </div>
  );
}
