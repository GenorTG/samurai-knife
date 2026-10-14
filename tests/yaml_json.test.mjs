// YAML <-> JSON converter (src/lib/yaml-json.ts). Numbers were silently corrupted: found 2026-10-10 in a browser walkthrough
// (`n: 9007199254740993` came out as 9007199254740992 with "Valid YAML document", `.inf` as null).
// Oracles: Python's json/PyYAML semantics are exact for big ints, so the expected digits are written out by hand here.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/yaml_json.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { convertYamlJson } from "../src/lib/yaml-json.ts";

const toJson = (text, extra = {}) => convertYamlJson({ text, inputFormat: "yaml", outputFormat: "json", sort: false, ...extra });
const toYaml = (text, extra = {}) => convertYamlJson({ text, inputFormat: "json", outputFormat: "yaml", sort: false, ...extra });

test("an integer beyond 2^53 keeps every digit and the page says so", () => {
  const out = toJson("n: 9007199254740993\nbig: -123456789012345678901234567890");
  assert.equal(out.output, '{\n  "n": 9007199254740993,\n  "big": -123456789012345678901234567890\n}');
  assert.deepEqual(out.errors, []);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /2 integers beyond ±9007199254740991 \(first at \$\.n\)/);
});

test("safe integers, floats, hex and negative numbers are plain JSON numbers without warnings", () => {
  const out = toJson("a: 5\nb: -7\nc: 1.10\nd: 0x1F\ne: 1e3\nf: 9007199254740991");
  assert.equal(out.output, '{\n  "a": 5,\n  "b": -7,\n  "c": 1.1,\n  "d": 31,\n  "e": 1000,\n  "f": 9007199254740991\n}');
  assert.deepEqual(out.warnings, []);
});

test("JSON input: a big integer survives JSON -> YAML and JSON -> JSON", () => {
  const yaml = toYaml('{"n": 9007199254740993, "ok": 1}');
  assert.equal(yaml.output, "n: 9007199254740993\nok: 1\n");
  const json = convertYamlJson({ text: '{"n":9007199254740993}', inputFormat: "json", outputFormat: "json", sort: false });
  assert.equal(json.output, '{\n  "n": 9007199254740993\n}');
  assert.equal(json.warnings.length, 1);
});

test(".inf, -.inf and .nan have no JSON form: null plus a warning that names the first one", () => {
  const out = toJson("x: 1\nf: .inf\ng: -.inf\nh: .nan");
  assert.equal(out.output, '{\n  "x": 1,\n  "f": null,\n  "g": null,\n  "h": null\n}');
  assert.match(out.warnings.join("\n"), /3 values written as null \(first at \$\.f \(Infinity\)\)/);
  // YAML output keeps them
  assert.match(toYaml('{"a":1}').output, /a: 1/);
  assert.equal(convertYamlJson({ text: "f: .inf", inputFormat: "yaml", outputFormat: "yaml", sort: false }).output, "f: .inf\n");
});

test("JSON documents without big numbers convert exactly like JSON.parse + JSON.stringify", () => {
  const docs = [
    '{"a":1,"b":[1,2.5,{"c":null,"d":true}],"s":"é\\n\\"q\\" \\u00e9 中","e":1E5,"f":-0.5,"g":0.000001,"h":12345678901234,"i":[]}',
    '[1,2,3]',
    '"just a string"',
    '{"nested":{"deeper":{"x":[[],[{}]]}}}',
    '{"k":"line1\\nline2","t":"\\t"}',
  ];
  for (const doc of docs) {
    const out = convertYamlJson({ text: doc, inputFormat: "json", outputFormat: "json", sort: false });
    assert.deepEqual(out.errors, [], doc);
    assert.equal(out.output, JSON.stringify(JSON.parse(doc), null, 2), doc);
    assert.deepEqual(out.warnings, [], doc);
  }
});

test("YAML features still work: anchors, block scalars, 1.2 booleans, multiple errors with positions", () => {
  const out = toJson("base: &b\n  x: 1\ncopy: *b\ntext: |\n  line1\n  line2\non: yes\nver: 1.10");
  assert.deepEqual(JSON.parse(out.output), { base: { x: 1 }, copy: { x: 1 }, text: "line1\nline2\n", on: "yes", ver: 1.1 });
  const dup = toJson("a: 1\na: 2");
  assert.equal(dup.output, "");
  assert.match(dup.errors[0], /^Line 2, column 1: Map keys must be unique/);
  assert.equal(toJson("   ").output, "");
});

test("sorting keys works with big integers and a user string that looks like the internal marker", () => {
  const out = toJson("b: 9007199254740993\na: \"__knife_bigint_x__5\"", { sort: true });
  assert.equal(out.output, '{\n  "a": "__knife_bigint_x__5",\n  "b": 9007199254740993\n}');
});

test("JSON -> YAML quotes strings that would change type", () => {
  const out = toYaml('{"s":"yes","n":"123","c":"b: c","h":"#x","e":""}');
  const back = convertYamlJson({ text: out.output, inputFormat: "yaml", outputFormat: "json", sort: false });
  assert.deepEqual(JSON.parse(back.output), { s: "yes", n: "123", c: "b: c", h: "#x", e: "" });
});
