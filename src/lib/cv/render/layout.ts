/**
 * Document layouts shared by the HTML sheet (`CvDocument`), the DOCX export and the layout picker. Pure metadata.
 * The ids double as the stored preference and the export `theme` field (`ats`/`modern` predate the photo layouts).
 */

export const CV_LAYOUTS = ["ats", "modern", "sidebar", "elegant"] as const;
export type CvLayout = (typeof CV_LAYOUTS)[number];

export const PHOTO_SHAPES = ["round", "square"] as const;
export type PhotoShape = (typeof PHOTO_SHAPES)[number];

export interface CvLayoutInfo {
  label: string;
  /** One line for the picker. */
  description: string;
  /** false = never prints a photo, whatever the photo switch says (ATS parsers choke on images). */
  photo: boolean;
}

export const CV_LAYOUT_INFO: Record<CvLayout, CvLayoutInfo> = {
  ats: { label: "ATS", description: "Plain single column, no photo: safest for applicant tracking systems.", photo: false },
  modern: { label: "Modern", description: "Single column with a blue accent; photo beside the name.", photo: true },
  sidebar: { label: "Sidebar", description: "Two columns: photo, contact, skills, languages and education on the left.", photo: true },
  elegant: { label: "Elegant", description: "Centred serif header with the photo above the name.", photo: true },
};

/** Whether a sheet in `layout` shows the photo: the layout allows one, the user switched it on, and one is stored. */
export function showsPhoto(layout: CvLayout, wanted: boolean, stored: boolean): boolean {
  return CV_LAYOUT_INFO[layout].photo && wanted && stored;
}
