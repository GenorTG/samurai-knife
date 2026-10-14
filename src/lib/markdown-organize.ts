/**
 * The Markdown organizer: repairs heading levels, normalises list markers, renumbers ordered lists, trims blank runs and
 * inserts or regenerates a `## Contents` section after the title. Pure (no React/DOM) so it is unit-tested directly.
 * Running it on its own output changes nothing (`organize(organize(x)) === organize(x)`).
 */

export function headingSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

interface Heading {
  level: number;
  title: string;
  slug: string;
}

/** A list line of any indent and marker (`- x`, `* x`, `+ x`, `1. x`, `1) x`). */
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
/** A generated (or hand-made) table-of-contents entry: a list item whose whole text is a `[title](#anchor)` link. */
const TOC_ENTRY = /^\s*(?:[-*+]|\d+[.)])\s+\[.*\]\(#[^)]*\)\s*$/;

export function organize(source: string, addToc: boolean): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  const headings: Heading[] = [];
  const slugCounts = new Map<string, number>();
  let fence: "```" | "~~~" | null = null;
  // Original level -> repaired level of the open headings, shallowest first: a heading hangs under the nearest
  // shallower ORIGINAL ancestor, so siblings stay siblings.
  const ancestors: { original: number; repaired: number }[] = [];
  let orderedIndex = 0;
  // The old `## Contents` section = its heading plus the list that follows it. `sawBreak`: a blank line has passed since
  // the last consumed list item (blanks right after the heading do not count: `sawItem`). After that only an indented
  // table-of-contents entry (a child of the list above, as in hand-spaced contents) still belongs to the section, so
  // whatever follows the generated contents after a blank line, a list or a top-level link list included, is body.
  let inOldContents = false;
  let sawBreak = false;
  let sawItem = false;

  for (const original of lines) {
    const line = original.trimEnd();

    if (fence) {
      output.push(original);
      const closing = /^\s*(```|~~~)/.exec(line);
      if (closing && closing[1] === fence) fence = null;
      continue;
    }

    // Old contents section: consumed before any code check, so a deeply nested entry (4+ spaces) cannot look like indented code.
    if (inOldContents) {
      if (!line.trim()) {
        sawBreak = sawItem;
        continue;
      }
      const nestedEntry = TOC_ENTRY.test(line) && /^\s/.test(line);
      if ((LIST_ITEM.test(line) && !sawBreak) || nestedEntry) {
        sawBreak = false;
        sawItem = true;
        continue;
      }
      inOldContents = false;
    }

    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fenceMatch) {
      fence = fenceMatch[1] as "```" | "~~~";
      output.push(original);
      continue;
    }
    if (/^(?: {4,}|\t)/.test(original)) {
      output.push(original);
      continue;
    }

    if (addToc && /^\s{0,3}#{1,6}\s+contents\s*#*\s*$/i.test(line)) {
      inOldContents = true;
      sawBreak = false;
      sawItem = false;
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s*(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const written = heading[1].length;
      while (ancestors.length && ancestors[ancestors.length - 1].original >= written) ancestors.pop();
      const parent = ancestors[ancestors.length - 1];
      const level = parent ? parent.repaired + 1 : 1;
      ancestors.push({ original: written, repaired: level });
      const title = heading[2].trim();
      const base = headingSlug(title) || "section";
      const count = slugCounts.get(base) ?? 0;
      slugCounts.set(base, count + 1);
      headings.push({ level, title, slug: count ? `${base}-${count}` : base });
      if (output.length && output[output.length - 1] !== "") output.push("");
      output.push(`${"#".repeat(level)} ${title}`);
      output.push("");
      orderedIndex = 0;
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      orderedIndex += 1;
      output.push(`${" ".repeat(line.length - line.trimStart().length)}${orderedIndex}. ${ordered[1].trimEnd()}`);
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      output.push(line.replace(/^(\s*)[*+]\s+/, "$1- "));
      orderedIndex = 0;
      continue;
    }
    if (!line.trim()) {
      if (output.length && output[output.length - 1] !== "") output.push("");
      orderedIndex = 0;
      continue;
    }
    output.push(line);
    orderedIndex = 0;
  }

  let organized = output.join("\n").trim();
  if (addToc && headings.length) {
    const contents = headings.map(({ level, title, slug }) => `${"  ".repeat(level - 1)}- [${title}](#${slug})`);
    const toc = `## Contents\n\n${contents.join("\n")}`;
    if (organized.startsWith("# ")) {
      const titleEnd = organized.indexOf("\n");
      organized = titleEnd >= 0
        ? `${organized.slice(0, titleEnd + 1)}\n${toc}\n\n${organized.slice(titleEnd + 1).trimStart()}`
        : `${organized}\n\n${toc}`;
    } else {
      organized = `${toc}\n\n${organized}`;
    }
  }
  return organized ? `${organized}\n` : "";
}
