import type { CvCustomItemView, CvView } from "./view";

/** "Title (date) · url" for a custom item; any part may be missing. */
export function customHeading(item: CvCustomItemView): string {
  const head = item.date ? `${item.title}  (${item.date})`.trim() : item.title;
  return [head, item.urlText].filter(Boolean).join(" · ");
}

/** The CV as plain text, in the exact order and wording the HTML and DOCX renderers print (for the assistant to read). */
export function cvViewToText(view: CvView): string {
  const lines: string[] = [];
  const block = (...parts: string[]) => {
    const kept = parts.filter(Boolean);
    if (kept.length) lines.push(...kept, "");
  };
  const meta = (...parts: string[]) => parts.filter(Boolean).join(" · ");
  const bullets = (items: string[]) => items.map((b) => `- ${b}`);

  block(view.name, view.headline, view.contact.map((c) => c.text).join("  |  "));
  for (const key of view.order) {
    if (key === "summary") block(view.titles.summary.toUpperCase(), view.summary);
    else if (key === "experience") {
      lines.push(view.titles.experience.toUpperCase());
      for (const e of view.experience) block(e.dates ? `${e.heading}  (${e.dates})` : e.heading, meta(e.place, e.note), ...bullets(e.bullets));
    } else if (key === "projects") {
      lines.push(view.titles.projects.toUpperCase());
      for (const p of view.projects) block(p.urlText ? `${p.name}  (${p.urlText})` : p.name, p.summary, p.tech, ...bullets(p.bullets));
    } else if (key === "skills") block(view.titles.skills.toUpperCase(), ...view.skills.map((g) => (g.name ? `${g.name}: ${g.items}` : g.items)));
    else if (key === "education") {
      lines.push(view.titles.education.toUpperCase());
      for (const ed of view.education) block(ed.dates ? `${ed.institution}  (${ed.dates})` : ed.institution, ed.detail);
    } else if (key === "languages") block(view.titles.languages.toUpperCase(), ...bullets(view.languages));
    else if (key === "extras") block(view.titles.extras.toUpperCase(), view.extras);
    else {
      const section = view.custom.find((s) => s.key === key);
      if (!section) continue;
      lines.push(section.title.toUpperCase());
      for (const item of section.items) block(customHeading(item), item.text);
    }
  }
  if (view.consent) block(view.consent);
  return lines.join("\n").trimEnd();
}

/**
 * Rough A4 page count from line counts (10pt body, ~100 characters per line, ~55 lines per page, margins excluded).
 * An estimate for the assistant ("is this one page or three?"), not a layout engine.
 */
export function estimatePages(view: CvView): number {
  const CHARS_PER_LINE = 100;
  const LINES_PER_PAGE = 55;
  const wrapped = (s: string, perLine = CHARS_PER_LINE) => Math.max(1, Math.ceil(s.length / perLine));
  let lines = 4; // masthead
  if (view.summary) lines += 2 + wrapped(view.summary);
  if (view.experience.length) lines += 2;
  for (const e of view.experience) lines += 2 + e.bullets.reduce((n, b) => n + wrapped(b, CHARS_PER_LINE - 4), 0) + (e.note ? 1 : 0);
  if (view.projects.length) lines += 2;
  for (const p of view.projects) lines += 2 + (p.summary ? wrapped(p.summary) : 0) + (p.tech ? 1 : 0) + p.bullets.reduce((n, b) => n + wrapped(b, CHARS_PER_LINE - 4), 0);
  if (view.skills.length) lines += 2 + view.skills.reduce((n, g) => n + wrapped(`${g.name}: ${g.items}`), 0);
  if (view.education.length) lines += 2 + view.education.reduce((n, ed) => n + 1 + (ed.detail ? wrapped(ed.detail) : 0), 0);
  if (view.languages.length) lines += 3;
  if (view.extras) lines += 2 + wrapped(view.extras);
  for (const section of view.custom) lines += 2 + section.items.reduce((n, item) => n + 1 + (item.text ? wrapped(item.text) : 0), 0);
  if (view.consent) lines += 1 + Math.ceil(wrapped(view.consent, 130) * 0.7);
  return Math.round((lines / LINES_PER_PAGE) * 10) / 10;
}
