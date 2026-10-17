// Office documents for the text-extraction golden test (tests/office_text.test.mjs): the app's own templates plus
// hand-written XML covering what real editors emit (run properties, xml:space, tabs/breaks, shared strings with rich
// runs, gaps in cell refs, ODF spans/spaces/notes, headers in tables). office-text-golden.json holds the output of the
// previous (regex) extractor for each entry, so the linear tokenizer is proven to give the same text. Two entries were
// changed on purpose, both bugs of the regex version: a self-closing `<row/>` (xlsx shared) and `<draw:page/>` (odp pages)
// used to swallow the next row/page; they are now an empty row and an empty slide.
import { buildDocument } from "../../src/lib/office/templates.ts";
import { writeZip } from "../../src/lib/office/zip.ts";

const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const ODF = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"';

const docxXml = (body) => writeZip([{ name: "word/document.xml", data: `${X}<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>` }]);
const odfXml = (body) => writeZip([{ name: "mimetype", data: "x", store: true }, { name: "content.xml", data: `${X}<office:document-content ${ODF}><office:body>${body}</office:body></office:document-content>` }]);
function xlsxXml(sheets, sst) {
  const entries = [
    { name: "xl/workbook.xml", data: `${X}<workbook xmlns:r="r"><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `${X}<Relationships>${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="t" Target="${s.target ?? `worksheets/sheet${i + 1}.xml`}"/>`).join("")}<Relationship Id="rIdS" Type="sharedStrings" Target="sharedStrings.xml"/></Relationships>` },
    ...sheets.map((s, i) => ({ name: (s.target ?? `worksheets/sheet${i + 1}.xml`).replace(/^\//, "").replace(/^(?!xl\/)/, "xl/"), data: `${X}<worksheet><sheetData>${s.rows}</sheetData></worksheet>` })),
  ];
  if (sst !== undefined) entries.push({ name: "xl/sharedStrings.xml", data: `${X}<sst count="9">${sst}</sst>` });
  return writeZip(entries);
}
const pptxXml = (slides) => writeZip(slides.map((xml, i) => ({ name: `ppt/slides/slide${slides.length - i}.xml`, data: `${X}<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>${xml}</p:spTree></p:cSld></p:sld>` })));

export const CORPUS = [
  // The app's own templates (what knife_doc_create writes).
  ...["docx", "xlsx", "pptx", "odt", "ods", "odp"].map((format) => ({ name: `blank ${format}`, format, bytes: buildDocument(format) })),
  { name: "template docx", format: "docx", bytes: buildDocument("docx", { paragraphs: ["Dear Sir & Madam,", "", "<tags> \"quoted\" 'apos' — ł ó", "  spaced  "] }) },
  { name: "template odt", format: "odt", bytes: buildDocument("odt", { paragraphs: ["One & two", "", "<x> \"q\""] }) },
  { name: "template xlsx", format: "xlsx", bytes: buildDocument("xlsx", { rows: [["Name", "Qty", "", "Note"], ["Apple", "3", "", "x & y"], [], ["", "", "1.5e3"]] }) },
  { name: "template ods", format: "ods", bytes: buildDocument("ods", { rows: [["Name", "Qty", ""], ["Pear", "-2", "<b>"], [""]] }) },
  { name: "template pptx", format: "pptx", bytes: buildDocument("pptx", { slides: [{ title: "Intro & aims", bullets: ["one", "two <2>"] }, { title: "" }, { title: "End", bullets: [] }] }) },
  { name: "template odp", format: "odp", bytes: buildDocument("odp", { slides: [{ title: "Hello", bullets: ["a", "b & c"] }, { title: "" }] }) },
  // Word as editors write it.
  {
    name: "docx runs",
    format: "docx",
    bytes: docxXml(
      '<w:p w:rsidR="00A1"><w:pPr><w:pStyle w:val="Heading1"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Title</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t xml:space="preserve">a </w:t></w:r><w:r><w:tab/><w:t>b</w:t><w:br/><w:t>c&amp;d &#x142; &#322; &lt;e&gt; &quot;f&quot; &apos;g&apos;</w:t></w:r></w:p>' +
        "<w:p/><w:p></w:p>" +
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell 1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>cell 2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
        '<w:p><w:hyperlink r:id="x"><w:r><w:t>link</w:t></w:r></w:hyperlink><w:r><w:t></w:t></w:r><w:proofErr w:type="spellStart"/><w:r><w:t>end</w:t></w:r></w:p>',
    ),
  },
  { name: "docx empty body", format: "docx", bytes: docxXml("") },
  { name: "docx no document part", format: "docx", bytes: writeZip([{ name: "other.xml", data: "<x/>" }]) },
  // Excel: shared strings, rich runs, gaps, types, several sheets.
  {
    name: "xlsx shared",
    format: "xlsx",
    bytes: xlsxXml(
      [
        { name: "Data &amp; more", rows: '<row r="1" spans="1:3"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>42</v></c><c r="B2" t="b"><v>1</v></c><c r="D2" t="str"><f>A2*2</f><v>84</v></c><c r="E2" s="3"/></row><row r="3"/><row r="4"><c r="B4" t="inlineStr"><is><t>inline &lt;b&gt;</t></is></c><c r="C4" t="s"><v>9</v></c></row>' },
        { name: "Second", rows: '<row r="1"><c t="s"><v>2</v></c><c><v>7</v></c></row><row r="2"><c r="A2" t="e"><v>#DIV/0!</v></c></row>' },
      ],
      '<si><t>plain</t></si><si><r><rPr><b/></rPr><t>rich </t></r><r><t xml:space="preserve">text</t></r></si><si><t>with &amp; amp</t><rPh sb="0" eb="1"><t>ph</t></rPh></si>',
    ),
  },
  { name: "xlsx no shared strings", format: "xlsx", bytes: xlsxXml([{ name: "S", rows: '<row r="1"><c r="AA1"><v>1</v></c></row>', target: "/xl/worksheets/abs.xml" }]) },
  // PowerPoint: slide order, empty paragraphs, line breaks.
  {
    name: "pptx slides",
    format: "pptx",
    bytes: pptxXml([
      '<p:sp><p:txBody><a:p><a:r><a:t>Third</a:t></a:r></a:p></p:txBody></p:sp>',
      '<p:sp><p:txBody><a:p/><a:p><a:pPr lvl="1"/><a:r><a:rPr lang="pl"/><a:t>Second &amp; </a:t></a:r><a:br/><a:r><a:t>line</a:t></a:r><a:tab/><a:r><a:t>x</a:t></a:r></a:p></p:txBody></p:sp>',
      '<p:sp><p:txBody><a:p><a:r><a:t>   </a:t></a:r></a:p><a:p><a:fld type="slidenum"><a:t>1</a:t></a:fld></a:p></p:txBody></p:sp>',
    ]),
  },
  // ODF text: spans, spaces, tabs, breaks, headings, lists, notes, self-closing paragraphs.
  {
    name: "odt rich",
    format: "odt",
    bytes: odfXml(
      '<office:text><text:h text:outline-level="1">Head<text:span text:style-name="T1">ing</text:span></text:h><text:p text:style-name="P1">a<text:s/>b<text:s text:c="3"/>c<text:tab/>d<text:line-break/>e &amp; &#228;</text:p><text:p/><text:list><text:list-item><text:p>item <text:a xlink:href="x">link</text:a></text:p></text:list-item></text:list><text:p>soft<text:soft-page-break/>break</text:p></office:text>',
    ),
  },
  {
    name: "ods sheets",
    format: "ods",
    bytes: odfXml(
      '<office:spreadsheet><table:table table:name="Budget &amp; plan" table:style-name="ta1"><table:table-column table:number-columns-repeated="3"/><table:table-header-rows><table:table-row><table:table-cell office:value-type="string"><text:p>Item</text:p></table:table-cell><table:table-cell><text:p>Cost</text:p></table:table-cell></table:table-row></table:table-header-rows><table:table-row><table:table-cell office:value-type="string"><text:p>Line 1</text:p><text:p>Line 2</text:p></table:table-cell><table:covered-table-cell/><table:table-cell table:number-columns-repeated="2"/></table:table-row><table:table-row><table:table-cell/></table:table-row></table:table><table:table table:name="Empty"><table:table-row><table:table-cell/></table:table-row></table:table></office:spreadsheet>',
    ),
  },
  {
    name: "odp pages",
    format: "odp",
    bytes: odfXml(
      '<office:presentation><draw:page draw:name="p1"><draw:frame><draw:text-box><text:p>Slide <text:span>one</text:span></text:p><text:p> </text:p></draw:text-box></draw:frame></draw:page><draw:page draw:name="p2"/><draw:page draw:name="p3"><draw:frame><draw:text-box><text:list><text:list-item><text:p>b1</text:p></text:list-item></text:list></draw:text-box></draw:frame></draw:page></office:presentation>',
    ),
  },
];
