// CSV workbench pure logic: conversion keys, pivot arithmetic, markdown tables.
// Each case below was a silent-wrong-answer bug found by a human-style browser walkthrough on 2026-10-10.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/csv_tools.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { columnKeys, convertCsv } from "../src/lib/csv-convert.ts";
import { numericValues, pivotTable } from "../src/lib/csv-pivot.ts";
import { toMarkdownTable } from "../src/lib/markdown-table.ts";

const convert = (text, extra = {}) => JSON.parse(convertCsv({ text, delimiter: ",", hasHeader: true, ...extra }).json);

test("convert: a repeated header never overwrites an earlier value", () => {
  assert.deepEqual(convert("a,a,b\n1,2,3"), [{ a: "1", a_2: "2", b: "3" }]);
  assert.deepEqual(convert("a,a,a\n1,2,3"), [{ a: "1", a_2: "2", a_3: "3" }]);
});

test("convert: cells beyond the header keep their values under column_N keys", () => {
  assert.deepEqual(convert("name,n\nlong,a,b,c\nshort"), [
    { name: "long", n: "a", column_3: "b", column_4: "c" },
    { name: "short", n: "", column_3: "", column_4: "" },
  ]);
});

test("convert: blank header cells become column_N and stay unique", () => {
  assert.deepEqual(convert(",,x\n1,2,3"), [{ column_1: "1", column_2: "2", x: "3" }]);
  // position 2 is blank -> its generated name `column_2` collides with the real header `column_2`, so it is suffixed
  assert.deepEqual(columnKeys(["column_2", "", "column_2"], 3), ["column_2", "column_2_2", "column_2_3"]);
});

test("convert: the preview header equals the JSON keys", () => {
  const out = convertCsv({ text: "a,a,b\n1,2,3,4", delimiter: ",", hasHeader: true });
  assert.deepEqual(out.header, ["a", "a_2", "b", "column_4"]);
  assert.deepEqual(Object.keys(JSON.parse(out.json)[0]), out.header);
});

test("convert: a leading BOM is not part of the first key", () => {
  assert.deepEqual(convert("﻿id,name\n1,Ada"), [{ id: "1", name: "Ada" }]);
});

test("convert: quoting, leading zeros and unicode are untouched", () => {
  assert.deepEqual(convert('id,note\n007,"Ada, L"\n8,"she said ""hi"""\n9,Żółw 中'), [
    { id: "007", note: "Ada, L" },
    { id: "8", note: 'she said "hi"' },
    { id: "9", note: "Żółw 中" },
  ]);
  assert.equal(convertCsv({ text: "   ", delimiter: ",", hasHeader: true }).parsed, false);
});

test("pivot: blank and whitespace-only cells are no value, not 0", () => {
  assert.deepEqual(numericValues(["10", "", "   ", "x", undefined, "2.5", "-1e1"]), [10, 2.5, -10]);
  const rows = [["team", "q", "sales"], ["North", "Q1", "10"], ["North", "Q1", ""], ["North", "Q1", "   "], ["South", "Q1", ""]];
  assert.deepEqual(pivotTable(rows, 0, 1, 2, "count").cells, [["1"], ["0"]]);
  assert.deepEqual(pivotTable(rows, 0, 1, 2, "average").cells, [["10"], [""]]);
  assert.deepEqual(pivotTable(rows, 0, 1, 2, "sum").cells, [["10"], [""]]);
});

test("pivot: the default example", () => {
  const rows = [["team", "quarter", "sales"], ["North", "Q1", "12"], ["North", "Q2", "18"], ["South", "Q1", "8"], ["South", "Q2", "14"], ["North", "Q1", "3"]];
  const sum = pivotTable(rows, 0, 1, 2, "sum");
  assert.deepEqual(sum.rowKeys, ["North", "South"]);
  assert.deepEqual(sum.colKeys, ["Q1", "Q2"]);
  assert.deepEqual(sum.cells, [["15", "18"], ["8", "14"]]);
  assert.deepEqual(pivotTable(rows, 0, 1, 2, "average").cells, [["7.5", "18"], ["8", "14"]]);
  assert.deepEqual(pivotTable(rows, 0, 1, 2, "count").cells, [["2", "1"], ["1", "1"]]);
});

test("markdown: header on uses the first row once", () => {
  assert.equal(toMarkdownTable([["Name", "Role"], ["Ada", "Eng"]], true), "| Name | Role |\n| --- | --- |\n| Ada | Eng |");
});

test("markdown: header off gives generic names and keeps every row exactly once", () => {
  assert.equal(toMarkdownTable([["x1", "y1"], ["x2", "y2"]], false), "| Column 1 | Column 2 |\n| --- | --- |\n| x1 | y1 |\n| x2 | y2 |");
});

test("markdown: pipes, newlines and ragged rows", () => {
  assert.equal(toMarkdownTable([["a", "b"], ["x | y", "l1\nl2"], ["short"]], true), "| a | b |\n| --- | --- |\n| x \\| y | l1<br>l2 |\n| short |  |");
  assert.equal(toMarkdownTable([], true), "");
});
