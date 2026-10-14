import { writeZip, type ZipEntryInput } from "./zip";

/**
 * New office files built from scratch (no template binaries in the repo, no dependency): the smallest valid OOXML and ODF
 * packages, optionally with content (paragraphs / rows / slides) so the assistant can create a real first draft.
 * Verified by opening each kind in the Document Server (tests/office_e2e.py) and by the zip/text round trip unit test.
 */

export const OFFICE_FORMATS = ["docx", "xlsx", "pptx", "odt", "ods", "odp"] as const;
export type OfficeFormat = (typeof OFFICE_FORMATS)[number];

export type DocumentType = "word" | "cell" | "slide";

export function documentTypeOf(format: OfficeFormat): DocumentType {
  return format === "docx" || format === "odt" ? "word" : format === "xlsx" || format === "ods" ? "cell" : "slide";
}

export const MIME: Record<OfficeFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
};

export interface SlideInput {
  title: string;
  bullets?: string[];
}

export interface TemplateContent {
  /** docx/odt: one string per paragraph. */
  paragraphs?: string[];
  /** xlsx/ods: rows of cells; numeric-looking cells are stored as numbers. */
  rows?: string[][];
  /** pptx/odp: one entry per slide. */
  slides?: SlideInput[];
}

export function xmlEscape(text: string): string {
  // Characters XML 1.0 cannot carry at all are dropped.
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NUMERIC = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const REL_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";

function rels(list: { id: string; type: string; target: string }[]): string {
  return `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
    .map((r) => `<Relationship Id="${r.id}" Type="${REL_DOC}/${r.type}" Target="${r.target}"/>`)
    .join("")}</Relationships>`;
}

function contentTypes(overrides: [string, string][]): string {
  return `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides
    .map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`)
    .join("")}</Types>`;
}

/* ---------------------------------------------------------------------------------------------------- docx */

function docx(content: TemplateContent): Buffer {
  const paragraphs = content.paragraphs?.length ? content.paragraphs : [""];
  const body = paragraphs
    .map((text) => (text ? `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>` : "<w:p/>"))
    .join("");
  const document = `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${REL_DOC}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return writeZip([
    { name: "[Content_Types].xml", data: contentTypes([["/word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"]]) },
    { name: "_rels/.rels", data: rels([{ id: "rId1", type: "officeDocument", target: "word/document.xml" }]) },
    { name: "word/document.xml", data: document },
  ]);
}

/* ---------------------------------------------------------------------------------------------------- xlsx */

function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function xlsx(content: TemplateContent): Buffer {
  const rows = (content.rows ?? [])
    .map((row, r) => `<row r="${r + 1}">${row
      .map((cell, c) => {
        const ref = `${columnName(c)}${r + 1}`;
        if (cell === "") return "";
        return NUMERIC.test(cell.trim())
          ? `<c r="${ref}"><v>${cell.trim()}</v></c>`
          : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`;
      })
      .join("")}</row>`)
    .join("");
  const sheet = `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  const workbook = `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL_DOC}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  return writeZip([
    {
      name: "[Content_Types].xml",
      data: contentTypes([
        ["/xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"],
        ["/xl/worksheets/sheet1.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"],
      ]),
    },
    { name: "_rels/.rels", data: rels([{ id: "rId1", type: "officeDocument", target: "xl/workbook.xml" }]) },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: rels([{ id: "rId1", type: "worksheet", target: "worksheets/sheet1.xml" }]) },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ]);
}

/* ---------------------------------------------------------------------------------------------------- pptx */

const SLIDE_W = 12192000;
const SLIDE_H = 6858000;

const THEME = `${XML}<a:theme xmlns:a="${NS_A}" name="Knife"><a:themeElements><a:clrScheme name="Knife"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="E5E7EB"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="DC2626"/></a:accent2><a:accent3><a:srgbClr val="16A34A"/></a:accent3><a:accent4><a:srgbClr val="CA8A04"/></a:accent4><a:accent5><a:srgbClr val="9333EA"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme><a:fontScheme name="Knife"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Knife"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const EMPTY_TREE = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function textBox(id: number, name: string, box: [number, number, number, number], paragraphs: string[], size: number, bold: boolean, bullets: boolean): string {
  const [x, y, cx, cy] = box;
  const runs = (paragraphs.length ? paragraphs : [""])
    .map((text) => {
      const props = bullets ? '<a:pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr>' : "";
      const run = text ? `<a:r><a:rPr lang="en-US" sz="${size}"${bold ? ' b="1"' : ""} dirty="0"/><a:t>${xmlEscape(text)}</a:t></a:r>` : "";
      return `<a:p>${props}${run}<a:endParaRPr lang="en-US" sz="${size}" dirty="0"/></a:p>`;
    })
    .join("");
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>${runs}</p:txBody></p:sp>`;
}

function pptx(content: TemplateContent): Buffer {
  const slides = content.slides?.length ? content.slides : [{ title: "", bullets: [] }];
  const entries: ZipEntryInput[] = [];
  const overrides: [string, string][] = [
    ["/ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"],
    ["/ppt/slideMasters/slideMaster1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"],
    ["/ppt/slideLayouts/slideLayout1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"],
    ["/ppt/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml"],
  ];
  const presRels = [
    { id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
    { id: "rId2", type: "theme", target: "theme/theme1.xml" },
  ];
  const sldIds: string[] = [];
  slides.forEach((slide, index) => {
    const n = index + 1;
    overrides.push([`/ppt/slides/slide${n}.xml`, "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"]);
    presRels.push({ id: `rId${n + 2}`, type: "slide", target: `slides/slide${n}.xml` });
    sldIds.push(`<p:sldId id="${255 + n}" r:id="rId${n + 2}"/>`);
    const shapes =
      textBox(2, "Title", [609600, 457200, SLIDE_W - 1219200, 1143000], [slide.title], 4000, true, false) +
      textBox(3, "Body", [609600, 1828800, SLIDE_W - 1219200, SLIDE_H - 2514600], slide.bullets ?? [], 2400, false, Boolean(slide.bullets?.length));
    entries.push({
      name: `ppt/slides/slide${n}.xml`,
      data: `${XML}<p:sld xmlns:a="${NS_A}" xmlns:r="${REL_DOC}" xmlns:p="${NS_P}"><p:cSld><p:spTree>${EMPTY_TREE}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    });
    entries.push({ name: `ppt/slides/_rels/slide${n}.xml.rels`, data: rels([{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }]) });
  });
  const presentation = `${XML}<p:presentation xmlns:a="${NS_A}" xmlns:r="${REL_DOC}" xmlns:p="${NS_P}" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${sldIds.join("")}</p:sldIdLst><p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const master = `${XML}<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${REL_DOC}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;
  const layout = `${XML}<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${REL_DOC}" xmlns:p="${NS_P}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  return writeZip([
    { name: "[Content_Types].xml", data: contentTypes(overrides) },
    { name: "_rels/.rels", data: rels([{ id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" }]) },
    { name: "ppt/presentation.xml", data: presentation },
    { name: "ppt/_rels/presentation.xml.rels", data: rels(presRels) },
    { name: "ppt/slideMasters/slideMaster1.xml", data: master },
    {
      name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      data: rels([
        { id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
        { id: "rId2", type: "theme", target: "../theme/theme1.xml" },
      ]),
    },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: layout },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: rels([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }]) },
    { name: "ppt/theme/theme1.xml", data: THEME },
    ...entries,
  ]);
}

/* ----------------------------------------------------------------------------------------------------- ODF */

const ODF_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" office:version="1.3"';

function odf(format: "odt" | "ods" | "odp", body: string, styles: string): Buffer {
  const manifest = `${XML}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="${MIME[format]}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>`;
  return writeZip([
    { name: "mimetype", data: MIME[format], store: true },
    { name: "META-INF/manifest.xml", data: manifest },
    { name: "content.xml", data: `${XML}<office:document-content ${ODF_NS}><office:body>${body}</office:body></office:document-content>` },
    { name: "styles.xml", data: `${XML}<office:document-styles ${ODF_NS}>${styles}</office:document-styles>` },
  ]);
}

function odt(content: TemplateContent): Buffer {
  const paragraphs = content.paragraphs?.length ? content.paragraphs : [""];
  return odf("odt", `<office:text>${paragraphs.map((p) => `<text:p>${xmlEscape(p)}</text:p>`).join("")}</office:text>`, "");
}

function ods(content: TemplateContent): Buffer {
  const rows = (content.rows?.length ? content.rows : [[""]])
    .map((row) => `<table:table-row>${row
      .map((cell) =>
        NUMERIC.test(cell.trim())
          ? `<table:table-cell office:value-type="float" office:value="${cell.trim()}"><text:p>${cell.trim()}</text:p></table:table-cell>`
          : cell === ""
            ? "<table:table-cell/>"
            : `<table:table-cell office:value-type="string"><text:p>${xmlEscape(cell)}</text:p></table:table-cell>`,
      )
      .join("")}</table:table-row>`)
    .join("");
  return odf("ods", `<office:spreadsheet><table:table table:name="Sheet1">${rows}</table:table></office:spreadsheet>`, "");
}

function odp(content: TemplateContent): Buffer {
  const slides = content.slides?.length ? content.slides : [{ title: "", bullets: [] }];
  const pages = slides
    .map((slide, i) => {
      const title = `<draw:frame svg:x="1.5cm" svg:y="1cm" svg:width="25cm" svg:height="2.5cm"><draw:text-box><text:p>${xmlEscape(slide.title)}</text:p></draw:text-box></draw:frame>`;
      const items = (slide.bullets ?? []).map((b) => `<text:list-item><text:p>${xmlEscape(b)}</text:p></text:list-item>`).join("");
      const body = `<draw:frame svg:x="1.5cm" svg:y="4cm" svg:width="25cm" svg:height="10.5cm"><draw:text-box>${items ? `<text:list>${items}</text:list>` : "<text:p/>"}</draw:text-box></draw:frame>`;
      return `<draw:page draw:name="page${i + 1}" draw:master-page-name="Default">${title}${body}</draw:page>`;
    })
    .join("");
  const styles =
    '<office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm" style:print-orientation="landscape"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles>';
  return odf("odp", `<office:presentation>${pages}</office:presentation>`, styles);
}

export function buildDocument(format: OfficeFormat, content: TemplateContent = {}): Buffer {
  switch (format) {
    case "docx":
      return docx(content);
    case "xlsx":
      return xlsx(content);
    case "pptx":
      return pptx(content);
    case "odt":
      return odt(content);
    case "ods":
      return ods(content);
    case "odp":
      return odp(content);
  }
}
