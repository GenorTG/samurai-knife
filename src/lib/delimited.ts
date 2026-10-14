// Pure (no React, no DOM): imported by CsvTool and by the SQL import worker.

/** RFC-4180-ish parser: quoted fields, escaped quotes, newlines inside quotes. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      pushField();
    } else if (char === "\n") {
      pushRow();
    } else if (char === "\r") {
      if (text[i + 1] === "\n") i += 1;
      pushRow();
    } else {
      field += char;
    }
  }
  if (field.length || row.length) pushRow();

  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}
