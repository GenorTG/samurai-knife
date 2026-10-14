/** GitHub-flavoured Markdown table from parsed delimited rows. Pure, unit-tested. */

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

/**
 * `headerRow`: the first row is the header. When it is not, the table still needs a header line, so it gets generic
 * `Column N` names and EVERY row stays a data row (the first row used to be printed twice: as header and as data).
 */
export function toMarkdownTable(rows: string[][], headerRow: boolean): string {
  if (!rows.length) return "";
  const columns = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => Array.from({ length: columns }, (_, i) => cell(row[i] ?? "")));
  const head = headerRow ? normalized[0] : Array.from({ length: columns }, (_, i) => `Column ${i + 1}`);
  const body = headerRow ? normalized.slice(1) : normalized;
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...body.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}
