#!/usr/bin/env python3
"""CV -> DOCX (python-docx). Usage: cv_docx.py request.json response.json

Request  {"view": <CvView JSON from src/lib/cv/render/view.ts>, "theme": "ats|modern|sidebar|elegant",
          "photo": "/abs/photo.jpg"|null, "photo_shape": "round|square", "out_dir": "/abs/scratch", "filename": "cv.docx"}
Response {"ok": true, "file": "cv.docx", "mime": "...wordprocessingml.document", "bytes": N} | {"ok": false, "error": "..."}

No profile logic lives here: the TypeScript side already decided what prints (titles, dates, empty-field skipping,
consent rule), this script only lays the view out. Real Word styles everywhere (Title, Subtitle, Heading 1/2, List Bullet)
and plain spaces (no U+00A0). ATS (and Modern/Elegant without a photo) = one linear flow: no tables, text boxes, columns
or images. The photo layouts add one borderless layout table at most (Sidebar: two columns; Modern: name | photo).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from docx import Document
from docx.document import Document as DocumentType
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Mm, Pt, RGBColor
from docx.table import Table, _Cell
from docx.text.paragraph import Paragraph

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
FONT = "Calibri"
INK = RGBColor(0x11, 0x11, 0x11)
GREY = RGBColor(0x44, 0x44, 0x44)
ACCENT = {"ats": INK, "modern": RGBColor(0x1F, 0x5F, 0x8B), "sidebar": RGBColor(0x22, 0x57, 0x7A), "elegant": RGBColor(0x7A, 0x5C, 0x35)}
PHOTO_LAYOUTS = ("modern", "sidebar", "elegant")  # src/lib/cv/render/layout.ts: ATS never prints a photo
SERIF = "Georgia"
SIDEBAR_FILL = "EDF2F7"
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


def style_setup(doc: DocumentType, lang: str, accent: RGBColor, heading_font: str = FONT) -> None:
    section = doc.sections[0]
    section.page_width, section.page_height = Mm(210), Mm(297)
    section.left_margin = section.right_margin = Mm(18)
    section.top_margin = section.bottom_margin = Mm(16)

    # name: (size pt, bold, colour, space before pt, space after pt)
    spec = {
        "Normal": (10, False, INK, 0, 3),
        "Title": (22, True, INK, 0, 2),
        "Subtitle": (11.5, False, accent, 0, 4),
        "Heading 1": (11, True, accent, 12, 4),
        "Heading 2": (10.5, True, INK, 6, 0),
        "List Bullet": (10, False, INK, 0, 2),
    }
    for name, (size, bold, colour, before, after) in spec.items():
        style = doc.styles[name]
        family = heading_font if name in ("Title", "Subtitle", "Heading 1") else FONT
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

    def contact(self) -> list[str]:
        return [t for t in (text_of(c.get("text")) for c in list_of(self.v.get("contact")) if isinstance(c, dict)) if t]

    def items(self, key: str, required: str) -> list[dict[str, Any]]:
        return [e for e in list_of(self.v.get(key)) if isinstance(e, dict) and text_of(e.get(required))]


def masthead(f: Flow, v: View, align: WD_ALIGN_PARAGRAPH | None = None, contact: bool = True) -> None:
    for text, style in ((v.get("name"), "Title"), (v.get("headline"), "Subtitle")):
        if text:
            f.para(text, style=style).alignment = align
    if contact and v.contact():
        f.para("  |  ".join(v.contact())).alignment = align


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
        meta_line(f, text_of(p.get("urlText")), keep_with_next=True)
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
        head = " · ".join(p for p in (text_of(item.get("title")), text_of(item.get("urlText"))) if p)
        if head:
            f.para(head, style="Heading 2")
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


def write_view(doc: DocumentType, view: dict[str, Any], layout: str = "ats", photo: Path | None = None) -> None:
    """ATS (and Modern/Elegant without a photo): one linear flow, no tables. Photo layouts add exactly one layout table."""
    v = View(view)
    f = Flow(doc)
    text_width = 174.0
    if layout == "sidebar":
        left, right = two_cells(doc, (58.0, text_width - 58.0))
        cell_setup(left, 58.0, fill=SIDEBAR_FILL, margins_mm=(4, 4, 4, 4))
        cell_setup(right, text_width - 58.0, margins_mm=(0, 7, 0, 0))
        side, main = Flow(left, small=True), Flow(right)
        if photo:
            picture(side, photo, 36, WD_ALIGN_PARAGRAPH.CENTER)
        for item in v.contact():
            side.para(item)
        for key in order_of(v):
            if key == "skills":
                skills(side, v, stacked=True)
            elif key == "languages":
                languages(side, v, as_bullets=False)
            elif key == "education":
                education(side, v)
        masthead(main, v, contact=False)
        for key in order_of(v):
            if key not in SIDE_SECTIONS:
                section(main, v, key)
        consent(f, v)
        return
    if layout == "elegant":
        if photo:
            picture(f, photo, 32, WD_ALIGN_PARAGRAPH.CENTER)
        masthead(f, v, align=WD_ALIGN_PARAGRAPH.CENTER)
    elif layout == "modern" and photo:
        left, right = two_cells(doc, (text_width - 34.0, 34.0))
        cell_setup(left, text_width - 34.0)
        cell_setup(right, 34.0)
        masthead(Flow(left), v)
        picture(Flow(right), photo, 30, WD_ALIGN_PARAGRAPH.RIGHT)
    else:
        masthead(f, v)
    body(f, v)
    consent(f, v)


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
    if theme not in ACCENT:
        raise ToolError(f"theme: expected one of {', '.join(ACCENT)}.")
    shape = req.get("photo_shape", "round")
    if shape not in ("round", "square"):
        raise ToolError("photo_shape: expected 'round' or 'square'.")
    view = scrub(view)
    if not (text_of(view.get("name")) or text_of(view.get("summary")) or list_of(view.get("experience"))):
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
    style_setup(doc, lang, ACCENT[theme], SERIF if theme == "elegant" else FONT)
    write_view(doc, view, theme, photo)
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
