"use client";

import Link from "next/link";
import { SegmentedControl } from "@/components/ui";
import { CV_LAYOUT_INFO, CV_LAYOUTS, PHOTO_SHAPES, showsPhoto, type CvLayout, type PhotoShape } from "@/lib/cv/render/layout";
import { usePref } from "./prefs";
import { useCvPhoto } from "./usePhoto";

/** How a CV document looks: layout, photo on/off, photo shape. Remembered per tab (localStorage), not per version. */
export interface DocOptions {
  layout: CvLayout;
  photo: boolean;
  shape: PhotoShape;
}

export interface DocLook {
  options: DocOptions;
  set: (next: Partial<DocOptions>) => void;
  /** URL of the photo this document prints, or null (no photo stored, switched off, or the layout has no slot). */
  photoUrl: string | null;
  /** What the DOCX export needs. */
  exportOptions: { theme: CvLayout; photo: boolean; photoShape: PhotoShape };
}

export function useDocLook(tab: string): DocLook {
  const [layout, setLayout] = usePref<CvLayout>(`theme:${tab}`, "ats", CV_LAYOUTS);
  const [photoPref, setPhoto] = usePref<"on" | "off">(`photo:${tab}`, "on", ["on", "off"]);
  const [shape, setShape] = usePref<PhotoShape>(`shape:${tab}`, "round", PHOTO_SHAPES);
  const photo = useCvPhoto();
  const prints = showsPhoto(layout, photoPref === "on", photo.url !== null);
  return {
    options: { layout, photo: photoPref === "on", shape },
    set: (next) => {
      if (next.layout) setLayout(next.layout);
      if (next.photo !== undefined) setPhoto(next.photo ? "on" : "off");
      if (next.shape) setShape(next.shape);
    },
    photoUrl: prints ? photo.url : null,
    exportOptions: { theme: layout, photo: prints, photoShape: shape },
  };
}

export function DocumentOptions({ look }: { look: DocLook }) {
  const photo = useCvPhoto();
  const { layout, shape } = look.options;
  const info = CV_LAYOUT_INFO[layout];
  return (
    <div className="space-y-2.5">
      <div className="space-y-1.5">
        <span className="sk-label block">Layout</span>
        <SegmentedControl<CvLayout>
          label="Document layout"
          value={layout}
          onChange={(next) => look.set({ layout: next })}
          options={CV_LAYOUTS.map((id) => ({ value: id, label: CV_LAYOUT_INFO[id].label, ariaLabel: `${CV_LAYOUT_INFO[id].label} layout` }))}
        />
        <p className="text-xs text-muted">{info.description}</p>
      </div>
      {info.photo ? (
        photo.meta ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <span className="sk-label block">Photo</span>
              <SegmentedControl<"on" | "off">
                label="Print the photo"
                value={look.options.photo ? "on" : "off"}
                onChange={(next) => look.set({ photo: next === "on" })}
                options={[{ value: "on", label: "Show", ariaLabel: "Show the photo" }, { value: "off", label: "Hide", ariaLabel: "Hide the photo" }]}
              />
            </div>
            {look.options.photo ? (
              <div className="space-y-1.5">
                <span className="sk-label block">Shape</span>
                <SegmentedControl<PhotoShape>
                  label="Photo shape"
                  value={shape}
                  onChange={(next) => look.set({ shape: next })}
                  options={[{ value: "round", label: "Round", ariaLabel: "Round photo" }, { value: "square", label: "Square", ariaLabel: "Square photo" }]}
                />
              </div>
            ) : null}
          </div>
        ) : photo.phase === "ready" ? (
          <p className="text-xs text-muted">
            No photo yet: <Link className="text-accent-soft underline" href="/tools/cv-studio?tab=profile">add one in the Profile tab</Link>.
          </p>
        ) : null
      ) : null}
    </div>
  );
}
