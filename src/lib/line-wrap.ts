/** Fixed-column text wrapping (the line-wrap tool). Pure. Width is counted in grapheme clusters, so an emoji or an accented letter is one column and never split. */

type GraphemeSplitter = (text: string) => string[];

// Pinned locale: the default one would differ between the server render and the browser (see the hydration rule in docs/ARCHITECTURE.md).
const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;
const splitGraphemes: GraphemeSplitter = segmenter
  ? (text) => Array.from(segmenter.segment(text), (part) => part.segment)
  : (text) => Array.from(text);

/** Display width of a string: its grapheme count. */
export function textWidth(text: string): number {
  // A UTF-16 length is never smaller than the grapheme count, so short strings skip the segmenter.
  return text.length <= 1 ? text.length : splitGraphemes(text).length;
}

const isSpace = (chunk: string): boolean => /^\s/.test(chunk);

/**
 * Wraps one input line (no "\n") to `width` columns, like Python's textwrap.wrap(width, drop_whitespace=True, break_on_hyphens=False)
 * with two deliberate differences:
 *  - a line that already fits is returned as it is (only trailing whitespace is dropped), so indentation and runs of spaces survive;
 *  - a word longer than the width starts its own row and is cut by grapheme (textwrap would first fill the rest of the current row with its head).
 * The first row keeps the line's leading indentation (shrunk only when the first word could not otherwise fit); continuation rows start at column 0.
 */
export function wrapLine(line: string, width: number): string[] {
  const fitted = line.trimEnd();
  if (fitted.length <= width || textWidth(fitted) <= width) return [fitted];

  const rows: string[] = [];
  let row: string[] = [];
  let rowWidth = 0;
  const hasWord = () => row.some((chunk) => !isSpace(chunk));
  const flush = () => {
    while (row.length && isSpace(row[row.length - 1])) row.pop();
    if (row.length) rows.push(row.join(""));
    row = [];
    rowWidth = 0;
  };

  for (const chunk of fitted.split(/(\s+)/)) {
    if (!chunk) continue;
    const size = textWidth(chunk);
    if (isSpace(chunk)) {
      if (!row.length && rows.length) continue; // whitespace never starts a continuation row
      if (rowWidth + size <= width) {
        row.push(chunk);
        rowWidth += size;
      } else flush(); // the gap itself is the break
      continue;
    }
    if (rowWidth + size <= width) {
      row.push(chunk);
      rowWidth += size;
      continue;
    }
    if (hasWord()) flush();
    // Only an indent (or nothing) is on the row now.
    if (row.length && size <= width) {
      // Keep as much of the indent as leaves room for the word.
      const indent = splitGraphemes(row.join("")).slice(0, width - size).join("");
      row = indent ? [indent] : [];
      rowWidth = textWidth(indent);
    } else if (row.length && width - rowWidth < 1) {
      row = [];
      rowWidth = 0;
    }
    if (size <= width) {
      row.push(chunk);
      rowWidth += size;
      continue;
    }
    // Over-long word: fill the row (after any indent), then whole rows, and carry the last piece so following words can join it.
    const pieces = splitGraphemes(chunk);
    let at = 0;
    while (pieces.length - at > width - rowWidth) {
      const take = width - rowWidth;
      row.push(pieces.slice(at, at + take).join(""));
      at += take;
      flush();
    }
    const rest = pieces.slice(at).join("");
    row.push(rest);
    rowWidth += pieces.length - at;
  }
  flush();
  return rows;
}

/** Wraps a whole text; every input line (including blank ones) is wrapped on its own. */
export function wrapText(text: string, width: number): string {
  return text
    .split("\n")
    .map((line) => wrapLine(line, width).join("\n"))
    .join("\n");
}
