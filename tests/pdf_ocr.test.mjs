import assert from "node:assert/strict";
import test from "node:test";
import { PDF_OCR_MAX_FILE_BYTES, readPdfForm as readParsed } from "../src/lib/pdf-run.ts";

/** The route hands readPdfForm the streamed form; FormData stands in for it here. */
const readPdfForm = (data) => readParsed({
  field: (name) => (typeof data.get(name) === "string" ? data.get(name) : null),
  files: data.getAll("file").filter((entry) => entry instanceof File),
});

function form(params, files = [new File(["%PDF-fixture"], "scan.pdf", { type: "application/pdf" })]) {
  const data = new FormData();
  data.set("action", "ocr");
  if (params !== undefined) data.set("params", JSON.stringify(params));
  for (const file of files) data.append("file", file);
  return data;
}

test("OCR defaults and explicit false values survive form parsing", () => {
  const defaults = readPdfForm(form());
  assert.equal(defaults.ok, true);
  assert.deepEqual(defaults.input.params, { language: "eng", deskew: true, rotatePages: true });
  const explicit = readPdfForm(form({ language: "eng+pol", deskew: false, rotatePages: false }));
  assert.equal(explicit.ok, true);
  assert.deepEqual(explicit.input.params, { language: "eng+pol", deskew: false, rotatePages: false });
});

test("OCR invalid params fail before a job can be queued", () => {
  for (const params of [null, [], "eng", 1, { language: "fra" }, { language: null },
    { language: ["eng"] }, { deskew: "true" }, { rotatePages: 1 }, { deskew: null }, { force_ocr: true }]) {
    const result = readPdfForm(form(params));
    assert.equal(result.ok, false, JSON.stringify(params));
    assert.equal(result.status, 400);
  }
  const invalid = form();
  invalid.set("params", "{");
  assert.equal(readPdfForm(invalid).status, 400);
});

test("OCR refuses multiple files and its stricter upload cap", () => {
  const file = new File(["fixture"], "scan.pdf");
  assert.equal(readPdfForm(form({}, [file, file])).status, 400);
  assert.equal(readPdfForm(form({}, [])).status, 400);
  const large = new File([new Uint8Array(PDF_OCR_MAX_FILE_BYTES + 1)], "large.pdf");
  const result = readPdfForm(form({}, [large]));
  assert.equal(result.status, 413);
  assert.match(result.error, /50 MB/);
});

test("non-OCR actions retain their existing multi-file contract", () => {
  const data = form({}, [new File(["a"], "a.pdf"), new File(["b"], "b.pdf")]);
  data.set("action", "merge");
  assert.equal(readPdfForm(data).ok, true);
});
