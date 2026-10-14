import { readZip } from "./zip";
import type { OfficeFormat } from "./templates";

/**
 * Plain-text view of an office file for the assistant (knife_doc_read). Structure-light on purpose: paragraphs for text
 * documents, tab-separated rows per sheet, "Slide N" blocks for presentations. Regex over the XML parts is enough for
 * this (no DOM on the server); entities are decoded at the end.
 */

function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

/** Text of runs inside one block: <w:t>/<a:t>/<t> text, tabs and breaks. */
function runText(xml: string, prefix: "w" | "a"): string {
  let out = "";
  const pattern = new RegExp(`<${prefix}:t(?:\\s[^>]*)?>([^<]*)</${prefix}:t>|<${prefix}:tab/>|<${prefix}:br/>`, "g");
  for (const match of xml.matchAll(pattern)) {
    if (match[1] !== undefined) out += decode(match[1]);
    else out += match[0].includes("tab") ? "\t" : "\n";
  }
  return out;
}

function docxText(zip: ReturnType<typeof readZip>): string {
  const xml = zip.text("word/document.xml") ?? "";
  const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g) ?? [];
  return paragraphs.map((p) => runText(p, "w")).join("\n");
}

function sheetOrder(zip: ReturnType<typeof readZip>): { name: string; path: string }[] {
  const workbook = zip.text("xl/workbook.xml") ?? "";
  const relsXml = zip.text("xl/_rels/workbook.xml.rels") ?? "";
  const targets = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const out: { name: string; path: string }[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decode(/name="([^"]*)"/.exec(m[0])?.[1] ?? "Sheet");
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    const path = rid ? targets.get(rid) : undefined;
    if (path) out.push({ name, path });
  }
  return out;
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function xlsxText(zip: ReturnType<typeof readZip>): string {
  const shared: string[] = [];
  const sst = zip.text("xl/sharedStrings.xml") ?? "";
  for (const si of sst.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
    shared.push([...si.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decode(m[1])).join(""));
  }
  const blocks: string[] = [];
  for (const sheet of sheetOrder(zip)) {
    const xml = zip.text(sheet.path) ?? "";
    const lines: string[] = [];
    for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
      const cells: string[] = [];
      for (const c of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const inner = c[2] ?? "";
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "";
        const type = /t="([^"]+)"/.exec(attrs)?.[1];
        let value = "";
        if (type === "inlineStr") value = [...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decode(m[1])).join("");
        else {
          const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
          if (v !== undefined) value = type === "s" ? (shared[Number(v)] ?? "") : decode(v);
        }
        const index = ref ? columnIndex(ref) : cells.length;
        while (cells.length < index) cells.push("");
        cells[index] = value;
      }
      while (cells.length && cells[cells.length - 1] === "") cells.pop();
      lines.push(cells.join("\t"));
    }
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    blocks.push(`# Sheet: ${sheet.name}\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

function pptxText(zip: ReturnType<typeof readZip>): string {
  const slides = zip
    .names()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  return slides
    .map((name, i) => {
      const xml = zip.text(name) ?? "";
      const paragraphs = (xml.match(/<a:p>[\s\S]*?<\/a:p>|<a:p\/>/g) ?? []).map((p) => runText(p, "a")).filter((t) => t.trim());
      return `# Slide ${i + 1}\n${paragraphs.join("\n")}`;
    })
    .join("\n\n");
}

function odfText(zip: ReturnType<typeof readZip>, format: "odt" | "ods" | "odp"): string {
  const xml = (zip.text("content.xml") ?? "").replace(/<text:tab\/>/g, "\t").replace(/<text:line-break\/>/g, "\n").replace(/<text:s(?: text:c="(\d+)")?\/>/g, (_, n?: string) => " ".repeat(Number(n ?? 1)));
  const para = (fragment: string) => (fragment.match(/<text:(?:p|h)\b[^>]*?(?:\/>|>[\s\S]*?<\/text:(?:p|h)>)/g) ?? []).map((p) => decode(p.replace(/<[^>]+>/g, "")));
  if (format === "odt") return para(xml).join("\n");
  if (format === "ods") {
    return (xml.match(/<table:table\b[\s\S]*?<\/table:table>/g) ?? [])
      .map((table) => {
        const name = decode(/table:name="([^"]*)"/.exec(table)?.[1] ?? "Sheet");
        const rows = (table.match(/<table:table-row\b[\s\S]*?<\/table:table-row>/g) ?? []).map((row) =>
          (row.match(/<table:table-cell\b[^>]*?(?:\/>|>[\s\S]*?<\/table:table-cell>)/g) ?? []).map((cell) => para(cell).join(" ")).join("\t").replace(/\t+$/, ""),
        );
        while (rows.length && rows[rows.length - 1] === "") rows.pop();
        return `# Sheet: ${name}\n${rows.join("\n")}`;
      })
      .join("\n\n");
  }
  return (xml.match(/<draw:page\b[\s\S]*?<\/draw:page>/g) ?? [])
    .map((page, i) => `# Slide ${i + 1}\n${para(page).filter((t) => t.trim()).join("\n")}`)
    .join("\n\n");
}

export function extractText(format: OfficeFormat, bytes: Buffer): string {
  const zip = readZip(bytes);
  switch (format) {
    case "docx":
      return docxText(zip);
    case "xlsx":
      return xlsxText(zip);
    case "pptx":
      return pptxText(zip);
    default:
      return odfText(zip, format);
  }
}
