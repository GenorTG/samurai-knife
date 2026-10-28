// CV document layouts and exports (src/lib/cv/render/layout.ts, view.ts, sheet-html.ts; docs/CV-STUDIO.md "Layouts and export"):
// the layout catalogue is consistent with the DOCX script, contact items know their kind, links print short or full,
// showcase pages come from projects that have one, and the sheet sent for the PDF/HTML export is reduced to inert markup.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/cv_layouts.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const layout = await import("../src/lib/cv/render/layout.ts");
const { buildCvView, contactKind } = await import("../src/lib/cv/render/view.ts");
const { cleanSheet, SheetError, pdfHtml, standaloneHtml } = await import("../src/lib/cv/render/sheet-html.ts");
const { profileSchema } = await import("../src/lib/cv/schema.ts");

// Synthetic only: never real personal data.
const profile = () =>
  profileSchema.parse({
    contact: {
      name: "Jan Testowy",
      email: "jan@example.test",
      phone: "+48 600 100 200",
      links: [
        { label: "GitHub", url: "https://github.com/jantest" },
        { label: "LinkedIn", url: "https://www.linkedin.com/in/jantest/" },
        { label: "Portfolio", url: "https://jan.example.test/" },
      ],
    },
    summary: { pl: "Buduję usługi.", en: "I build services." },
    projects: [
      { id: "knife", name: "Knife", url: "https://knife.example.test", summary: { pl: "Narzędzie", en: "A tool" }, page: true, story: { pl: "", en: "First paragraph.\n\nSecond paragraph." }, role: { pl: "", en: "Author" }, outcome: { pl: "", en: "Used daily" } },
      { id: "plain", name: "Plain", summary: { pl: "", en: "No page here" } },
      { id: "empty", name: "Empty page", page: true },
    ],
  });

test("the catalogue: 14 layouts, each fully described, the DOCX script knows the same ones and photo rules", () => {
  assert.equal(layout.CV_LAYOUTS.length, 14);
  const py = readFileSync(new URL("../server/py/scripts/cv_docx.py", import.meta.url), "utf8");
  const tuple = (name) => [...new RegExp(`^${name} = \\(([^)]*)\\)`, "m").exec(py)[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tuple("LAYOUTS"), [...layout.CV_LAYOUTS]);
  assert.deepEqual(tuple("PHOTO_LAYOUTS"), layout.CV_LAYOUTS.filter((id) => layout.CV_LAYOUT_INFO[id].photo));
  for (const id of layout.CV_LAYOUTS) {
    const info = layout.CV_LAYOUT_INFO[id];
    assert.ok(info.label && info.description, id);
    assert.ok(layout.CV_ACCENT_IDS.includes(info.defaultAccent), id);
    assert.ok(layout.CV_FONTS.includes(info.defaultFonts) && info.defaultFonts !== "auto", id);
    // ATS-safe means one plain column and no photo.
    if (info.atsSafe) {
      assert.equal(info.structure, "single", id);
      assert.equal(info.photo, false, id);
    }
  }
});

test("look helpers: ATS prints black and no icons, auto falls back to the layout's own choice", () => {
  assert.equal(layout.accentOf({ layout: "ats", accent: "wine" }), layout.CV_ACCENTS.black);
  assert.equal(layout.accentOf({ layout: "modern", accent: "auto" }), layout.CV_ACCENTS.navy);
  assert.equal(layout.accentOf({ layout: "modern", accent: "teal" }), layout.CV_ACCENTS.teal);
  assert.equal(layout.fontsOf({ layout: "classic", fonts: "auto" }), "serif");
  assert.equal(layout.fontsOf({ layout: "classic", fonts: "inter" }), "inter");
  assert.equal(layout.iconsOf({ layout: "ats", icons: true }), false);
  assert.equal(layout.iconsOf({ layout: "modern", icons: true }), true);
  assert.equal(layout.showsPhoto("ats", true, true), false);
  assert.equal(layout.showsPhoto("sidebar", true, false), false);
  assert.equal(layout.showsPhoto("sidebar", true, true), true);
  assert.equal(layout.tintOf("#000000", 1), "#ffffff");
  assert.equal(layout.tintOf("#ffffff", 0.5), "#ffffff");
  assert.match(layout.tintOf("#1f5f8b", 0.9), /^#[0-9a-f]{6}$/);
});

test("every font file a font pair needs ships with the app", () => {
  for (const fonts of layout.CV_FONTS.filter((f) => f !== "auto")) {
    for (const file of layout.fontFiles(fonts)) assert.ok(existsSync(new URL(`../public/cv-fonts/${file}`, import.meta.url)), `${fonts}: ${file}`);
  }
});

test("contact items know their kind; links print short by default and in full on request", () => {
  assert.equal(contactKind("mailto:a@b.c"), "email");
  assert.equal(contactKind("tel:+48"), "phone");
  assert.equal(contactKind("https://www.linkedin.com/in/x"), "linkedin");
  assert.equal(contactKind("https://github.com/x"), "github");
  assert.equal(contactKind("https://x.example", "my GitHub"), "github");
  assert.equal(contactKind("https://x.example"), "web");
  const short = buildCvView(profile(), "en").contact;
  const kinds = short.map((c) => c.kind);
  for (const kind of ["email", "phone", "github", "linkedin", "web"]) assert.ok(kinds.includes(kind), kind);
  const gh = short.find((c) => c.kind === "github");
  assert.equal(gh.href, "https://github.com/jantest");
  assert.ok(!gh.text.startsWith("https://"), gh.text);
  const full = buildCvView(profile(), "en", { fullUrls: true }).contact.find((c) => c.kind === "github");
  assert.equal(full.text, "https://github.com/jantest");
});

test("showcase pages: only projects with a page and something on it, story split into paragraphs, labels per language", () => {
  const view = buildCvView(profile(), "en");
  assert.deepEqual(view.pages.map((p) => p.name), ["Knife"]);
  const [page] = view.pages;
  assert.deepEqual(page.story, ["First paragraph.", "Second paragraph."]);
  assert.equal(page.role, "Author");
  assert.equal(page.outcome, "Used daily");
  assert.equal(page.href, "https://knife.example.test");
  assert.equal(view.pageTitles.outcome, "Outcome");
  assert.equal(buildCvView(profile(), "pl").pageTitles.outcome, "Efekt");
});

const SHEET = `<div>outside</div><article class="cvdoc" data-theme="modern" style="--cv-accent:#1f5f8b;background:url(https://evil.test/x)" onclick="steal()">
<style>@page { size: letter; }</style><style>body{background:url(https://evil.test/y)}</style>
<script>alert(1)</script><iframe src="https://evil.test"></iframe><link rel="stylesheet" href="https://evil.test/a.css">
<img class="cv-photo round" src="https://evil.test/track.png" alt="Jan">
<a href="javascript:alert(1)">bad</a><a href="https://github.com/jantest">github.com/jantest</a><a href="mailto:jan@example.test">mail</a>
<p onmouseover='x()'>Text</p></article><div>after</div>`;

test("cleanSheet keeps only the sheet and strips anything active or external", () => {
  const clean = cleanSheet(SHEET, null);
  assert.ok(clean.startsWith("<article") && clean.endsWith("</article>"));
  for (const bad of ["outside", "after", "<script", "<iframe", "<link", "onclick", "onmouseover", "evil.test", "javascript:", "<img"]) assert.ok(!clean.includes(bad), bad);
  assert.ok(clean.includes('style="--cv-accent:#1f5f8b"'));
  assert.ok(clean.includes("<style>@page { size: letter; }</style>"));
  assert.ok(clean.includes('href="https://github.com/jantest"'));
  assert.ok(clean.includes('href="mailto:jan@example.test"'));
  const withPhoto = cleanSheet(SHEET, "data:image/jpeg;base64,AAAA");
  assert.match(withPhoto, /<img class="cv-photo round" src="data:image\/jpeg;base64,AAAA" alt="Jan">/);
  assert.throws(() => cleanSheet("<div>no sheet</div>", null), SheetError);
});

test("cleanSheet: SVG links and images, xlink, obfuscated schemes, comments and split tags never survive", () => {
  const hostile = `<article class="cvdoc" data-theme="modern"><svg viewBox="0 0 24 24"><path d="M1 2L3 4" fill="none"/><image href="http://x.test/a"/><image xlink:href="file:///etc/passwd"/><use href="#x"/><a xlink:href="javascript:alert(1)"><text>x</text></a><foreignObject><img src=x onerror=alert(1)></foreignObject><animate attributeName="href" to="javascript:alert(1)"/></svg>
<a href="java&#x09;script:alert(1)">tab</a><a href=" javascript:alert(1)">space</a><a href="JaVaScRiPt:alert(1)">case</a><a href="data:text/html,x">data</a><a href="https://ok.test/p?a=1&amp;b=2" target="_top">ok</a>
<!-- <script>alert(1)</script> --><scr<script>x</script>ipt>alert(2)</script><p title="x><script>alert(3)</script>">t</p>
<style>@import url(http://x.test/i.css); @page { size: A4; }</style><p style="--cv-accent:url(http://x.test);color:red">s</p><p style="--cv-tint:#ffffff">tint</p>
<math><mi xlink:href="javascript:alert(4)">m</mi></math><object data="x"></object><img src="http://x.test/t.png" alt="Me"></article>`;
  const clean = cleanSheet(hostile, null);
  for (const bad of ["<image", "<use", "<animate", "<foreignobject", "<math", "<object", "<script", "<text", "javascript", "JaVaScRiPt", "xlink", "file:", "x.test/a", "x.test/i.css", "x.test/t.png", "data:text", "onerror", "<img", "@import", "url(", "color:red", 'target="_top"', "<!--"]) {
    assert.ok(!clean.toLowerCase().includes(bad.toLowerCase()), `${bad} survived: ${clean}`);
  }
  assert.match(clean, /<path d="M1 2L3 4" fill="none"\/>/);
  assert.ok(clean.includes('href="https://ok.test/p?a=1&amp;b=2"'), clean);
  assert.ok(clean.includes('style="--cv-tint:#ffffff"'), clean);
  assert.ok(!/<scr|<\/?ipt/i.test(clean) && clean.includes("ipt&gt;"), "split tags cannot reassemble");
  for (const name of ["tab", "space", "case", "data"]) assert.match(clean, new RegExp(`<a>${name}</a>`));
});

test("the PDF document loads fonts only from the renderer's base; the HTML file embeds them", () => {
  const doc = { sheetHtml: SHEET, lang: "en", title: "Jan <CV>", paper: "letter", fonts: "inter", photoDataUrl: null };
  const pdf = pdfHtml(doc);
  assert.ok(pdf.includes("https://cv.invalid/cv-fonts/inter-latin-400-normal.woff2"));
  assert.ok(!pdf.includes('url("/cv-fonts/'));
  assert.ok(!pdf.includes("source-serif-4"), "only the chosen pair's faces");
  assert.ok(pdf.includes("<title>Jan &lt;CV&gt;</title>"));
  assert.ok(pdf.includes("@page { size: letter;"));
  const html = standaloneHtml({ ...doc, fonts: "serif" });
  assert.ok(html.includes("data:font/woff2;base64,"));
  assert.ok(!html.includes("cv.invalid"));
  assert.ok(!html.includes("evil.test"));
});
