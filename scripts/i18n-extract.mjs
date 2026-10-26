#!/usr/bin/env node
// Interface texts (docs/I18N.md): every literal passed to t / tr / tt / msg (one text) or tn (singular, plural) in src/.
//   node scripts/i18n-extract.mjs            -> prints a report (missing / stale / placeholder mismatches)
//   node scripts/i18n-extract.mjs --write    -> adds missing keys to src/lib/i18n/pl.json as "" (to translate) and drops
//                                                stale ones; existing translations are kept
//   node scripts/i18n-extract.mjs --json     -> {keys, plurals, missing, stale, mismatched, bad} for tests
// A text built at run time (t(variable), t(`...${x}`)) cannot be checked: listed under "bad".
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = join(ROOT, "src/lib/i18n/pl.json");
const ONE = new Set(["t", "tr", "tt", "msg", "ct", "msgf"]);
const PLURAL = new Set(["tn", "ctn"]);

/**
 * Metadata modules whose texts are shown translated (t(node.label)) but which cannot import msg(): the workflow catalogue
 * runs in the worker under Node's type stripping (no @/ imports). Every string value of these keys is a text.
 */
const META = [
  { files: /^src\/lib\/workflows\/catalog\/[^/]+\.ts$|^src\/lib\/workflows\/credential-types\.ts$/, keys: new Set(["label", "description", "alias", "defaultName", "hint", "placeholder", "title", "subtitle", "help"]) },
];
const UI_TEXT = (s) => /[A-Za-z]{2}/.test(s) && !/^[a-z][a-zA-Z0-9]*$/.test(s) && !/^[a-z0-9_.:/-]+$/.test(s) && !/^https?:/.test(s);

export function extract() {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "src/**/*.ts", "src/**/*.tsx"], { cwd: ROOT }).toString().trim().split("\n").filter(Boolean);
  const keys = new Map(); // text -> first location
  const plurals = new Map(); // singular -> plural
  const bad = [];
  for (const file of files) {
    if (file.startsWith("src/lib/i18n/")) continue;
    const text = readFileSync(join(ROOT, file), "utf8");
    const meta = META.find((m) => m.files.test(file));
    if (!meta && !/\b(t|tr|tt|tn|msg|msgf|ct|ctn)\(/.test(text)) continue;
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const where = (node) => `${file}:${src.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    const literal = (node) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);
    const visit = (node) => {
      if (meta && ts.isPropertyAssignment(node) && meta.keys.has(node.name.getText().replace(/["']/g, "")) && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer)) && UI_TEXT(node.initializer.text)) {
        if (!keys.has(node.initializer.text)) keys.set(node.initializer.text, where(node));
      }
      // <KeyValues rows={[["Label", value], …]} />: each row's label is a text (KeyValues translates it)
      if (ts.isJsxAttribute(node) && node.name.getText() === "rows" && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression && ts.isArrayLiteralExpression(node.initializer.expression)) {
        for (const row of node.initializer.expression.elements) {
          const label = ts.isArrayLiteralExpression(row) ? literal(row.elements[0]) : null;
          if (label && UI_TEXT(label) && !keys.has(label)) keys.set(label, where(row));
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name) ? node.expression.name.text : null;
        if (callee && ONE.has(callee) && node.arguments.length >= 1 && node.arguments.length <= 2) {
          const value = literal(node.arguments[0]);
          if (value !== null) {
            if (!keys.has(value)) keys.set(value, where(node));
          } else if (!(ts.isIdentifier(node.arguments[0]) && callee === "msg")) {
            // t(name) of a msg()-marked value is fine; anything else built at run time is reported
            if (!ts.isIdentifier(node.arguments[0]) && !ts.isPropertyAccessExpression(node.arguments[0]) && !ts.isElementAccessExpression(node.arguments[0]) && !ts.isConditionalExpression(node.arguments[0]) && !ts.isCallExpression(node.arguments[0]) && !ts.isBinaryExpression(node.arguments[0])) bad.push(`${where(node)}: ${callee}(${node.arguments[0].getText().slice(0, 60)})`);
          }
        }
        if (callee && PLURAL.has(callee) && node.arguments.length >= 3) {
          const one = literal(node.arguments[0]);
          const other = literal(node.arguments[1]);
          if (one !== null && other !== null) {
            if (!keys.has(one)) keys.set(one, where(node));
            plurals.set(one, other);
          } else bad.push(`${where(node)}: tn(...) with non-literal texts`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(src);
  }
  return { keys, plurals, bad };
}

const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

export function check() {
  const { keys, plurals, bad } = extract();
  const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
  const missing = [];
  const mismatched = [];
  for (const key of keys.keys()) {
    const entry = catalog[key];
    if (entry === undefined || entry === "" || (Array.isArray(entry) && entry.some((form) => !form))) {
      missing.push(key);
      continue;
    }
    if (plurals.has(key)) {
      if (!Array.isArray(entry) || entry.length !== 3) mismatched.push(`${key}: a plural needs [one, few, many]`);
      else for (const form of entry) if (vars(form) !== vars(key) && vars(form) !== vars(plurals.get(key))) mismatched.push(`${key}: placeholders of "${form}"`);
    } else if (Array.isArray(entry)) mismatched.push(`${key}: not a plural in the code`);
    else if (vars(entry) !== vars(key)) mismatched.push(`${key}: placeholders {${vars(key)}} vs "${entry}"`);
  }
  const stale = Object.keys(catalog).filter((key) => !keys.has(key));
  return { keys, plurals, missing, stale, mismatched, bad, catalog };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = check();
  if (process.argv.includes("--write")) {
    const next = {};
    for (const key of [...result.keys.keys()].sort((a, b) => a.localeCompare(b, "en"))) {
      const have = result.catalog[key];
      next[key] = have !== undefined && have !== "" ? have : result.plurals.has(key) ? ["", "", ""] : "";
    }
    writeFileSync(CATALOG, JSON.stringify(next, null, 1) + "\n");
  }
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ keys: result.keys.size, plurals: result.plurals.size, missing: result.missing, stale: result.stale, mismatched: result.mismatched, bad: result.bad }));
  } else {
    console.log(`${result.keys.size} texts (${result.plurals.size} plurals); missing ${result.missing.length}, stale ${result.stale.length}, mismatched ${result.mismatched.length}, dynamic ${result.bad.length}`);
    for (const line of result.mismatched.slice(0, 40)) console.log("  mismatch:", line);
    for (const line of result.bad.slice(0, 40)) console.log("  dynamic:", line);
  }
}
