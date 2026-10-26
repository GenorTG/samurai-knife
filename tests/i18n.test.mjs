// Interface languages (docs/I18N.md): the Polish catalogue covers every English text in the code, plurals have the
// three Polish forms, placeholders survive, and the Polish SQL course overlays the English one lesson by lesson.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { isLocale, localeFromAcceptLanguage, translate, translateMessage, translatePlural, translator } from "../src/lib/i18n/core.ts";
import { msg, msgf } from "../src/lib/i18n/msg.ts";
import { localizeCourse } from "../src/lib/learn/localize.ts";
import { SQL_COURSE } from "../src/lib/learn/sql/lessons.ts";
import { compareResults } from "../src/lib/learn/sql/compare.ts";

test("the Polish catalogue matches the code exactly", () => {
  const report = JSON.parse(execFileSync(process.execPath, ["scripts/i18n-extract.mjs", "--json"], { encoding: "utf8" }));
  assert.ok(report.keys > 3000, `only ${report.keys} texts found`);
  assert.deepEqual(report.missing, [], "texts without a Polish translation (node scripts/i18n-extract.mjs --write, then translate)");
  assert.deepEqual(report.stale, [], "catalogue keys no longer in the code");
  assert.deepEqual(report.mismatched, [], "placeholders that differ between English and Polish");
  assert.deepEqual(report.bad, [], "dynamic or malformed translation calls");
});

test("lookup, interpolation and Polish plurals", () => {
  assert.equal(translate("en", "Save"), "Save");
  assert.notEqual(translate("pl", "Save offer"), "Save offer");
  assert.equal(translate("pl", "an English text nobody translated {x}", { x: 1 }), "an English text nobody translated 1");
  assert.equal(translatePlural("en", "{n} file", "{n} files", 1), "1 file");
  assert.equal(translatePlural("en", "{n} file", "{n} files", 3), "3 files");
  assert.equal(translatePlural("pl", "{n} file", "{n} files", 1), "1 plik");
  assert.equal(translatePlural("pl", "{n} file", "{n} files", 3), "3 pliki");
  assert.equal(translatePlural("pl", "{n} file", "{n} files", 5), "5 plików");
  assert.equal(translatePlural("pl", "{n} file", "{n} files", 22), "22 pliki");
  assert.equal(translatePlural("pl", "{n} file", "{n} files", 12), "12 plików");
  assert.equal(translator("pl").t(undefined), undefined);
});

test("server messages are translated by their template", () => {
  const english = msgf("Unknown lesson {id}; knife_learn_lessons lists them.", { id: "x-1" });
  assert.equal(english, "Unknown lesson x-1; knife_learn_lessons lists them.");
  assert.match(translateMessage("pl", english), /^Nieznana lekcja x-1/);
  assert.equal(translateMessage("en", english), english);
  assert.equal(msg("Save"), "Save");
});

test("locale negotiation", () => {
  assert.equal(isLocale("pl"), true);
  assert.equal(isLocale("de"), false);
  assert.equal(localeFromAcceptLanguage("pl-PL,pl;q=0.9,en;q=0.8"), "pl");
  assert.equal(localeFromAcceptLanguage("de-DE,en;q=0.5"), "en");
  assert.equal(localeFromAcceptLanguage(null), null);
  assert.equal(localeFromAcceptLanguage("de-DE"), null);
});

test("the Polish SQL course overlays every lesson and keeps its SQL", () => {
  const pl = localizeCourse(SQL_COURSE, "pl");
  assert.equal(localizeCourse(SQL_COURSE, "en"), SQL_COURSE);
  assert.equal(pl.lessons.length, SQL_COURSE.lessons.length);
  const code = (md) => [...md.matchAll(/```[\s\S]*?```/g)].map((m) => m[0].replace(/--.*$/gm, "").replace(/\s+/g, " "));
  SQL_COURSE.lessons.forEach((en, i) => {
    const p = pl.lessons[i];
    assert.equal(p.id, en.id);
    assert.ok(p.title && p.explanation && p.task, `${en.id}: no Polish text`);
    assert.notEqual(p.task, en.task, `${en.id}: task not translated`);
    assert.equal(p.hints.length, en.hints.length, `${en.id}: hint count`);
    assert.deepEqual(code(p.explanation), code(en.explanation), `${en.id}: code blocks changed`);
    assert.equal(p.solution, en.solution);
    assert.deepEqual(p.check, en.check);
  });
  for (const m of pl.modules) assert.ok(m.title && m.summary, m.id);
});

test("lesson check feedback follows the reader's language", () => {
  const want = { columns: ["n"], rows: [[1], [2]] };
  const got = { columns: ["n"], rows: [[1]] };
  assert.match(compareResults(want, got, { ordered: false }).message, /^Your query returned 1 row, the expected result has 2\./);
  assert.match(compareResults(want, got, { ordered: false, tr: translator("pl") }).message, /^Twoje zapytanie zwróciło 1 wiersz, oczekiwany wynik ma 2\./);
  assert.match(compareResults(want, want, { ordered: false, tr: translator("pl") }).message, /^Dobrze: 2 wiersze/);
});
