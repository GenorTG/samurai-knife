#!/usr/bin/env python3
"""CV -> DOCX (python-docx). Usage: cv_docx.py request.json response.json

Request  {"view": <CvView JSON from src/lib/cv/render/view.ts>, "theme": <layout id, src/lib/cv/render/layout.ts>,
          "look": {"accent": "#rrggbb", "fonts": "inter|serif|mixed|geist", "density": "comfortable|compact",
                   "paper": "a4|letter", "icons": bool}, "page_mode": "cv|cv+pages|pages",
          "photo": "/abs/photo.jpg"|null, "photo_shape": "round|square", "out_dir": "/abs/scratch", "filename": "cv.docx"}
Response {"ok": true, "file": "cv.docx", "mime": "...wordprocessingml.document", "bytes": N} | {"ok": false, "error": "..."}

No profile logic lives here: the TypeScript side already decided what prints (titles, dates, empty-field skipping,
consent rule), this script only lays the view out. Real Word styles everywhere (Title, Subtitle, Heading 1/2, List Bullet)
and plain spaces (no U+00A0); every link is a real hyperlink (w:hyperlink + an external relationship). The ATS-safe
layouts (ATS, Compact, Minimal, Classic) are one linear flow: no tables, text boxes, columns or images. The others map to
what Word does reliably: side-column layouts are one borderless two-column table, Banner a shaded header table, Timeline
and Europass a label | content table per section; fonts become Word's own (Calibri / Georgia / Consolas: a DOCX does not
carry the PDF's bundled fonts), icons are left out.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from docx import Document
from docx.document import Document as DocumentType
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Mm, Pt, RGBColor
from docx.table import Table, _Cell
from docx.text.paragraph import Paragraph

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
FONT = "Calibri"
INK = RGBColor(0x11, 0x11, 0x11)
GREY = RGBColor(0x44, 0x44, 0x44)
LAYOUTS = ("ats", "compact", "minimal", "classic", "modern", "elegant", "executive", "technical", "timeline", "banner", "sidebar", "rightbar", "creative", "europass")
# src/lib/cv/render/layout.ts (CV_LAYOUT_INFO.photo): the ATS-safe layouts and Technical never print a photo.
PHOTO_LAYOUTS = ("modern", "elegant", "executive", "timeline", "banner", "sidebar", "rightbar", "creative", "europass")
DEFAULT_ACCENT = {"ats": "#111111", "modern": "#1f5f8b", "sidebar": "#1f5f8b", "elegant": "#7a5c35"}
SERIF = "Georgia"
MONO = "Consolas"
PAPER = {"a4": (210, 297), "letter": (215.9, 279.4)}
LANG_TAG = {"pl": "pl-PL", "en": "en-GB"}
NBSP = " "


class ToolError(Exception):
    """A readable, expected failure."""


def text_of(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def list_of(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def strings(value: Any) -> list[str]:
    return [s for s in (text_of(v) for v in list_of(value)) if s]


def plain(value: str) -> str:
    """DOCX keeps plain spaces: not every ATS treats U+00A0 as whitespace."""
    return value.replace(NBSP, " ")


def hex_rgb(value: str) -> RGBColor:
    v = value.strip().lstrip("#")
    if len(v) != 6 or any(c not in "0123456789abcdefABCDEF" for c in v):
        raise ToolError("look.accent: expected #rrggbb.")
    return RGBColor(int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16))


def tint_hex(colour: RGBColor, amount: float) -> str:
    """The colour mixed with white (`amount` of white), as RRGGBB for cell shading."""
    return "".join(f"{round(c + (255 - c) * amount):02X}" for c in colour)


def fonts_for(pair: str) -> tuple[str, str]:
    """(heading font, body font) for a font pair; Word's own families, the DOCX does not embed fonts."""
    if pair == "serif":
        return SERIF, SERIF
    if pair == "mixed":
        return SERIF, FONT
    return FONT, FONT


def add_link(paragraph: Paragraph, text: str, url: str, colour: RGBColor | None = None, size: float | None = None) -> None:
    """A real hyperlink run (w:hyperlink with an external relationship); plain text when there is no safe URL."""
    if not url or not url.lower().startswith(("http://", "https://", "mailto:", "tel:")):
        run = paragraph.add_run(text)
        if colour is not None:
            run.font.color.rgb = colour
        if size:
            run.font.size = Pt(size)
        return
    rel = paragraph.part.relate_to(url, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", is_external=True)
    link = OxmlElement("w:hyperlink")
    link.set(qn("r:id"), rel)
    run = OxmlElement("w:r")
    rpr = OxmlElement("w:rPr")
    if colour is not None:
        c = OxmlElement("w:color")
        c.set(qn("w:val"), str(colour))
        rpr.append(c)
    if size:
        sz = OxmlElement("w:sz")
        sz.set(qn("w:val"), str(round(size * 2)))
        rpr.append(sz)
    run.append(rpr)
    t = OxmlElement("w:t")
    t.text = text
    t.set(qn("xml:space"), "preserve")
    run.append(t)
    link.append(run)
    paragraph._p.append(link)


def style_setup(doc: DocumentType, lang: str, accent: RGBColor, heading_font: str = FONT, body_font: str = FONT, paper: str = "a4", compact: bool = False) -> None:
    section = doc.sections[0]
    width, height = PAPER.get(paper, PAPER["a4"])
    section.page_width, section.page_height = Mm(width), Mm(height)
    section.left_margin = section.right_margin = Mm(14 if compact else 18)
    section.top_margin = section.bottom_margin = Mm(12 if compact else 16)
    k = 0.92 if compact else 1.0

    # name: (size pt, bold, colour, space before pt, space after pt)
    spec = {
        "Normal": (10 * k, False, INK, 0, 3 * k),
        "Title": (22 * k, True, INK, 0, 2),
        "Subtitle": (11.5 * k, False, accent, 0, 4),
        "Heading 1": (11 * k, True, accent, 12 * k, 4 * k),
        "Heading 2": (10.5 * k, True, INK, 6 * k, 0),
        "List Bullet": (10 * k, False, INK, 0, 2 * k),
    }
    for name, (size, bold, colour, before, after) in spec.items():
        style = doc.styles[name]
        family = heading_font if name in ("Title", "Subtitle", "Heading 1", "Heading 2") else body_font
        font = style.font
        font.name, font.size, font.bold, font.italic = family, Pt(size), bold, False
        font.color.rgb = colour
        rpr = style.element.get_or_add_rPr()
        fonts = rpr.get_or_add_rFonts()
        for attr in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
            fonts.set(qn(attr), family)
        for attr in ("w:asciiTheme", "w:hAnsiTheme", "w:cstheme", "w:eastAsiaTheme"):
            if fonts.get(qn(attr)) is not None:
                del fonts.attrib[qn(attr)]
        for spacing in rpr.findall(qn("w:spacing")):  # stock Subtitle tracks its letters wide
            rpr.remove(spacing)
        lang_el = rpr.find(qn("w:lang"))
        if lang_el is None:
            lang_el = rpr.makeelement(qn("w:lang"), {})
            rpr.append(lang_el)
        lang_el.set(qn("w:val"), LANG_TAG[lang])
        pf = style.paragraph_format
        pf.space_before, pf.space_after = Pt(before), Pt(after)
        pf.line_spacing = 1.1
    # The stock Title style carries a bottom border and theme spacing; the CV masthead stays clean.
    ppr = doc.styles["Title"].element.get_or_add_pPr()
    for border in ppr.findall(qn("w:pBdr")):
        ppr.remove(border)
    doc.styles["Heading 1"].font.all_caps = True
    doc.styles["Heading 1"].paragraph_format.keep_with_next = True
    doc.styles["Heading 2"].paragraph_format.keep_with_next = True


class Flow:
    """Where paragraphs go: the document body or one table cell (a new cell already holds one empty paragraph)."""

    def __init__(self, container: Any, small: bool = False) -> None:
        self.container = container
        self.small = small
        paragraphs = getattr(container, "paragraphs", [])
        self.fresh = paragraphs[0] if isinstance(container, _Cell) and paragraphs and not paragraphs[0].text else None

    def para(self, text: str = "", style: str | None = None) -> Paragraph:
        if self.fresh is not None:
            paragraph, self.fresh = self.fresh, None
            if style:
                paragraph.style = style
            if text:
                paragraph.add_run(text)
        else:
            paragraph = self.container.add_paragraph(text, style=style)
        if self.small and style in (None, "Normal", "List Bullet"):
            for run in paragraph.runs:
                run.font.size = Pt(9)
        return paragraph


def meta_line(f: Flow, text: str, keep_with_next: bool = False) -> None:
    """A small grey line (dates, place, tech); skipped when empty."""
    if not text:
        return
    paragraph = f.para()
    run = paragraph.add_run(text)
    run.font.size = Pt(9.5)
    run.font.color.rgb = GREY
    paragraph.paragraph_format.keep_with_next = keep_with_next


def bullets(f: Flow, items: list[str]) -> None:
    for item in items:
        f.para(item, style="List Bullet")


def picture(f: Flow, path: Path, width_mm: float, align: WD_ALIGN_PARAGRAPH) -> None:
    paragraph = f.para()
    paragraph.alignment = align
    paragraph.add_run().add_picture(str(path), width=Mm(width_mm))


def round_photo(src: Path, out_dir: Path) -> Path:
    """Square JPEG -> round PNG with a transparent outside (Word has no reliable clip for inline pictures)."""
    from PIL import Image, ImageDraw, ImageOps  # Pillow is in requirements.txt (pdf lane)

    with Image.open(src) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
    side = min(image.size)
    left, top = (image.width - side) // 2, (image.height - side) // 2
    image = image.crop((left, top, left + side, top + side)).resize((600, 600), Image.Resampling.LANCZOS)
    scale = 4  # supersampled mask = smooth edge
    mask = Image.new("L", (600 * scale, 600 * scale), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, 600 * scale - 1, 600 * scale - 1), fill=255)
    rgba = image.convert("RGBA")
    rgba.putalpha(mask.resize((600, 600), Image.Resampling.LANCZOS))
    target = out_dir / "photo-round.png"
    rgba.save(target)
    return target


def no_borders(table: Table) -> None:
    tbl_pr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "nil")
        borders.append(el)
    tbl_pr.append(borders)
    layout = OxmlElement("w:tblLayout")
    layout.set(qn("w:type"), "fixed")
    tbl_pr.append(layout)


def cell_setup(cell: _Cell, width_mm: float, fill: str | None = None, margins_mm: tuple[float, float, float, float] = (0, 0, 0, 0)) -> None:
    cell.width = Mm(width_mm)
    cell.vertical_alignment = WD_ALIGN_VERTICAL.TOP
    tc_pr = cell._tc.get_or_add_tcPr()
    if fill:
        shd = OxmlElement("w:shd")
        shd.set(qn("w:val"), "clear")
        shd.set(qn("w:color"), "auto")
        shd.set(qn("w:fill"), fill)
        tc_pr.append(shd)
    mar = OxmlElement("w:tcMar")
    for edge, mm in zip(("top", "left", "bottom", "right"), margins_mm):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:w"), str(round(mm * 56.7)))  # twentieths of a point
        el.set(qn("w:type"), "dxa")
        mar.append(el)
    tc_pr.append(mar)


def two_cells(doc: DocumentType, widths: tuple[float, float]) -> tuple[_Cell, _Cell]:
    table = doc.add_table(rows=1, cols=2)
    table.autofit = False
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    no_borders(table)
    for column, width in zip(table.columns, widths):
        column.width = Mm(width)
    left, right = table.rows[0].cells
    return left, right


class View:
    def __init__(self, view: dict[str, Any]) -> None:
        self.v = view
        titles = view.get("titles")
        self.titles = titles if isinstance(titles, dict) else {}

    def title(self, key: str) -> str:
        return text_of(self.titles.get(key)) or key.capitalize()

    def get(self, key: str) -> str:
        return text_of(self.v.get(key))

    def contact(self) -> list[dict[str, str]]:
        return [{"text": text_of(c.get("text")), "href": text_of(c.get("href"))} for c in list_of(self.v.get("contact")) if isinstance(c, dict) and text_of(c.get("text"))]

    def items(self, key: str, required: str) -> list[dict[str, Any]]:
        return [e for e in list_of(self.v.get(key)) if isinstance(e, dict) and text_of(e.get(required))]


def contact_line(paragraph: Paragraph, items: list[dict[str, str]], colour: RGBColor | None = None) -> None:
    for i, item in enumerate(items):
        if i:
            sep = paragraph.add_run("  |  ")
            if colour is not None:
                sep.font.color.rgb = colour
        add_link(paragraph, item["text"], item["href"], colour)


def masthead(f: Flow, v: View, align: WD_ALIGN_PARAGRAPH | None = None, contact: bool = True, colour: RGBColor | None = None) -> None:
    for text, style in ((v.get("name"), "Title"), (v.get("headline"), "Subtitle")):
        if text:
            paragraph = f.para(text, style=style)
            paragraph.alignment = align
            if colour is not None:
                for run in paragraph.runs:
                    run.font.color.rgb = colour
    if contact and v.contact():
        paragraph = f.para()
        paragraph.alignment = align
        contact_line(paragraph, v.contact(), colour)


def summary(f: Flow, v: View) -> None:
    if text := v.get("summary"):
        f.para(v.title("summary"), style="Heading 1")
        f.para(text)


def experience(f: Flow, v: View) -> None:
    items = v.items("experience", "heading")
    if not items:
        return
    f.para(v.title("experience"), style="Heading 1")
    for e in items:
        f.para(text_of(e.get("heading")), style="Heading 2")
        meta_line(f, " · ".join(p for p in (text_of(e.get("dates")), text_of(e.get("place")), text_of(e.get("note"))) if p), keep_with_next=True)
        bullets(f, strings(e.get("bullets")))


def projects(f: Flow, v: View) -> None:
    items = v.items("projects", "name")
    if not items:
        return
    f.para(v.title("projects"), style="Heading 1")
    for p in items:
        f.para(text_of(p.get("name")), style="Heading 2")
        if text_of(p.get("urlText")):
            paragraph = f.para()
            paragraph.paragraph_format.keep_with_next = True
            add_link(paragraph, text_of(p.get("urlText")), text_of(p.get("href")), GREY, 9.5)
        if text_of(p.get("summary")):
            f.para(text_of(p.get("summary")))
        meta_line(f, text_of(p.get("tech")), keep_with_next=True)
        bullets(f, strings(p.get("bullets")))


def skills(f: Flow, v: View, stacked: bool = False) -> None:
    items = v.items("skills", "items")
    if not items:
        return
    f.para(v.title("skills"), style="Heading 1")
    for g in items:
        if stacked:
            if text_of(g.get("name")):
                f.para(text_of(g.get("name")), style="Heading 2")
            f.para(text_of(g.get("items")))
            continue
        paragraph = f.para()
        if text_of(g.get("name")):
            paragraph.add_run(f"{text_of(g.get('name'))}: ").bold = True
        paragraph.add_run(text_of(g.get("items")))


def education(f: Flow, v: View) -> None:
    items = v.items("education", "institution")
    if not items:
        return
    f.para(v.title("education"), style="Heading 1")
    for e in items:
        f.para(text_of(e.get("institution")), style="Heading 2")
        meta_line(f, text_of(e.get("dates")), keep_with_next=bool(text_of(e.get("detail"))))
        if text_of(e.get("detail")):
            f.para(text_of(e.get("detail")))


def languages(f: Flow, v: View, as_bullets: bool = True) -> None:
    if items := strings(v.v.get("languages")):
        f.para(v.title("languages"), style="Heading 1")
        if as_bullets:
            bullets(f, items)
        else:
            for item in items:
                f.para(item)


def extras(f: Flow, v: View) -> None:
    if text := v.get("extras"):
        f.para(v.title("extras"), style="Heading 1")
        f.para(text)


def consent(f: Flow, v: View) -> None:
    if text := v.get("consent"):
        paragraph = f.para()
        paragraph.paragraph_format.space_before = Pt(14)
        run = paragraph.add_run(text)
        run.font.size = Pt(7.5)
        run.font.color.rgb = RGBColor(0x55, 0x55, 0x55)


def custom(f: Flow, v: View, key: str) -> None:
    """A user-defined section (`custom:<id>`): title, then per item "title · url" + date, then the text."""
    section = next((s for s in list_of(v.v.get("custom")) if isinstance(s, dict) and s.get("key") == key), None)
    if not section or not text_of(section.get("title")):
        return
    items = [i for i in list_of(section.get("items")) if isinstance(i, dict)]
    if not items:
        return
    f.para(text_of(section.get("title")), style="Heading 1")
    for item in items:
        title, url_text = text_of(item.get("title")), text_of(item.get("urlText"))
        if title or url_text:
            paragraph = f.para(title, style="Heading 2")
            if url_text:
                if title:
                    paragraph.add_run(" · ")
                add_link(paragraph, url_text, text_of(item.get("href")))
        meta_line(f, text_of(item.get("date")), keep_with_next=bool(text_of(item.get("text"))))
        if text_of(item.get("text")):
            f.para(text_of(item.get("text")))


SECTIONS = {"summary": summary, "experience": experience, "projects": projects, "skills": skills, "education": education, "languages": languages, "extras": extras}
DEFAULT_ORDER = ["summary", "experience", "projects", "skills", "education", "languages", "extras"]
SIDE_SECTIONS = {"skills", "languages", "education"}


def order_of(v: View) -> list[str]:
    """The print order the view decided (`order`); views from before custom sections fall back to the standard one."""
    order = [k for k in strings(v.v.get("order")) if k in SECTIONS or k.startswith("custom:")]
    return order or DEFAULT_ORDER


def section(f: Flow, v: View, key: str) -> None:
    if key.startswith("custom:"):
        custom(f, v, key)
    elif key in SECTIONS:
        SECTIONS[key](f, v)


def body(f: Flow, v: View) -> None:
    for key in order_of(v):
        section(f, v, key)


def shade_cell(cell: _Cell, fill: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    tc_pr.append(shd)


def recolour(cell: _Cell, colour: RGBColor) -> None:
    """Every run in a cell in one colour (text on a dark fill)."""
    for paragraph in cell.paragraphs:
        for run in paragraph.runs:
            run.font.color.rgb = colour
        for link in paragraph._p.findall(qn("w:hyperlink")):
            for rpr in link.iter(qn("w:rPr")):
                for old in rpr.findall(qn("w:color")):
                    rpr.remove(old)
                c = OxmlElement("w:color")
                c.set(qn("w:val"), str(colour))
                rpr.append(c)


def side_column(cell: _Cell, v: View, photo: Path | None) -> None:
    side = Flow(cell, small=True)
    if photo:
        picture(side, photo, 36, WD_ALIGN_PARAGRAPH.CENTER)
    for item in v.contact():
        add_link(side.para(), item["text"], item["href"], size=9)
    for key in order_of(v):
        if key == "skills":
            skills(side, v, stacked=True)
        elif key == "languages":
            languages(side, v, as_bullets=False)
        elif key == "education":
            education(side, v)


def labelled_rows(doc: DocumentType, v: View, keys: list[str], width: float, accent: RGBColor) -> None:
    """Europass / Timeline: one borderless table, a row per section: the title on the left, the content on the right."""
    table = doc.add_table(rows=0, cols=2)
    table.autofit = False
    no_borders(table)
    label_w = 38.0
    for key in keys:
        row = table.add_row()
        left, right = row.cells
        cell_setup(left, label_w, margins_mm=(0, 0, 0, 3))
        cell_setup(right, width - label_w, margins_mm=(0, 4, 0, 0))
        before = len(right.paragraphs)
        section(Flow(right), v, key)
        # The section wrote its own Heading 1 first: move its text to the label cell.
        heading = next((pp for pp in right.paragraphs[max(0, before - 1):] if pp.style is not None and pp.style.name == "Heading 1"), None)
        if heading is None:
            row._tr.getparent().remove(row._tr)
            continue
        label = left.paragraphs[0]
        run = label.add_run(heading.text)
        run.bold = True
        run.font.size = Pt(9)
        run.font.color.rgb = accent
        label.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        heading._p.getparent().remove(heading._p)
        if right.paragraphs and not right.paragraphs[0].text and len(right.paragraphs) > 1:
            right.paragraphs[0]._p.getparent().remove(right.paragraphs[0]._p)


def write_view(doc: DocumentType, view: dict[str, Any], layout: str = "ats", photo: Path | None = None, accent: RGBColor = INK, width: float = 174.0, show_cv: bool = True) -> None:
    v = View(view)
    f = Flow(doc)
    if not show_cv:
        return
    order = order_of(v)
    if layout == "technical" and "skills" in order:
        rest = [k for k in order if k != "skills"]
        at = 1 if rest and rest[0] == "summary" else 0
        order = [*rest[:at], "skills", *rest[at:]]

    if layout in ("sidebar", "rightbar", "creative"):
        side_w = 58.0 if layout != "rightbar" else 56.0
        widths = (side_w, width - side_w) if layout != "rightbar" else (width - side_w, side_w)
        a, b = two_cells(doc, widths)
        side_cell, main_cell = (a, b) if layout != "rightbar" else (b, a)
        fill = str(accent) if layout == "creative" else tint_hex(accent, 0.9)
        cell_setup(side_cell, side_w, fill=fill, margins_mm=(4, 4, 4, 4))
        cell_setup(main_cell, width - side_w, margins_mm=(0, 7, 0, 0) if layout != "rightbar" else (0, 0, 0, 7))
        side_column(side_cell, v, photo)
        if layout == "creative":
            recolour(side_cell, RGBColor(0xFF, 0xFF, 0xFF))
        main = Flow(main_cell)
        masthead(main, v, contact=False)
        for key in order:
            if key not in SIDE_SECTIONS:
                section(main, v, key)
        consent(f, v)
        return

    if layout == "banner":
        band_table = doc.add_table(rows=1, cols=1)
        band_table.autofit = False
        no_borders(band_table)
        cell = band_table.rows[0].cells[0]
        cell_setup(cell, width, fill=str(accent), margins_mm=(5, 6, 5, 6))
        band = Flow(cell)
        if photo:
            picture(band, photo, 26, WD_ALIGN_PARAGRAPH.RIGHT)
        masthead(band, v, colour=RGBColor(0xFF, 0xFF, 0xFF))
        recolour(cell, RGBColor(0xFF, 0xFF, 0xFF))
    elif layout in ("elegant", "classic"):
        if photo:
            picture(f, photo, 32, WD_ALIGN_PARAGRAPH.CENTER)
        masthead(f, v, align=WD_ALIGN_PARAGRAPH.CENTER)
    elif layout in ("modern", "executive", "timeline", "europass") and photo:
        left, right = two_cells(doc, (width - 34.0, 34.0))
        cell_setup(left, width - 34.0)
        cell_setup(right, 34.0)
        masthead(Flow(left), v)
        picture(Flow(right), photo, 30, WD_ALIGN_PARAGRAPH.RIGHT)
    else:
        masthead(f, v)

    if layout == "europass":
        labelled_rows(doc, v, order, width, accent)
    elif layout == "timeline":
        for key in order:
            if key in ("experience", "education"):
                labelled_timeline(doc, v, key, width, accent)
            else:
                section(f, v, key)
    else:
        for key in order:
            section(f, v, key)
    consent(f, v)


def labelled_timeline(doc: DocumentType, v: View, key: str, width: float, accent: RGBColor) -> None:
    """Timeline: the section title, then a borderless table: dates on the left, the entry on the right."""
    items = v.items("experience", "heading") if key == "experience" else v.items("education", "institution")
    if not items:
        return
    Flow(doc).para(v.title(key), style="Heading 1")
    table = doc.add_table(rows=0, cols=2)
    table.autofit = False
    no_borders(table)
    for e in items:
        left, right = table.add_row().cells
        cell_setup(left, 30.0, margins_mm=(0, 0, 0, 3))
        cell_setup(right, width - 30.0, margins_mm=(0, 3, 0, 0))
        dates = left.paragraphs[0].add_run(text_of(e.get("dates")))
        dates.bold, dates.font.size, dates.font.color.rgb = True, Pt(8.8), accent
        left.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.RIGHT
        r = Flow(right)
        r.para(text_of(e.get("heading")) or text_of(e.get("institution")), style="Heading 2")
        meta_line(r, " · ".join(x for x in (text_of(e.get("place")), text_of(e.get("note")), text_of(e.get("detail"))) if x))
        bullets(r, strings(e.get("bullets")))


def project_pages(doc: DocumentType, view: dict[str, Any], accent: RGBColor, first_break: bool) -> None:
    """Showcase pages: one page per project (name, link, lead, story, highlights, then role / outcome / technology)."""
    pages = [pg for pg in list_of(view.get("pages")) if isinstance(pg, dict) and text_of(pg.get("name"))]
    titles = view.get("pageTitles") if isinstance(view.get("pageTitles"), dict) else {}
    label = lambda key, fallback: text_of(titles.get(key)) or fallback  # noqa: E731
    f = Flow(doc)
    for i, pg in enumerate(pages):
        if first_break or i:
            doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
        kicker = f.para()
        run = kicker.add_run(f"{label('heading', 'Project')}{' · ' + text_of(view.get('name')) if text_of(view.get('name')) else ''}".upper())
        run.font.size, run.font.color.rgb = Pt(8.5), accent
        f.para(text_of(pg.get("name")), style="Title")
        if text_of(pg.get("urlText")):
            add_link(f.para(), text_of(pg.get("urlText")), text_of(pg.get("href")), GREY, 9.5)
        if text_of(pg.get("summary")):
            lead = f.para(text_of(pg.get("summary")))
            for r in lead.runs:
                r.font.size = Pt(11.5)
        for para in strings(pg.get("story")):
            f.para(para)
        if strings(pg.get("bullets")):
            f.para(label("highlights", "Highlights"), style="Heading 1")
            bullets(f, strings(pg.get("bullets")))
        for key, fallback in (("role", "My role"), ("outcome", "Outcome")):
            if text_of(pg.get(key)):
                f.para(label(key, fallback), style="Heading 1")
                f.para(text_of(pg.get(key)))
        if strings(pg.get("tech")):
            f.para(label("tech", "Technology"), style="Heading 1")
            f.para(", ".join(strings(pg.get("tech"))))


def scrub(value: Any) -> Any:
    """Strip U+00A0 from every string in the view, whatever the caller sent."""
    if isinstance(value, str):
        return plain(value)
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items()}
    return value


def render(req: dict[str, Any]) -> dict[str, Any]:
    view = req.get("view")
    if not isinstance(view, dict):
        raise ToolError("view: missing or not an object.")
    lang = view.get("lang")
    if lang not in LANG_TAG:
        raise ToolError("view.lang: expected 'pl' or 'en'.")
    theme = req.get("theme", "ats")
    if theme not in LAYOUTS:
        raise ToolError(f"theme: expected one of {', '.join(LAYOUTS)}.")
    look = req.get("look") if isinstance(req.get("look"), dict) else {}
    accent = hex_rgb(text_of(look.get("accent")) or DEFAULT_ACCENT.get(theme, "#1f5f8b"))
    pair = text_of(look.get("fonts")) or ("mixed" if theme == "elegant" else "inter")
    page_mode = text_of(req.get("page_mode")) or "cv"
    if page_mode not in ("cv", "cv+pages", "pages"):
        raise ToolError("page_mode: expected cv, cv+pages or pages.")
    shape = req.get("photo_shape", "round")
    if shape not in ("round", "square"):
        raise ToolError("photo_shape: expected 'round' or 'square'.")
    view = scrub(view)
    if page_mode == "pages" and not list_of(view.get("pages")):
        raise ToolError("view: no project has a showcase page.")
    if page_mode != "pages" and not (text_of(view.get("name")) or text_of(view.get("summary")) or list_of(view.get("experience"))):
        raise ToolError("view: nothing to print.")

    filename = Path(text_of(req.get("filename")) or "cv.docx").name
    if not filename.lower().endswith(".docx"):
        filename += ".docx"
    out_dir = Path(req.get("out_dir") or ".")
    out_dir.mkdir(parents=True, exist_ok=True)

    photo: Path | None = None
    if req.get("photo") and theme in PHOTO_LAYOUTS:
        photo = Path(str(req["photo"]))
        if not photo.is_file():
            raise ToolError("photo: file not found.")
        if shape == "round":
            photo = round_photo(photo, out_dir)

    doc = Document()
    head_font, body_font = fonts_for(pair)
    if theme == "technical":
        head_font = MONO
    paper = text_of(look.get("paper")) or "a4"
    compact = text_of(look.get("density")) == "compact" or theme == "compact"
    style_setup(doc, lang, accent if theme != "ats" else INK, head_font, body_font, paper, compact)
    width = PAPER.get(paper, PAPER["a4"])[0] - (28 if compact else 36)
    show_cv = page_mode != "pages"
    write_view(doc, view, theme, photo, accent, width, show_cv)
    if page_mode != "cv":
        project_pages(doc, view, accent, first_break=show_cv)
    name = text_of(view.get("name"))
    doc.core_properties.title = f"{name} - CV" if name else "CV"
    doc.core_properties.author = name
    doc.core_properties.language = LANG_TAG[lang]
    target = out_dir / filename
    doc.save(target)
    return {"ok": True, "file": filename, "mime": DOCX_MIME, "bytes": target.stat().st_size}


def main() -> int:
    if len(sys.argv) < 3:
        sys.stderr.write("usage: cv_docx.py request.json response.json\n")
        return 2
    request_path, response_path = sys.argv[1], sys.argv[2]
    try:
        req = json.loads(Path(request_path).read_text("utf-8"))
        if not isinstance(req, dict):
            raise ToolError("request: expected a JSON object.")
        result = render(req)
    except ToolError as exc:
        result = {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 - surface anything as a clean message
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        sys.stderr.write(repr(exc) + "\n")
    Path(response_path).write_text(json.dumps(result, ensure_ascii=False), "utf-8")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
