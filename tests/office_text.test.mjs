// Office text extraction (src/lib/office/text.ts): golden corpus + bounded work on crafted files.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { extractText, extractTextBounded } from "../src/lib/office/text.ts";
import { writeZip } from "../src/lib/office/zip.ts";
import { CORPUS } from "./fixtures/office-text-corpus.mjs";

const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/office-text-golden.json", import.meta.url), "utf8"));

test("golden corpus: every entry extracts to the recorded text", () => {
  assert.deepEqual(Object.keys(GOLDEN).sort(), CORPUS.map((entry) => entry.name).sort(), "corpus and golden file list the same entries");
  for (const entry of CORPUS) {
    assert.equal(extractText(entry.format, Buffer.from(entry.bytes)), GOLDEN[entry.name].text, entry.name);
  }
});

const X = '<?xml version="1.0" encoding="UTF-8"?>';
function xlsx(rows, sst) {
  const entries = [
    { name: "xl/workbook.xml", data: `${X}<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `${X}<Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: "xl/worksheets/sheet1.xml", data: `${X}<worksheet><sheetData>${rows}</sheetData></worksheet>` },
  ];
  if (sst) entries.push({ name: "xl/sharedStrings.xml", data: `${X}<sst>${sst}</sst>` });
  return writeZip(entries);
}
const docx = (body) => writeZip([{ name: "word/document.xml", data: `${X}<w:document><w:body>${body}</w:body></w:document>` }]);
const odt = (body) => writeZip([{ name: "content.xml", data: `${X}<office:document-content><office:body><office:text>${body}</office:text></office:body></office:document-content>` }]);

/** Run one crafted file: it must finish fast and produce at most `maxChars` characters. */
function bounded(format, bytes, maxChars = 50_000) {
  const start = performance.now();
  const result = extractTextBounded(format, bytes, maxChars);
  const ms = performance.now() - start;
  assert.ok(result.text.length <= maxChars, `${result.text.length} chars > ${maxChars}`);
  assert.ok(ms < 1_500, `took ${ms.toFixed(0)} ms`);
  return result;
}

test("xlsx: column refs past XFD are ignored, not padded (audit: 7 KB file -> 3.9 s + 365 MB)", () => {
  const zip = xlsx(`<row r="1">${'<c r="ZZZ1"><v>1</v></c>'.repeat(20_000)}</row>`);
  assert.ok(zip.length < 20_000, `fixture is small (${zip.length} B)`);
  const result = bounded("xlsx", zip);
  assert.deepEqual(result, { text: `# Sheet: S\n${Array(16_384).fill("1").join("\t")}`, truncated: false });
});

test("xlsx: an absurd ref like XFDZZZZ1 does not throw", () => {
  const result = bounded("xlsx", xlsx('<row r="1"><c r="XFDZZZZ1"><v>7</v></c><c r="B1"><v>8</v></c></row>'));
  assert.equal(result.text, "# Sheet: S\n7\t8");
});

test("xlsx: one far column per row is charged for its padding (many rows x XFD)", () => {
  const result = bounded("xlsx", xlsx('<row><c r="XFD1"><v>1</v></c></row>'.repeat(20_000)));
  assert.equal(result.truncated, true);
});

test("xlsx: a big shared string referenced by every cell stops at the budget", () => {
  const result = bounded("xlsx", xlsx(`<row>${'<c t="s"><v>0</v></c>'.repeat(20_000)}</row>`, `<si><t>${"x".repeat(100_000)}</t></si>`));
  assert.equal(result.truncated, true);
  assert.ok(result.text.startsWith("# Sheet: S\nxxx"));
});

test("odt: repeated <text:s text:c=1000/> is bounded", () => {
  const result = bounded("odt", odt(`<text:p>${'<text:s text:c="1000"/>'.repeat(50_000)}</text:p>`));
  assert.equal(result.truncated, true);
});

test("docx: one huge paragraph keeps its text up to the limit", () => {
  const result = bounded("docx", docx(`<w:p><w:r><w:t>${"abc ".repeat(100_000)}</w:t></w:r></w:p>`), 1_000);
  assert.equal(result.truncated, true);
  assert.equal(result.text, "abc ".repeat(250));
});

test("docx: unclosed paragraphs (audit: 40k x <w:p> = 2.8 s) finish fast", () => {
  const result = bounded("docx", docx("<w:p>".repeat(400_000)));
  assert.equal(result.text, "");
});

test("a document of exactly maxChars characters is not reported as truncated", () => {
  const bytes = docx("<w:p><w:r><w:t>12345</w:t></w:r></w:p>");
  assert.deepEqual(extractTextBounded("docx", bytes, 5), { text: "12345", truncated: false });
  assert.deepEqual(extractTextBounded("docx", bytes, 4), { text: "1234", truncated: true });
});
