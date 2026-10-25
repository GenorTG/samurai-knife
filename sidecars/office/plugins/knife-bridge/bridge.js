/*
 * Samurai Knife bridge: a background (system) plugin that lets the Samurai Knife assistant read and edit the document
 * open in this editor. Contract and security model: docs/SIDECARS.md ("Live editing plugin").
 *
 * Frames: Samurai Knife page (app origin) > editor iframe (sidecar origin) > this plugin iframe (sidecar origin).
 * Channel: the app passes {token, appOrigin} in the signed editor config (editorConfig.plugins.options[<guid>]). This
 * plugin posts a "hello" carrying the token to the app window (window.parent.parent) with targetOrigin = appOrigin, so
 * only that origin can read it. The app checks origin + token + that the sender sits inside its own editor iframe and
 * answers "welcome" with a MessagePort; from then on every request/response goes over that private port. Without
 * options (an editor that is not opened by Samurai Knife) the plugin stays idle.
 *
 * Commands are a fixed allowlist below (no code is ever accepted from the channel). They run inside the editor through
 * Asc.plugin.callCommand with Asc.scope for the arguments, one at a time (the plugin runtime has a single callback slot).
 */
(function (window) {
  "use strict";
  var PROTOCOL = "knife-office-bridge";
  var PROTOCOL_VERSION = 1;
  var PLUGIN_VERSION = "1.0.0";
  var HELLO_EVERY_MS = 1000;
  var HELLO_MAX = 120;
  var DEFAULT_TIMEOUT_MS = 20000;
  var plugin = window.Asc.plugin;

  var options = null;
  var port = null;
  var helloTimer = null;
  var helloCount = 0;
  var queue = Promise.resolve();

  /* ------------------------------------------------------------------------------------------- editor commands */
  // Each body runs INSIDE the editor (callCommand serialises it with toString): no closures, only `Api` and the args.

  var WORD = {
    get_text: function (a) {
      var doc = Api.GetDocument();
      var n = doc.GetElementsCount();
      var parts = [];
      for (var i = 0; i < n; i++) {
        var el = doc.GetElement(i);
        var t = "";
        try {
          t = el.GetClassType() === "paragraph" ? el.GetText() : el.GetRange().GetText();
        } catch {
          t = "";
        }
        parts.push(String(t).replace(/[\r\n]+$/, ""));
      }
      var text = parts.join("\n");
      var max = a.max_chars || 20000;
      return { elements: n, chars: text.length, truncated: text.length > max, text: text.slice(0, max) };
    },
    get_structure: function (a) {
      var doc = Api.GetDocument();
      var n = doc.GetElementsCount();
      var from = Math.max(0, a.from || 0);
      var limit = a.limit || 200;
      var items = [];
      for (var i = from; i < n && items.length < limit; i++) {
        var el = doc.GetElement(i);
        var type = el.GetClassType();
        var item = { index: i, type: type };
        var t = "";
        try {
          t = type === "paragraph" ? el.GetText() : el.GetRange().GetText();
        } catch {
          t = "";
        }
        t = String(t).replace(/[\r\n]+$/, "");
        if (type === "paragraph") {
          var style = el.GetStyle();
          // No direct style = the document's default paragraph style.
          item.style = style ? style.GetName() : "Normal";
          var m = /^heading\s*(\d)$/i.exec(item.style);
          if (m) item.heading = Number(m[1]);
        }
        item.text = t.length > 300 ? t.slice(0, 300) + "…" : t;
        if (t.length > 300) item.chars = t.length;
        items.push(item);
      }
      return { total: n, from: from, items: items, more: from + items.length < n };
    },
    get_selection: function () {
      var range = Api.GetDocument().GetRangeBySelect();
      var text = range ? String(range.GetText()) : "";
      return { empty: !text, text: text };
    },
    insert_text: function (a) {
      var doc = Api.GetDocument();
      var lines = String(a.text).split("\n");
      if (a.where === "cursor") {
        for (var i = 0; i < lines.length; i++) {
          if (i > 0) doc.InsertParagraphBreak();
          if (lines[i]) doc.EnterText(lines[i]);
        }
        return { where: "cursor", paragraph_breaks: lines.length - 1 };
      }
      var n = doc.GetElementsCount();
      var last = doc.GetElement(n - 1);
      var start = 0;
      if (last && last.GetClassType() === "paragraph" && String(last.GetText()).replace(/[\r\n]/g, "") === "") {
        last.AddText(lines[0]);
        start = 1;
      }
      for (var k = start; k < lines.length; k++) {
        var p = Api.CreateParagraph();
        p.AddText(lines[k]);
        doc.Push(p);
      }
      return { where: "end", paragraphs_added: lines.length - start, filled_empty_last: start === 1, total: doc.GetElementsCount() };
    },
    replace_text: function (a) {
      var doc = Api.GetDocument();
      var matchCase = a.match_case === true;
      var found = doc.Search(a.search, matchCase);
      var count = found ? found.length : 0;
      if (count > 0) doc.SearchAndReplace({ searchString: a.search, replaceString: a.replace, matchCase: matchCase });
      return { count: count, remaining: count > 0 ? doc.Search(a.search, matchCase).length : 0 };
    },
    insert_paragraphs: function (a) {
      var doc = Api.GetDocument();
      var n = doc.GetElementsCount();
      var at = typeof a.index === "number" && a.index >= 0 && a.index < n ? a.index : n;
      var styles = [];
      for (var s = 0; s < a.paragraphs.length; s++) {
        var name = a.paragraphs[s].style;
        var st = null;
        if (name) {
          // GetStyle falls back to the default style for an unknown name: compare the name it found.
          st = doc.GetStyle(name);
          if (!st || String(st.GetName()).toLowerCase() !== String(name).toLowerCase()) {
            var known = doc.GetAllStyles().map(function (x) {
              return x.GetName();
            });
            throw new Error('unknown paragraph style "' + name + '"; this document has: ' + known.slice(0, 40).join(", "));
          }
        }
        styles.push(st);
      }
      for (var i = 0; i < a.paragraphs.length; i++) {
        var p = Api.CreateParagraph();
        p.AddText(String(a.paragraphs[i].text));
        if (styles[i]) p.SetStyle(styles[i]);
        if (at + i >= doc.GetElementsCount()) doc.Push(p);
        else doc.AddElement(at + i, p);
      }
      return { inserted: a.paragraphs.length, at: at, total: doc.GetElementsCount() };
    },
    set_paragraph_style: function (a) {
      var doc = Api.GetDocument();
      var n = doc.GetElementsCount();
      var to = typeof a.to === "number" ? a.to : a.from;
      if (a.from < 0 || to >= n || to < a.from) throw new Error("paragraph index out of range (document has " + n + " elements, 0.." + (n - 1) + ")");
      var style = doc.GetStyle(a.style);
      if (!style || String(style.GetName()).toLowerCase() !== String(a.style).toLowerCase()) {
        var known = doc.GetAllStyles().map(function (x) {
          return x.GetName();
        });
        throw new Error('unknown paragraph style "' + a.style + '"; this document has: ' + known.slice(0, 40).join(", "));
      }
      var styled = 0;
      for (var i = a.from; i <= to; i++) {
        var el = doc.GetElement(i);
        if (el.GetClassType() !== "paragraph") continue;
        el.SetStyle(style);
        styled++;
      }
      return { styled: styled, style: style.GetName() };
    },
    delete_range: function (a) {
      var doc = Api.GetDocument();
      var n = doc.GetElementsCount();
      var to = typeof a.to === "number" ? a.to : a.from;
      if (a.from < 0 || to >= n || to < a.from) throw new Error("paragraph index out of range (document has " + n + " elements, 0.." + (n - 1) + ")");
      var removed = [];
      for (var i = a.from; i <= to; i++) {
        var el = doc.GetElement(i);
        var t = "";
        try {
          t = el.GetClassType() === "paragraph" ? el.GetText() : el.GetRange().GetText();
        } catch {
          t = "";
        }
        removed.push(String(t).replace(/[\r\n]+$/, ""));
      }
      // A document always keeps one paragraph: deleting everything leaves an empty one.
      if (a.from === 0 && to === n - 1) doc.Push(Api.CreateParagraph());
      for (var k = to; k >= a.from; k--) doc.RemoveElement(k);
      var text = removed.join("\n");
      return { deleted: to - a.from + 1, removed_text: text.length > 600 ? text.slice(0, 600) + "…" : text, total: doc.GetElementsCount() };
    },
    add_comment: function (a) {
      var doc = Api.GetDocument();
      var author = a.author || "Samurai Knife assistant";
      var comment = null;
      var on = "";
      if (a.quote) {
        var hits = doc.Search(a.quote, true);
        if (!hits || !hits.length) throw new Error('text "' + a.quote + '" not found');
        comment = hits[0].AddComment(a.text, author);
        on = "quote";
      } else if (typeof a.index === "number") {
        var n = doc.GetElementsCount();
        if (a.index < 0 || a.index >= n) throw new Error("paragraph index out of range (0.." + (n - 1) + ")");
        var el = doc.GetElement(a.index);
        comment = el.GetClassType() === "paragraph" ? el.AddComment(a.text, author) : el.GetRange().AddComment(a.text, author);
        on = "paragraph " + a.index;
      } else {
        var range = doc.GetRangeBySelect();
        if (range && String(range.GetText())) {
          comment = range.AddComment(a.text, author);
          on = "selection";
        } else {
          comment = doc.AddComment(a.text, author);
          on = "cursor";
        }
      }
      if (!comment) throw new Error("the editor refused the comment (protected or empty target)");
      return { added: true, on: on };
    },
    format_text: function (a) {
      var doc = Api.GetDocument();
      var ranges = [];
      var on = "";
      if (a.quote) {
        var hits = doc.Search(a.quote, a.match_case === true) || [];
        if (!hits.length) throw new Error('text "' + a.quote + '" not found');
        ranges = a.all ? hits : [hits[0]];
        on = ranges.length + " match" + (ranges.length === 1 ? "" : "es");
      } else if (typeof a.from === "number") {
        var n = doc.GetElementsCount();
        var to = typeof a.to === "number" ? a.to : a.from;
        if (a.from < 0 || to >= n || to < a.from) throw new Error("paragraph index out of range (document has " + n + " elements, 0.." + (n - 1) + ")");
        for (var i = a.from; i <= to; i++) ranges.push(doc.GetElement(i).GetRange());
        on = "elements " + a.from + ".." + to;
      } else {
        var sel = doc.GetRangeBySelect();
        if (!sel || !String(sel.GetText())) throw new Error("nothing is selected: pass quote or from/to");
        ranges = [sel];
        on = "selection";
      }
      for (var k = 0; k < ranges.length; k++) {
        var r = ranges[k];
        if (typeof a.bold === "boolean") r.SetBold(a.bold);
        if (typeof a.italic === "boolean") r.SetItalic(a.italic);
        if (typeof a.underline === "boolean") r.SetUnderline(a.underline);
        if (typeof a.strikeout === "boolean") r.SetStrikeout(a.strikeout);
        if (a.color) r.SetColor(a.color.r, a.color.g, a.color.b);
        if (a.highlight) r.SetHighlight(a.highlight);
        if (typeof a.size === "number") r.SetFontSize(Math.round(a.size * 2));
        if (a.font) r.SetFontFamily(a.font);
      }
      return { formatted: ranges.length, on: on };
    },
    insert_table: function (a) {
      var doc = Api.GetDocument();
      var rows = a.rows.length;
      var cols = 0;
      for (var r = 0; r < rows; r++) cols = Math.max(cols, a.rows[r].length);
      var table = Api.CreateTable(cols, rows);
      table.SetWidth("percent", 100);
      // The default "Normal Table" style draws no lines: use a bordered table style when the document has one.
      var names = ["Table Grid", "Bordered", "Bordered & Lined - Accent"];
      for (var s = 0; s < names.length; s++) {
        var style = doc.GetStyle(names[s]);
        if (style && String(style.GetName()).toLowerCase() === names[s].toLowerCase()) {
          table.SetStyle(style);
          break;
        }
      }
      for (var i = 0; i < rows; i++) {
        for (var c = 0; c < cols; c++) {
          var text = a.rows[i][c] === undefined || a.rows[i][c] === null ? "" : String(a.rows[i][c]);
          var para = table.GetRow(i).GetCell(c).GetContent().GetElement(0);
          var run = para.AddText(text);
          if (a.header && i === 0 && run && run.SetBold) run.SetBold(true);
        }
      }
      var n = doc.GetElementsCount();
      var at = typeof a.index === "number" && a.index >= 0 && a.index < n ? a.index : n;
      if (at >= n) doc.Push(table);
      else doc.AddElement(at, table);
      return { inserted: "table", rows: rows, cols: cols, at: at, total: doc.GetElementsCount() };
    },
    insert_list: function (a) {
      var doc = Api.GetDocument();
      var numbering = doc.CreateNumbering(a.numbered ? "numbered" : "bullet");
      var level = numbering.GetLevel(0);
      var n = doc.GetElementsCount();
      var at = typeof a.index === "number" && a.index >= 0 && a.index < n ? a.index : n;
      for (var i = 0; i < a.items.length; i++) {
        var p = Api.CreateParagraph();
        p.AddText(String(a.items[i]));
        p.SetNumbering(level);
        if (at + i >= doc.GetElementsCount()) doc.Push(p);
        else doc.AddElement(at + i, p);
      }
      return { inserted: a.items.length, numbered: a.numbered === true, at: at, total: doc.GetElementsCount() };
    },
    set_header_footer: function (a) {
      var doc = Api.GetDocument();
      var section = doc.GetFinalSection();
      var done = {};
      var parts = [["header", a.header], ["footer", a.footer]];
      for (var i = 0; i < parts.length; i++) {
        if (typeof parts[i][1] !== "string") continue;
        var content = parts[i][0] === "header" ? section.GetHeader("default", true) : section.GetFooter("default", true);
        content.RemoveAllElements();
        var lines = parts[i][1].split("\n");
        for (var k = 0; k < lines.length; k++) {
          var p = Api.CreateParagraph();
          if (lines[k]) p.AddText(lines[k]);
          content.Push(p);
        }
        done[parts[i][0]] = parts[i][1];
      }
      return done;
    },
    track_changes: function (a) {
      var doc = Api.GetDocument();
      doc.SetTrackRevisions(a.on === true);
      return { tracking: doc.IsTrackRevisions() };
    },
  };

  var CELL = {
    get_text: function (a) {
      var ws = Api.GetActiveSheet();
      var range = ws.GetUsedRange();
      var v = range.GetValue();
      var rows = Array.isArray(v) ? v : [[v]];
      var text = rows
        .map(function (r) {
          return (Array.isArray(r) ? r : [r]).join("\t");
        })
        .join("\n");
      var max = a.max_chars || 20000;
      return { sheet: ws.GetName(), address: range.GetAddress(false, false), chars: text.length, truncated: text.length > max, text: text.slice(0, max) };
    },
    get_structure: function () {
      var sheets = Api.GetSheets().map(function (s) {
        var used = s.GetUsedRange();
        return { name: s.GetName(), used: used ? used.GetAddress(false, false) : "" };
      });
      return { active: Api.GetActiveSheet().GetName(), sheets: sheets };
    },
    get_selection: function () {
      var sel = Api.GetSelection();
      var v = sel.GetValue();
      return { address: sel.GetAddress(false, false), values: Array.isArray(v) ? v : [[v]] };
    },
    cells_read: function (a) {
      var ws = a.sheet ? Api.GetSheet(a.sheet) : Api.GetActiveSheet();
      if (!ws) throw new Error('no sheet named "' + a.sheet + '"');
      var range = a.range ? ws.GetRange(a.range) : ws.GetUsedRange();
      if (!range) throw new Error('bad range "' + a.range + '"');
      var count = range.GetCount();
      if (count > 2000) throw new Error("range has " + count + " cells; read at most 2000 at a time");
      var v = range.GetValue();
      var values = Array.isArray(v) ? v : [[v]];
      // GetFormula only answers for a single cell ("= SUM(..)"); walk the filled cells for the rest.
      var cellFormulas = [];
      range.ForEach(function (cell) {
        var f = cell.GetFormula();
        if (typeof f === "string" && f.charAt(0) === "=" && cellFormulas.length < 500) {
          cellFormulas.push({ cell: cell.GetAddress(false, false), formula: "=" + f.slice(1).replace(/^\s+/, "") });
        }
      });
      return {
        sheet: ws.GetName(),
        address: range.GetAddress(false, false),
        values: values.map(function (row) {
          return Array.isArray(row) ? row : [row];
        }),
        formulas: cellFormulas,
        sheets: Api.GetSheets().map(function (s) {
          return s.GetName();
        }),
      };
    },
    cells_write: function (a) {
      var ws = a.sheet ? Api.GetSheet(a.sheet) : Api.GetActiveSheet();
      if (!ws) throw new Error('no sheet named "' + a.sheet + '"');
      var nonEmpty = [];
      for (var i = 0; i < a.cells.length; i++) {
        var current = ws.GetRange(a.cells[i][0]).GetValue();
        if (current !== "" && current !== null && current !== undefined) nonEmpty.push(a.cells[i][0] + "=" + String(current).slice(0, 40));
      }
      if (nonEmpty.length && !a.overwrite) {
        return { written: 0, needs_overwrite: true, non_empty: nonEmpty.slice(0, 20), non_empty_count: nonEmpty.length };
      }
      for (var k = 0; k < a.cells.length; k++) ws.GetRange(a.cells[k][0]).SetValue(a.cells[k][1]);
      return { written: a.cells.length, overwritten: nonEmpty.length, sheet: ws.GetName(), address: a.address };
    },
    cells_format: function (a) {
      var ws = a.sheet ? Api.GetSheet(a.sheet) : Api.GetActiveSheet();
      if (!ws) throw new Error('no sheet named "' + a.sheet + '"');
      var range = ws.GetRange(a.range);
      if (!range) throw new Error('bad range "' + a.range + '"');
      var done = [];
      if (typeof a.bold === "boolean") { range.SetBold(a.bold); done.push("bold"); }
      if (typeof a.italic === "boolean") { range.SetItalic(a.italic); done.push("italic"); }
      if (typeof a.underline === "boolean") { range.SetUnderline(a.underline ? "single" : "none"); done.push("underline"); }
      if (typeof a.font_size === "number") { range.SetFontSize(a.font_size); done.push("font_size"); }
      if (a.font_color) { range.SetFontColor(Api.CreateColorFromRGB(a.font_color.r, a.font_color.g, a.font_color.b)); done.push("font_color"); }
      if (a.fill) { range.SetFillColor(Api.CreateColorFromRGB(a.fill.r, a.fill.g, a.fill.b)); done.push("fill"); }
      if (a.number_format) { range.SetNumberFormat(a.number_format); done.push("number_format"); }
      if (a.align) { range.SetAlignHorizontal(a.align); done.push("align"); }
      if (typeof a.wrap === "boolean") { range.SetWrap(a.wrap); done.push("wrap"); }
      return { sheet: ws.GetName(), address: range.GetAddress(false, false), set: done };
    },
    column_width: function (a) {
      var ws = a.sheet ? Api.GetSheet(a.sheet) : Api.GetActiveSheet();
      if (!ws) throw new Error('no sheet named "' + a.sheet + '"');
      for (var c = a.first; c <= a.last; c++) ws.SetColumnWidth(c, a.width);
      return { sheet: ws.GetName(), columns: a.columns, width: a.width };
    },
    add_chart: function (a) {
      var ws = a.sheet ? Api.GetSheet(a.sheet) : Api.GetActiveSheet();
      if (!ws) throw new Error('no sheet named "' + a.sheet + '"');
      var name = ws.GetName().replace(/'/g, "''");
      var ref = "'" + name + "'!" + a.abs;
      // Size in EMU (36000 per mm); anchored at a cell (0-based column/row).
      var chart = ws.AddChart(ref, a.in_rows === true, a.type, 2, a.width_mm * 36000, a.height_mm * 36000, a.at_col, 0, a.at_row, 0);
      if (!chart) throw new Error("the editor refused the chart (check the range and type)");
      if (a.title && chart.SetTitle) chart.SetTitle(a.title, 13);
      return { added: a.type, data: ref, at: a.at };
    },
    sort_range: function (a) {
      var ws = a.sheet ? Api.GetSheet(a.sheet) : Api.GetActiveSheet();
      if (!ws) throw new Error('no sheet named "' + a.sheet + '"');
      var range = ws.GetRange(a.range);
      if (!range) throw new Error('bad range "' + a.range + '"');
      range.SetSort(ws.GetRange(a.key), a.descending ? "xlDescending" : "xlAscending", null, null, null, null, a.header ? "xlYes" : "xlNo");
      return { sheet: ws.GetName(), sorted: range.GetAddress(false, false), by: a.key, descending: a.descending === true };
    },
    add_sheet: function (a) {
      if (Api.GetSheet(a.name)) throw new Error('a sheet named "' + a.name + '" already exists');
      Api.AddSheet(a.name);
      return {
        added: a.name,
        sheets: Api.GetSheets().map(function (s) {
          return s.GetName();
        }),
      };
    },
  };

  var SLIDE = {
    get_text: function (a) {
      var pres = Api.GetPresentation();
      var n = pres.GetSlidesCount();
      var out = [];
      for (var i = 0; i < n; i++) {
        var shapes = pres.GetSlideByIndex(i).GetAllShapes();
        var texts = [];
        for (var k = 0; k < shapes.length; k++) {
          var content = shapes[k].GetDocContent();
          var t = content ? String(content.GetText()).replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "") : "";
          if (t) texts.push(t);
        }
        out.push("--- slide " + (i + 1) + "\n" + texts.join("\n"));
      }
      var text = out.join("\n");
      var max = a.max_chars || 20000;
      return { slides: n, chars: text.length, truncated: text.length > max, text: text.slice(0, max) };
    },
    get_structure: function () {
      var pres = Api.GetPresentation();
      var n = pres.GetSlidesCount();
      var slides = [];
      for (var i = 0; i < n; i++) {
        var shapes = pres.GetSlideByIndex(i).GetAllShapes();
        var texts = [];
        for (var k = 0; k < shapes.length; k++) {
          var content = shapes[k].GetDocContent();
          var t = content ? String(content.GetText()).replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "") : "";
          if (t) texts.push(t.length > 200 ? t.slice(0, 200) + "…" : t);
        }
        var item = { index: i, texts: texts, shapes: [] };
        // Every shape that holds text, by its index among the slide's shapes (for set_slide_text).
        for (var s = 0; s < shapes.length; s++) {
          var c = shapes[s].GetDocContent();
          if (c) {
            var st = String(c.GetText()).replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
            item.shapes.push({ shape: s, text: st.length > 200 ? st.slice(0, 200) + "…" : st });
          }
        }
        var notes = "";
        try {
          var page = pres.GetSlideByIndex(i).GetNotesPage();
          var body = page && page.GetBodyShape ? page.GetBodyShape() : null;
          var nc = body ? body.GetDocContent() : null;
          notes = nc ? String(nc.GetText()).replace(/^\s+|\s+$/g, "") : "";
        } catch {
          notes = "";
        }
        if (notes) item.notes = notes.length > 300 ? notes.slice(0, 300) + "…" : notes;
        slides.push(item);
      }
      return { count: n, current: pres.GetCurSlideIndex(), slides: slides };
    },
    set_slide_text: function (a) {
      var pres = Api.GetPresentation();
      var n = pres.GetSlidesCount();
      if (a.index < 0 || a.index >= n) throw new Error("slide index out of range (0.." + (n - 1) + ")");
      var shapes = pres.GetSlideByIndex(a.index).GetAllShapes();
      if (a.shape < 0 || a.shape >= shapes.length) throw new Error("shape index out of range (this slide has " + shapes.length + " shapes)");
      var content = shapes[a.shape].GetDocContent();
      if (!content) throw new Error("shape " + a.shape + " holds no text");
      var before = String(content.GetText()).replace(/^\s+|\s+$/g, "");
      // Keep the first paragraph (its formatting) and replace the text.
      var first = content.GetElementsCount() > 0 ? content.GetElement(0) : null;
      content.RemoveAllElements();
      var lines = String(a.text).split("\n");
      for (var i = 0; i < lines.length; i++) {
        var p = Api.CreateParagraph();
        if (i === 0 && first && first.GetParaPr && p.SetParaPr) {
          try { p.SetParaPr(first.GetParaPr()); } catch { /* keep the default */ }
        }
        if (lines[i]) p.AddText(lines[i]);
        content.Push(p);
      }
      return { slide: a.index, shape: a.shape, replaced: before.length > 200 ? before.slice(0, 200) + "…" : before };
    },
    set_slide_notes: function (a) {
      var pres = Api.GetPresentation();
      var n = pres.GetSlidesCount();
      if (a.index < 0 || a.index >= n) throw new Error("slide index out of range (0.." + (n - 1) + ")");
      var page = pres.GetSlideByIndex(a.index).GetNotesPage();
      if (!page) throw new Error("this slide has no notes page");
      var body = page.GetBodyShape ? page.GetBodyShape() : null;
      var content = body ? body.GetDocContent() : null;
      if (content) {
        content.RemoveAllElements();
        var lines = String(a.text).split("\n");
        for (var i = 0; i < lines.length; i++) {
          var p = Api.CreateParagraph();
          if (lines[i]) p.AddText(lines[i]);
          content.Push(p);
        }
      } else {
        page.AddBodyShapeText(String(a.text));
      }
      return { slide: a.index, notes: String(a.text).length };
    },
    delete_slide: function (a) {
      var pres = Api.GetPresentation();
      var n = pres.GetSlidesCount();
      if (n <= 1) throw new Error("a presentation keeps at least one slide");
      if (a.index < 0 || a.index >= n) throw new Error("slide index out of range (0.." + (n - 1) + ")");
      var slide = pres.GetSlideByIndex(a.index);
      var texts = [];
      var shapes = slide.GetAllShapes();
      for (var k = 0; k < shapes.length; k++) {
        var c = shapes[k].GetDocContent();
        var t = c ? String(c.GetText()).replace(/^\s+|\s+$/g, "") : "";
        if (t) texts.push(t.length > 100 ? t.slice(0, 100) + "…" : t);
      }
      if (!slide.Delete()) throw new Error("the editor refused to delete the slide");
      return { deleted: a.index, texts: texts, count: pres.GetSlidesCount() };
    },
    add_slide: function (a) {
      var pres = Api.GetPresentation();
      var w = pres.GetWidth();
      var h = pres.GetHeight();
      var slide = Api.CreateSlide();
      function box(lines, x, y, bw, bh, size) {
        var shape = Api.CreateShape("rect", bw, bh, Api.CreateNoFill(), Api.CreateStroke(0, Api.CreateNoFill()));
        shape.SetPosition(x, y);
        var content = shape.GetDocContent();
        // A new shape already holds one empty paragraph: the first line goes there.
        for (var i = 0; i < lines.length; i++) {
          var p = i === 0 && content.GetElementsCount() > 0 ? content.GetElement(0) : Api.CreateParagraph();
          var run = p.AddText(lines[i]);
          if (run && run.SetFontSize) run.SetFontSize(size);
          // A new shape's default style draws text in a light scheme colour (meant for a filled shape): use the theme's text colour.
          if (run && run.SetFill) run.SetFill(Api.CreateSolidFill(Api.CreateSchemeColor("tx1")));
          if (i > 0 || content.GetElementsCount() === 0) content.Push(p);
        }
        slide.AddObject(shape);
      }
      box([String(a.title)], Math.round(w * 0.06), Math.round(h * 0.06), Math.round(w * 0.88), Math.round(h * 0.18), 64);
      if (a.body) box(String(a.body).split("\n"), Math.round(w * 0.06), Math.round(h * 0.28), Math.round(w * 0.88), Math.round(h * 0.62), 36);
      var n = pres.GetSlidesCount();
      var at = typeof a.index === "number" && a.index >= 0 && a.index < n ? a.index : n;
      pres.AddSlide(slide, at);
      return { added_at: at, count: pres.GetSlidesCount() };
    },
  };

  // Commands every editor has (none yet: saving goes through the Document Server's command service, server-side).
  var SHARED = {};

  var TABLES = { word: WORD, cell: CELL, slide: SLIDE };

  /* --------------------------------------------------------------------------------------------- plumbing */

  function editorType() {
    var type = plugin.info && plugin.info.editorType;
    return type === "word" || type === "cell" || type === "slide" ? type : "unknown";
  }

  function commandsFor(type) {
    var table = TABLES[type] || {};
    return Object.keys(table).concat(Object.keys(SHARED));
  }

  /** Column letters <-> numbers for the cell writer (outside the editor: plain JS). */
  function colNumber(letters) {
    var n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n;
  }
  function colLetters(n) {
    var s = "";
    while (n > 0) {
      var m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  /** cells_write args -> [[A1, value], ...] for a rectangular block starting at the top-left cell. */
  function prepareCells(args) {
    var m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::.*)?$/.exec(String(args.start || args.range || ""));
    if (!m) throw new Error('start must be a cell like "B2"');
    var col0 = colNumber(m[1].toUpperCase());
    var row0 = Number(m[2]);
    var cells = [];
    var width = 0;
    for (var r = 0; r < args.values.length; r++) {
      var row = args.values[r];
      width = Math.max(width, row.length);
      for (var c = 0; c < row.length; c++) {
        if (row[c] === null || row[c] === undefined) continue;
        cells.push([colLetters(col0 + c) + (row0 + r), row[c]]);
      }
    }
    var address = colLetters(col0) + row0 + ":" + colLetters(col0 + Math.max(width, 1) - 1) + (row0 + args.values.length - 1);
    return { sheet: args.sheet, cells: cells, overwrite: args.overwrite === true, address: address };
  }

  /** Wraps a command body so an exception inside the editor comes back as {error} instead of silence. */
  function wrapped(body) {
    return {
      toString: function () {
        return "function(){try{return {ok:true,data:(" + body.toString() + ")(Asc.scope.args||{})};}catch(e){return {ok:false,error:String((e&&e.message)||e)};}}";
      },
    };
  }

  function runInEditor(body, args, isEdit, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        done = true;
        resolve({ ok: false, error: "the editor did not answer within " + Math.round(timeoutMs / 1000) + " s" });
      }, timeoutMs);
      window.Asc.scope = { args: args };
      plugin.callCommand(wrapped(body), false, isEdit, function (result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (result && typeof result === "object" && typeof result.ok === "boolean") resolve(result);
        else resolve({ ok: false, error: "the editor returned no result (is the document read-only or still loading?)" });
      });
    });
  }

  var READS = { get_text: true, get_structure: true, get_selection: true, cells_read: true };

  function execute(cmd, args) {
    var type = editorType();
    var table = TABLES[type] || {};
    var body = Object.prototype.hasOwnProperty.call(table, cmd) ? table[cmd] : Object.prototype.hasOwnProperty.call(SHARED, cmd) ? SHARED[cmd] : null;
    if (!body) return Promise.resolve({ ok: false, error: 'command "' + cmd + '" is not available in the ' + type + " editor (available: " + commandsFor(type).join(", ") + ")" });
    if (!READS[cmd] && plugin.info && plugin.info.isViewMode) return Promise.resolve({ ok: false, error: "the document is open read-only (view mode)" });
    var input = args && typeof args === "object" ? args : {};
    if (cmd === "cells_write") {
      try {
        input = prepareCells(input);
      } catch (e) {
        return Promise.resolve({ ok: false, error: String(e.message || e) });
      }
    }
    var timeout = typeof input.timeout_ms === "number" ? Math.min(Math.max(input.timeout_ms, 1000), 60000) : DEFAULT_TIMEOUT_MS;
    return runInEditor(body, input, !READS[cmd], timeout);
  }

  function onPortMessage(event) {
    var msg = event.data;
    if (!msg || typeof msg !== "object" || msg.protocol !== PROTOCOL) return;
    if (msg.kind === "ping") {
      port.postMessage({ protocol: PROTOCOL, kind: "pong", id: msg.id });
      return;
    }
    if (msg.kind !== "request" || typeof msg.id !== "string" || typeof msg.cmd !== "string") return;
    var started = Date.now();
    var current = port;
    // One command at a time: callCommand has a single callback slot in the plugin runtime.
    queue = queue.then(function () {
      return execute(msg.cmd, msg.args).then(function (result) {
        current.postMessage({ protocol: PROTOCOL, kind: "response", id: msg.id, ok: result.ok, data: result.data, error: result.error, ms: Date.now() - started });
      });
    });
  }

  function appWindow() {
    return window.parent && window.parent.parent && window.parent.parent !== window.parent ? window.parent.parent : null;
  }

  function sendHello() {
    var target = appWindow();
    if (!target || !options) return;
    var info = plugin.info || {};
    target.postMessage(
      {
        protocol: PROTOCOL,
        v: PROTOCOL_VERSION,
        kind: "hello",
        token: options.token,
        editor: editorType(),
        viewMode: Boolean(info.isViewMode),
        title: info.documentTitle || "",
        plugin: PLUGIN_VERSION,
        commands: commandsFor(editorType()),
      },
      options.appOrigin,
    );
  }

  function onWindowMessage(event) {
    if (!options) return;
    var msg = event.data;
    if (!msg || typeof msg !== "object" || msg.protocol !== PROTOCOL || msg.kind !== "welcome") return;
    // Only the Samurai Knife page that embeds this editor, with this session's token, may hand over the channel.
    if (event.origin !== options.appOrigin || event.source !== appWindow() || msg.token !== options.token) return;
    var next = event.ports && event.ports[0];
    if (!next) return;
    if (port) port.close();
    port = next;
    port.onmessage = onPortMessage;
    stopHello();
  }

  function stopHello() {
    if (helloTimer) clearInterval(helloTimer);
    helloTimer = null;
  }

  function startHello() {
    stopHello();
    helloCount = 0;
    sendHello();
    helloTimer = setInterval(function () {
      helloCount++;
      if (helloCount > HELLO_MAX) return stopHello();
      sendHello();
    }, HELLO_EVERY_MS);
  }

  function readOptions() {
    var o = plugin.info && plugin.info.options;
    if (!o || typeof o.token !== "string" || o.token.length < 20 || typeof o.appOrigin !== "string" || !/^https?:\/\/[^/]+$/.test(o.appOrigin)) return null;
    return { token: o.token, appOrigin: o.appOrigin };
  }

  window.addEventListener("message", onWindowMessage, false);

  plugin.init = function () {
    options = readOptions();
    if (options) startHello();
  };
  plugin.onUpdateOptions = function () {
    var next = readOptions();
    if (next && (!options || next.token !== options.token)) {
      options = next;
      startHello();
    }
  };
  plugin.button = function () {};

  // For the unit tests (tests/office_live.test.mjs load this file in a sandbox).
  window.__knifeBridgeTest = { prepareCells: prepareCells, commandsFor: commandsFor, wrapped: wrapped, onWindowMessage: onWindowMessage, readOptions: readOptions };
})(window);
