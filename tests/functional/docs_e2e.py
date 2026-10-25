"""Functional e2e for the document/text tools: pdf (tools + editor/OCR), file-compressor,
characters, batch-rename, placeholder-text, markdown, diff.

Real UI, real fixtures, assertions on actual output (downloaded bytes are parsed).
No model/network use. Needs python `playwright` (system python3) and the venv python
(pypdf, reportlab, Pillow) for fixtures + verification.

Usage: python3 tests/functional/docs_e2e.py [base_url]
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
VENV_PY = os.path.abspath(str(ROOT / "../samurai-knife-py/venv/bin/python"))
BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3210").rstrip("/")
TMP = Path(tempfile.mkdtemp(prefix="docs-e2e-"))
failures: list[str] = []
START = time.time()


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + (f" | {detail}" if detail else ""), flush=True)
    if not ok:
        failures.append(name)


def pyv(code: str, *args: str) -> str:
    r = subprocess.run([VENV_PY, "-c", code, *args], capture_output=True, text=True, timeout=120)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout


# ---------------------------------------------------------------- fixtures
MAKE_PDF = r'''
import sys
from reportlab.pdfgen import canvas
out, tag, pages = sys.argv[1], sys.argv[2], int(sys.argv[3])
c = canvas.Canvas(out)
c.setTitle(tag + " Title"); c.setAuthor(tag + " Author")
for i in range(1, pages + 1):
    c.drawString(100, 700, f"{tag} page {i}")
    c.showPage()
c.save()
'''
PDF_INFO = r'''
import sys, json
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
if r.is_encrypted:
    r.decrypt(sys.argv[2] if len(sys.argv) > 2 else "")
pages = []
for p in r.pages:
    pages.append({"text": (p.extract_text() or "").strip(), "rot": int(p.get("/Rotate", 0) or 0)})
print(json.dumps({"n": len(r.pages), "pages": pages, "enc": r.is_encrypted}))
'''
PDF_ENC = r'''
import sys
from pypdf import PdfReader
print(PdfReader(sys.argv[1]).is_encrypted)
'''
MAKE_SCAN = r'''
import sys
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
out = sys.argv[1]
img = Image.new("RGB", (1200, 400), "white")
d = ImageDraw.Draw(img)
font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 120)
d.text((60, 120), "HELLO OCR", fill="black", font=font)
img.save(out + ".png")
c = canvas.Canvas(out, pagesize=(600, 200))
c.drawImage(out + ".png", 0, 0, 600, 200)
c.showPage(); c.save()
'''
MAKE_SIDEWAYS_JPEG = r'''
import sys
from PIL import Image
img = Image.open(sys.argv[1]).convert("RGB").transpose(Image.Transpose.ROTATE_90)  # stored sideways (90 deg CCW)
exif = Image.Exif()
exif[0x0112] = 6  # Orientation: rotate 90 CW to display upright
img.save(sys.argv[2], "JPEG", quality=92, exif=exif.tobytes())
'''
PDF_IMAGES = r'''
import sys, json
from pypdf import PdfReader
out = []
for p in PdfReader(sys.argv[1]).pages:
    xo = p["/Resources"].get("/XObject", {})
    out.append({"images": len(xo), "w": float(p.mediabox.width), "h": float(p.mediabox.height)})
print(json.dumps(out))
'''


def word_recall(truth: str, text: str) -> float:
    """Share of the truth's words that the OCR text contains (case and punctuation ignored)."""
    norm = lambda t: re.findall(r"[a-z0-9$%.,-]+", t.lower())  # noqa: E731
    words = [w.strip(".,") for w in norm(truth)]
    seen = {w.strip(".,") for w in norm(text)}
    return sum(1 for w in words if w in seen) / max(1, len(words))


MAKE_PNG = r'''
import sys
from PIL import Image
Image.new("RGB", (40, 30), (200, 20, 20)).save(sys.argv[1])
'''


def mkpdf(name, tag, pages) -> Path:
    p = TMP / name
    pyv(MAKE_PDF, str(p), tag, str(pages))
    return p


def pdfinfo(path, pw="") -> dict:
    return json.loads(pyv(PDF_INFO, str(path), pw))


def save_dl(dl, name=None) -> Path:
    d = TMP / f"dl{int(time.time()*1000)}"
    d.mkdir()
    p = d / (name or dl.suggested_filename)
    dl.save_as(str(p))
    return p


# ---------------------------------------------------------------- harness
INIT = """
window.__copied = null;
(function(){
  const rec = (t) => { window.__copied = t; return Promise.resolve(); };
  try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: rec, readText: () => Promise.resolve(window.__copied) }, configurable: true }); } catch (e) {}
})();
"""


class Ctx:
    def __init__(self, browser, width=1280, height=900):
        self.ctx = browser.new_context(viewport={"width": width, "height": height}, accept_downloads=True)
        self.ctx.add_init_script(INIT)
        self.errors: list[str] = []

    def page(self):
        pg = self.ctx.new_page()
        pg.on("console", lambda m: self.errors.append(f"console: {m.text}") if m.type == "error" else None)
        pg.on("pageerror", lambda e: self.errors.append(f"pageerror: {e}"))
        return pg


def goto(pg, slug, tab=None):
    pg.goto(f"{BASE}/tools/{slug}" + (f"?tab={tab}" if tab else ""), wait_until="domcontentloaded")
    pg.wait_for_load_state("networkidle")


def overflow(pg) -> bool:
    return pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")


def copied(pg, click):
    pg.evaluate("window.__copied = null")
    click()
    pg.wait_for_function("window.__copied !== null", timeout=5000)
    return pg.evaluate("window.__copied")


def run_section(name):
    print(f"--- {name}", flush=True)


# ================================================================ PDF tools
def pdf_tools(browser):
    run_section("pdf > tools")
    c = Ctx(browser)
    A = mkpdf("alpha.pdf", "ALPHA", 3)
    B = mkpdf("bravo.pdf", "BRAVO", 2)
    bad = TMP / "bad.pdf"
    bad.write_bytes(b"%PDF-1.4\nthis is not a real pdf\n%%EOF\n")
    notpdf = TMP / "notes.txt"
    notpdf.write_text("hello")
    # hand-made minimal PDF with a correct xref (as an agent/hand would write one)
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        None,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    stream = b"BT /F1 24 Tf 20 100 Td (Handmade hello) Tj ET"
    objs[3] = b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream"
    body = b"%PDF-1.4\n"
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(body))
        body += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(body)
    body += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for o in offs:
        body += b"%010d 00000 n \n" % o
    body += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    hand = TMP / "hand.pdf"
    hand.write_bytes(body)

    pg = c.page()
    goto(pg, "pdf", "tools")

    def act_btn(label):
        return pg.get_by_role("button", name=label, exact=True).first

    def run_btn(label):
        return pg.get_by_role("button", name=label, exact=True).last

    def upload(*paths):
        pg.locator("input[type=file]").first.set_input_files([str(p) for p in paths])

    def clear():
        if pg.get_by_role("button", name="Clear", exact=True).count():
            pg.get_by_role("button", name="Clear", exact=True).click()

    def download_run(label, run_label=None):
        with pg.expect_download(timeout=60000) as d:
            run_btn(run_label or label).click()
        return save_dl(d.value)

    # non-PDF rejected
    upload(notpdf)
    check("pdf: non-PDF rejected with message", pg.get_by_text("not PDF files").count() > 0)

    # Inspect
    upload(A)
    act_btn("Inspect").click()
    run_btn("Inspect").click()
    pg.get_by_text("3 pages").first.wait_for(timeout=30000)
    body = pg.inner_text("body")
    check("pdf inspect: pages/title/author/size shown",
          "3 pages" in body and "ALPHA Title" in body and "ALPHA Author" in body and "595.3" in body, "")

    # Extract text (valid reportlab PDF)
    act_btn("Extract text").click()
    run_btn("Extract text").click()
    pre = pg.locator("pre").filter(has_text="alpha.pdf")
    pre.first.wait_for(timeout=30000)
    txt = pre.first.inner_text()
    check("pdf text: all pages extracted", all(f"ALPHA page {i}" in txt for i in (1, 2, 3)), txt[:120])
    got = copied(pg, lambda: pg.get_by_role("button", name="Copy", exact=True).first.click())
    check("pdf text: Copy copies extracted text", "ALPHA page 2" in (got or ""))
    with pg.expect_download() as d:
        pg.get_by_role("button", name="Save .txt").click()
    p = save_dl(d.value)
    check("pdf text: Save .txt content", "ALPHA page 3" in p.read_text())
    # page subset
    pg.get_by_placeholder("1-3,7").fill("2")
    run_btn("Extract text").click()
    pg.wait_for_function("document.body.innerText.includes('ALPHA page 2') && !document.body.innerText.includes('ALPHA page 3')", timeout=30000)
    check("pdf text: page range 2 only", True)
    pg.get_by_placeholder("1-3,7").fill("")

    # out-of-range page -> clear error
    pg.get_by_placeholder("1-3,7").fill("9")
    run_btn("Extract text").click()
    pg.locator("p.text-danger, p[class*=text-danger]").first.wait_for(timeout=30000)
    check("pdf text: out-of-range page gives clear error", len(pg.locator("p[class*=text-danger]").first.inner_text()) > 5,
          pg.locator("p[class*=text-danger]").first.inner_text())
    pg.get_by_placeholder("1-3,7").fill("")

    # hand-made PDF text
    clear(); upload(hand)
    run_btn("Extract text").click()
    pg.locator("pre").filter(has_text="Handmade hello").first.wait_for(timeout=30000)
    check("pdf text: hand-made PDF shows output", True)

    # bad PDF -> clear error, not silence
    clear(); upload(bad)
    run_btn("Extract text").click()
    err = pg.locator("p[class*=text-danger]")
    err.first.wait_for(timeout=30000)
    check("pdf text: corrupt PDF shows an error", len(err.first.inner_text()) > 5, err.first.inner_text())
    act_btn("Inspect").click(); run_btn("Inspect").click()
    pg.wait_for_timeout(1500)
    check("pdf inspect: corrupt PDF shows an error", pg.locator("p[class*=text-danger]").count() > 0)

    # Cut pages
    clear(); upload(A)
    act_btn("Cut pages").click()
    pg.get_by_placeholder("1-3,7").fill("1,3")
    out = download_run("Cut pages")
    i = pdfinfo(out)
    check("pdf cut: pages 1,3 kept", i["n"] == 2 and "ALPHA page 1" in i["pages"][0]["text"] and "ALPHA page 3" in i["pages"][1]["text"], str(i))
    pg.get_by_placeholder("1-3,7").fill("")

    # Rotate
    act_btn("Rotate").click()
    pg.get_by_placeholder("1-3,7").fill("2")
    pg.get_by_label("Angle").select_option("180")
    out = download_run("Rotate")
    i = pdfinfo(out)
    check("pdf rotate: page 2 rotated 180 only", i["n"] == 3 and [p["rot"] for p in i["pages"]] == [0, 180, 0], str(i))
    pg.get_by_placeholder("1-3,7").fill("")

    # Split
    act_btn("Split").click()
    pg.get_by_label("Pages per file").fill("2")
    out = download_run("Split")
    zf = zipfile.ZipFile(out)
    names = sorted(zf.namelist())
    infos = [pdfinfo_bytes(zf.read(n)) for n in names]
    check("pdf split: zip with 2 parts (2+1 pages)", len(names) == 2 and [x["n"] for x in infos] == [2, 1], str(names))

    # Merge
    clear(); upload(A, B)
    act_btn("Merge").click()
    out = download_run("Merge", "Merge & download")
    i = pdfinfo(out)
    check("pdf merge: 5 pages in order", i["n"] == 5 and "ALPHA page 1" in i["pages"][0]["text"] and "BRAVO page 2" in i["pages"][4]["text"], str(i["n"]))

    # Reorder
    clear(); upload(A)
    act_btn("Reorder pages").click()
    pg.get_by_placeholder("1-3,7").fill("3,1,2")
    out = download_run("Reorder pages")
    i = pdfinfo(out)
    check("pdf reorder: 3,1,2", [p["text"].split()[-1] for p in i["pages"]] == ["3", "1", "2"], str(i))
    pg.get_by_placeholder("1-3,7").fill("1,1,2")
    run_btn("Reorder pages").click()
    pg.locator("p[class*=text-danger]").first.wait_for(timeout=30000)
    check("pdf reorder: duplicate page list rejected with error", True, pg.locator("p[class*=text-danger]").first.inner_text())
    pg.get_by_placeholder("1-3,7").fill("")

    # Compress
    act_btn("Compress").click()
    out = download_run("Compress")
    i = pdfinfo(out)
    check("pdf compress: valid 3-page output", i["n"] == 3 and "ALPHA page 2" in i["pages"][1]["text"])
    check("pdf compress: size summary shown", pg.get_by_text("smaller").count() + pg.get_by_text("larger").count() > 0)

    # Page numbers
    act_btn("Page numbers").click()
    pg.get_by_label("First page number").fill("7")
    out = download_run("Page numbers")
    i = pdfinfo(out)
    check("pdf number: stamped 7,8,9", [p["text"].split()[-1] for p in i["pages"]] == ["7", "8", "9"], str([p["text"] for p in i["pages"]]))

    # Watermark
    act_btn("Watermark").click()
    pg.get_by_label("Watermark text").fill("SECRETMARK")
    out = download_run("Watermark")
    i = pdfinfo(out)
    check("pdf watermark: text on every page", i["n"] == 3 and all("SECRETMARK" in p["text"].replace("\n", "") or "S E C" in p["text"] or "SECRETMARK" in "".join(p["text"].split()) for p in i["pages"]), str(i["pages"][0]))

    # Protect + Unlock
    act_btn("Protect").click()
    pg.get_by_label("PDF password").fill("short")
    check("pdf protect: <8 chars disables button", run_btn("Protect").is_disabled())
    pg.get_by_label("PDF password").fill("correct-horse-9")
    prot = download_run("Protect")
    check("pdf protect: output encrypted & decryptable", pyv(PDF_ENC, str(prot)).strip() == "True"
          and pdfinfo(prot, "correct-horse-9")["n"] == 3)
    clear(); upload(prot)
    act_btn("Unlock").click()
    pg.get_by_label("PDF password").fill("wrong-password")
    run_btn("Unlock").click()
    pg.locator("p[class*=text-danger]").first.wait_for(timeout=30000)
    check("pdf unlock: wrong password gives error", True, pg.locator("p[class*=text-danger]").first.inner_text())
    pg.get_by_label("PDF password").fill("correct-horse-9")
    out = download_run("Unlock")
    i = pdfinfo(out)
    check("pdf unlock: unprotected copy readable without password", pyv(PDF_ENC, str(out)).strip() == "False" and i["n"] == 3 and "ALPHA page 1" in i["pages"][0]["text"])

    errs = [e for e in c.errors if "400 (Bad Request)" not in e]  # intentional error-path requests
    check("pdf tools: no console errors", not errs, "; ".join(errs[:3]))
    c.ctx.close()


def pdfinfo_bytes(b: bytes) -> dict:
    p = TMP / "tmp-bytes.pdf"
    p.write_bytes(b)
    return pdfinfo(p)


# ================================================================ PDF editor / OCR
def pdf_editor(browser):
    run_section("pdf > editor & OCR")
    c = Ctx(browser, height=1900)
    A = mkpdf("ed.pdf", "EDIT", 3)
    scan = TMP / "scan.pdf"
    pyv(MAKE_SCAN, str(scan))
    png = TMP / "mark.png"
    pyv(MAKE_PNG, str(png))
    pg = c.page()
    goto(pg, "pdf", "editor")
    check("editor: empty state", pg.get_by_text("Open a PDF to start editing").count() == 1)
    notes = TMP / "not-a-pdf.txt"
    notes.write_text("plain text, neither a PDF nor an image")
    pg.locator("input[type=file]").first.set_input_files(str(notes))
    pg.get_by_text("Choose a PDF, or one or more images").wait_for(timeout=5000)
    check("editor: non-PDF rejected", True)
    pg.locator("input[type=file]").first.set_input_files(str(A))
    pg.get_by_text("3 pages loaded").wait_for(timeout=30000)
    pg.wait_for_selector("svg[aria-label^='PDF page 1']", timeout=30000)
    check("editor: opens PDF, 3 thumbnails", pg.get_by_text("Pages · 3").count() == 1 and pg.locator("button[draggable=true]").count() == 3)
    nonblank = pg.evaluate("""() => { const cv = document.querySelector('canvas.block'); const d = cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data; for (let i=0;i<d.length;i+=4) if (d[i]<200) return true; return false; }""")
    check("editor: page canvas rendered with content", nonblank)

    svg = lambda: pg.locator("svg[aria-label^='PDF page']")

    def box():
        svg().scroll_into_view_if_needed()
        return svg().bounding_box()

    def tool(label):
        pg.get_by_role("button", name=label, exact=True).click()

    def click_at(fx, fy):
        b = box()
        pg.mouse.click(b["x"] + b["width"] * fx, b["y"] + b["height"] * fy)

    def drag(f1, f2):
        b = box()
        pg.mouse.move(b["x"] + b["width"] * f1[0], b["y"] + b["height"] * f1[1])
        pg.mouse.down()
        steps = 6
        for s in range(1, steps + 1):
            pg.mouse.move(b["x"] + b["width"] * (f1[0] + (f2[0] - f1[0]) * s / steps),
                          b["y"] + b["height"] * (f1[1] + (f2[1] - f1[1]) * s / steps))
        pg.mouse.up()

    # text mark
    tool("Text")
    pg.get_by_label("Text", exact=True).fill("OVERLAYTEXT")
    click_at(0.3, 0.5)
    pg.get_by_text("Mark added").wait_for(timeout=5000)
    check("editor: text mark added to SVG", svg().locator("text", has_text="OVERLAYTEXT").count() == 1)
    # edit selected text
    pg.get_by_label("Text", exact=True).fill("CHANGEDTEXT")
    pg.get_by_role("button", name="Update selected text").click()
    check("editor: update selected text", svg().locator("text", has_text="CHANGEDTEXT").count() == 1)
    # copy / paste mark
    pg.get_by_role("button", name="Copy mark").click()
    pg.get_by_role("button", name="Paste mark").click()
    check("editor: copy+paste duplicates mark", svg().locator("text", has_text="CHANGEDTEXT").count() == 2)
    pg.get_by_role("button", name="Delete mark").click()
    check("editor: delete mark", svg().locator("text", has_text="CHANGEDTEXT").count() == 1)
    # undo / redo
    pg.get_by_role("button", name="Undo", exact=True).click()
    check("editor: undo restores deleted mark", svg().locator("text", has_text="CHANGEDTEXT").count() == 2)
    pg.get_by_role("button", name="Redo", exact=True).click()
    check("editor: redo re-applies delete", svg().locator("text", has_text="CHANGEDTEXT").count() == 1)
    # keyboard: ctrl+z via focus in editor
    svg().focus()
    pg.keyboard.press("Control+z")
    check("editor: Ctrl+Z shortcut", svg().locator("text", has_text="CHANGEDTEXT").count() == 2)
    pg.keyboard.press("Control+Shift+z")
    # rectangle + highlight + draw + image
    tool("Rectangle")
    drag((0.1, 0.1), (0.4, 0.2))
    tool("Highlight")
    drag((0.1, 0.3), (0.5, 0.35))
    tool("Draw / sign")
    drag((0.5, 0.6), (0.8, 0.8))
    check("editor: rect/highlight/draw marks present",
          svg().locator("rect[stroke]").count() >= 2 and svg().locator("path").count() == 1)
    tool("Place image")
    pg.locator("input[type=file][accept='image/png,image/jpeg']").set_input_files(str(png))
    pg.get_by_text("Click on the page to place the image").wait_for(timeout=5000)
    click_at(0.6, 0.15)
    check("editor: image placed", svg().locator("image").count() == 1)
    # select + move mark
    tool("Select")
    before = svg().locator("text", has_text="CHANGEDTEXT").first.bounding_box()
    b0 = before
    pg.mouse.move(b0["x"] + 5, b0["y"] + b0["height"] / 2)
    pg.mouse.down()
    pg.mouse.move(b0["x"] + 45, b0["y"] + b0["height"] / 2 + 30, steps=5)
    pg.mouse.up()
    after = svg().locator("text", has_text="CHANGEDTEXT").first.bounding_box()
    check("editor: drag moves mark", abs(after["x"] - before["x"]) > 20 and abs(after["y"] - before["y"]) > 15, f"{before} -> {after}")

    # page ops: rotate page 1, go to page 2, delete page 3 via reorder etc.
    pg.get_by_role("button", name="↻ Rotate").click()
    check("editor: rotate shows Rotated 90", pg.get_by_text("Rotated 90°").count() == 1)
    # zoom
    z0 = pg.get_by_text(re.compile(r"^\d+%$")).first.inner_text()
    pg.get_by_role("button", name="Zoom in").click()
    z1 = pg.get_by_text(re.compile(r"^\d+%$")).first.inner_text()
    check("editor: zoom in changes zoom", z0 != z1, f"{z0}->{z1}")
    pg.get_by_role("button", name="Fit width").click()
    # page 2: Page Down + thumbnail click
    pg.locator("button[draggable=true]").nth(2).click()
    check("editor: thumbnail selects page 3", pg.get_by_text("3 / 3").count() == 1)
    pg.get_by_role("button", name="Delete page").click()
    check("editor: delete page leaves 2", pg.get_by_text("Pages · 2").count() == 1)
    # reorder via drag-and-drop thumbnails (page1 <-> page2)
    th = pg.locator("button[draggable=true]")
    th.nth(0).drag_to(th.nth(1))
    first_label = th.nth(0).inner_text()
    check("editor: drag reorder puts page 2 first", "Page 2" in first_label, first_label)

    with pg.expect_download(timeout=60000) as d:
        pg.get_by_role("button", name="Export edited PDF").click()
    out = save_dl(d.value)
    check("editor: export filename", out.name.endswith("ed-edited.pdf"), out.name)
    info = pdfinfo(out)
    texts = [p["text"] for p in info["pages"]]
    check("editor: exported 2 pages, reordered (page2 first, page1 second)",
          info["n"] == 2 and "EDIT page 2" in texts[0] and "EDIT page 1" in texts[1], str(texts))
    check("editor: overlay text baked into page 1 output", "CHANGEDTEXT" in texts[1], texts[1])
    check("editor: page 1 rotation 90 exported", info["pages"][1]["rot"] == 90 and info["pages"][0]["rot"] == 0, str(info["pages"]))
    cs = pyv(r'''
import sys
from pypdf import PdfReader
p = PdfReader(sys.argv[1]).pages[1]
c = p.get_contents().get_data().decode("latin1")
xo = p["/Resources"].get("/XObject", {})
t = c.split()
print(t.count("h"), len(xo), t.count("l"))
''', str(out)).split()
    check("editor: 2 closed rect paths, image XObject and freehand segments in export", int(cs[0]) >= 2 and int(cs[1]) >= 1 and int(cs[2]) >= 10, str(cs))

    # OCR
    pg.locator("input[type=file]").first.set_input_files(str(scan))
    pg.get_by_text("1 page loaded").wait_for(timeout=30000)
    pg.get_by_role("button", name="Current page").click()
    ta = pg.locator("textarea[readonly]")
    try:
        ta.first.wait_for(timeout=100000)
        otxt = ta.first.input_value()
        check("ocr: current page recognizes text", "HELLO" in otxt.upper() and "OCR" in otxt.upper(), otxt[:80])
        with pg.expect_download() as d:
            pg.get_by_role("button", name="Download OCR text").click()
        check("ocr: download OCR text", "HELLO" in save_dl(d.value).read_text().upper())
        pg.get_by_role("button", name="All pages").click()
        pg.wait_for_function("document.body.innerText.includes('OCR finished for 1 page')", timeout=100000)
        check("ocr: all pages run completes", True)
    except Exception as exc:  # noqa: BLE001
        err = pg.locator("p[class*=text-danger]").all_inner_texts()
        check("ocr: current page recognizes text", False, f"{exc!s:.100} | ui error: {err}")

    # Images as pages: a scan PNG + the same scan as a sideways JPEG with EXIF orientation 6 -> a 2-page document,
    # OCR at the image's own resolution (truth.txt is the oracle), Export edited PDF = images to one PDF.
    fx = TMP / "ocrfx"
    subprocess.run([sys.executable, str(ROOT / "tests" / "ocr_fixtures.py"), str(fx)], check=True, capture_output=True)
    sideways = TMP / "sideways.jpg"
    pyv(MAKE_SIDEWAYS_JPEG, str(fx / "scan.png"), str(sideways))
    truth = (fx / "truth.txt").read_text()
    pg.locator("input[type=file]").first.set_input_files([str(fx / "scan.png"), str(sideways)])
    try:
        pg.get_by_text("2 pages loaded").wait_for(timeout=60000)
        check("images: PNG + JPEG open as a 2-page document", pg.get_by_text("Built from 2 images").count() == 1)
        pg.get_by_role("button", name="Current page").click()
        pg.wait_for_function("document.body.innerText.includes('OCR finished for 1 page')", timeout=150000)
        page1 = ta.first.input_value()
        acc1 = word_recall(truth, page1)
        check("images: OCR of the PNG scan reads the paragraph", acc1 >= 0.85, f"recall {acc1:.2f}: {page1[:80]!r}")
        pg.locator("button[draggable=true]").nth(1).click()
        pg.get_by_role("button", name="Current page").click()
        pg.wait_for_function("() => [...document.querySelectorAll('textarea[readonly]')].some(t => t.value.includes('--- Page 2 ---')) && document.body.innerText.includes('OCR finished for 1 page')", timeout=150000)
        page2 = ta.first.input_value()
        acc2 = word_recall(truth, page2)
        check("images: EXIF orientation applied (sideways JPEG reads upright)", acc2 >= 0.85, f"recall {acc2:.2f}: {page2[:80]!r}")
        with pg.expect_download() as d:
            pg.get_by_role("button", name="Export edited PDF").click()
        out = save_dl(d.value)
        shape = json.loads(pyv(PDF_IMAGES, str(out)))
        check("images: export is one PDF, a full-page image per page, upright portrait pages",
              out.name == "scan-edited.pdf" and len(shape) == 2 and all(p["images"] == 1 and p["h"] > p["w"] for p in shape), f"{out.name} {shape}")
    except Exception as exc:  # noqa: BLE001
        err = pg.locator("p[class*=text-danger]").all_inner_texts()
        check("images: open and OCR", False, f"{exc!s:.120} | ui error: {err}")
    check("pdf editor: no console errors", not c.errors, "; ".join(c.errors[:3]))
    c.ctx.close()


def characters(browser):
    run_section("characters")
    c = Ctx(browser)
    pg = c.page()
    goto(pg, "characters", "characters")
    pg.get_by_role("button", name="Sample").click()
    stats = pg.inner_text("body")
    check("characters: sample stats", re.search(r"GRAPHEMES\s*\n?\s*(\d+)", stats, re.I) is not None)
    pg.get_by_label("Text to inspect").fill("a​b c\té")
    body = pg.inner_text("body")
    check("characters: invisible chars listed", "ZERO WIDTH SPACE" in body and "U+200B" in body and "NO-BREAK SPACE" in body and "U+00A0" in body and "TAB" in body)
    def stat(label):
        return pg.locator("div.sk-label", has_text=re.compile(f"^{label}$", re.I)).locator("xpath=following-sibling::div").first.inner_text()
    check("characters: counts (graphemes 7, code points 8, utf16 8, utf8 12)",
          (stat("Graphemes"), stat("Code points"), stat("UTF-16 units"), stat("UTF-8 bytes")) == ("7", "8", "8", "12"),
          str((stat("Graphemes"), stat("Code points"), stat("UTF-16 units"), stat("UTF-8 bytes"))))
    check("characters: preview marks space/tab", "⟦ZERO WIDTH SPACE⟧" in pg.locator("pre").first.inner_text())
    # normalization
    pg.get_by_label("Text to inspect").fill("é")
    pg.get_by_label("Form").select_option("NFC")
    out = pg.locator("pre").nth(1).inner_text()
    check("characters: NFC composes", out == "é", repr(out))
    pg.get_by_label("Form").select_option("NFD")
    check("characters: NFD decomposes", pg.locator("pre").nth(1).inner_text() == "é")
    pg.get_by_label("Text to inspect").fill("ﬁ ½")
    pg.get_by_label("Form").select_option("NFKC")
    check("characters: NFKC folds ligature/fraction", pg.locator("pre").nth(1).inner_text() == "fi 1⁄2", repr(pg.locator("pre").nth(1).inner_text()))
    pg.get_by_label("Form").select_option("NFKD")
    got = copied(pg, lambda: pg.get_by_role("button", name="Copy", exact=True).click())
    check("characters: Copy copies normalized output", got == "fi 1⁄2", repr(got))
    with pg.expect_download() as d:
        pg.get_by_role("button", name="Save", exact=True).click()
    check("characters: Save normalized.txt", save_dl(d.value).read_text(encoding="utf-8") == "fi 1⁄2")
    pg.get_by_role("button", name="Clear").click()
    check("characters: Clear empties input", pg.get_by_label("Text to inspect").input_value() == "")

    # encoding tab
    goto(pg, "characters", "encoding")
    def enc(name, data):
        f = TMP / name
        f.write_bytes(data)
        pg.locator("input[type=file]").set_input_files(str(f))
        pg.wait_for_timeout(300)
        return pg.inner_text("body")
    b = enc("u8.txt", "zażółć gęślą".encode("utf-8"))
    check("encoding: UTF-8 no BOM", "UTF-8" in b and "without BOM" in b and "zażółć" in b)
    b = enc("u8bom.txt", b"\xef\xbb\xbf" + "héllo".encode())
    check("encoding: UTF-8 BOM", "with BOM" in b and "héllo" in b)
    b = enc("u16le.txt", b"\xff\xfe" + "hi there".encode("utf-16-le"))
    check("encoding: UTF-16 LE BOM", "UTF-16 LE" in b and "hi there" in b)
    b = enc("u16be.txt", b"\xfe\xff" + "hi there".encode("utf-16-be"))
    check("encoding: UTF-16 BE BOM", "UTF-16 BE" in b and "hi there" in b)
    b = enc("cp1250.txt", "zażółć".encode("cp1250"))
    check("encoding: legacy code page flagged as not UTF", "Not valid UTF-8" in b)
    b = enc("bin.dat", bytes([0, 1, 2, 3, 255, 0, 0]))
    check("encoding: binary flagged", "Binary" in b or "Not valid" in b, b[-200:])
    check("encoding: no console errors", not c.errors, "; ".join(c.errors[:3]))


def placeholder(browser):
    run_section("placeholder-text")
    c = Ctx(browser)
    pg = c.page()
    goto(pg, "placeholder-text")
    out = lambda: pg.get_by_label("Generated placeholder text").input_value()
    v = out()
    check("placeholder: default 3 paragraphs", len(v.split("\n\n")) == 3 and v.lower().startswith("lorem ipsum"), v[:60])
    pg.get_by_role("spinbutton", name="paragraphs").fill("5")
    check("placeholder: 5 paragraphs", len(out().split("\n\n")) == 5)
    pg.get_by_label("Shape").select_option("sentences")
    pg.get_by_role("spinbutton", name="sentences").fill("4")
    check("placeholder: 4 sentences", len(re.findall(r"\.", out())) == 4 and "\n" not in out(), out()[:80])
    pg.get_by_label("Shape").select_option("words")
    pg.get_by_role("spinbutton", name="words").fill("7")
    check("placeholder: 7 words one per line", out().split("\n") == out().split("\n") and len(out().split("\n")) == 7 and all(w.isalpha() for w in out().split("\n")))
    pg.get_by_label("Shape").select_option("headings")
    pg.get_by_role("spinbutton", name="headings").fill("4")
    hs = out().split("\n\n")
    check("placeholder: 4 headings with ##/### markers", len(hs) == 4 and hs[0].startswith("## ") and hs[1].startswith("### "), str(hs))
    pg.get_by_role("spinbutton", name="headings").fill("999")
    # NumberField keeps the typed text while focused and normalises on Enter/blur; the output already uses the clamped value
    check("placeholder: output uses the clamped amount while typing", len(out().split("\n\n")) == 12, str(len(out().split("\n\n"))))
    pg.get_by_role("spinbutton", name="headings").press("Enter")
    check("placeholder: amount clamped to 12", pg.get_by_role("spinbutton", name="headings").input_value() == "12")
    before = out()
    pg.get_by_role("button", name="Regenerate").click()
    check("placeholder: Regenerate changes text", out() != before)
    stat = pg.locator("div.sk-label", has_text=re.compile("^Words$")).locator("xpath=following-sibling::div").inner_text()
    check("placeholder: word stat matches output", int(stat) == len(out().split()), stat)
    got = copied(pg, lambda: pg.get_by_role("button", name="Copy", exact=True).click())
    check("placeholder: Copy = output", got == out())
    with pg.expect_download() as d:
        pg.get_by_role("button", name="Save .txt").click()
    check("placeholder: Save .txt = output", save_dl(d.value).read_text() == out())
    check("placeholder: no console errors", not c.errors, "; ".join(c.errors[:3]))
    c.ctx.close()


def markdown(browser):
    run_section("markdown")
    c = Ctx(browser)
    pg = c.page()
    goto(pg, "markdown", "preview")
    md = pg.locator("textarea").first
    md.fill("# Title\n\n## Sub\n\nSome **bold** and [link](https://e.com) ![alt](https://e.com/i.png)\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```js\nlet a = 1;\n```\n\n<script>window.__xss=1</script><img src=x onerror=\"window.__xss=2\">\n")
    pg.wait_for_selector("div.min-h-64 h1")
    prev = pg.locator("div.min-h-64")
    check("markdown preview: renders h1/h2/strong/link/table/code/list",
          prev.locator("h1").inner_text() == "Title" and prev.locator("h2").count() == 1 and prev.locator("strong").inner_text() == "bold"
          and prev.locator("a[href='https://e.com']").count() == 1 and prev.locator("table td").count() == 2
          and prev.locator("pre code").inner_text().strip() == "let a = 1;" and prev.locator("li").count() == 2)
    check("markdown preview: script/onerror sanitised", pg.evaluate("window.__xss") is None and prev.locator("script").count() == 0 and prev.locator("[onerror]").count() == 0)
    def stat(l):
        return pg.locator("div.sk-label", has_text=re.compile(f"^{l}$")).locator("xpath=following-sibling::div").first.inner_text()
    check("markdown preview: stats", (stat("Headings"), stat("Links"), stat("Images"), stat("Code blocks")) == ("2", "1", "1", "1"),
          str((stat("Headings"), stat("Links"), stat("Images"), stat("Code blocks"))))
    check("markdown preview: outline", "Title" in pg.inner_text("body") and pg.locator("dl").first.inner_text().replace("\n", " ").count("Sub") == 1)
    pg.get_by_role("button", name="HTML", exact=True).click()
    htmlv = pg.locator("pre").first.inner_text()
    check("markdown preview: HTML view source", "<h1>Title</h1>" in htmlv and "<script" not in htmlv)
    got = copied(pg, lambda: pg.get_by_role("button", name="Copy", exact=True).first.click())
    check("markdown preview: Copy copies HTML in HTML view", "<h1>Title</h1>" in (got or ""))
    pg.get_by_role("button", name="Rendered", exact=True).click()
    got = copied(pg, lambda: pg.get_by_role("button", name="Copy", exact=True).first.click())
    check("markdown preview: Copy copies markdown in rendered view", got.startswith("# Title"))
    with pg.expect_download() as d:
        pg.get_by_role("button", name="Save .md").first.click()
    check("markdown preview: Save notes.md", save_dl(d.value).read_text().startswith("# Title"))
    # HTML -> Markdown
    hin = pg.get_by_label("Paste markup")
    hin.fill("<h2>Hi</h2><p>A <strong>b</strong> <em>i</em> <code>c</code> <a href=\"https://x.y\">l</a> <img src=\"p.png\" alt=\"pic\"></p><ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul><ol><li>x</li><li>y</li></ol><blockquote><p>q</p></blockquote><pre><code class=\"language-py\">print(1)</code></pre><table><tr><th>h1</th><th>h2</th></tr><tr><td>1</td><td>2</td></tr></table><script>bad()</script>")
    pg.wait_for_timeout(400)
    outpre = pg.locator("pre").last.inner_text()
    exp = [
        "## Hi", "A **b** *i* `c` [l](https://x.y) ![pic](p.png)", "- one", "  - nested", "- two", "1. x", "2. y", "> q",
        "```py", "print(1)", "```", "| h1 | h2 |", "| --- | --- |", "| 1 | 2 |",
    ]
    missing = [e for e in exp if e not in outpre.split("\n")]
    check("markdown html->md: conversion lines", not missing and "bad()" not in outpre, f"missing {missing}\n{outpre}")
    check("markdown html->md: nested item not duplicated", outpre.count("nested") == 1, outpre)
    got = copied(pg, lambda: pg.get_by_role("button", name="Copy markdown").click())
    check("markdown html->md: Copy markdown", got == outpre)
    with pg.expect_download() as d:
        pg.get_by_role("button", name="Save .md").last.click()
    check("markdown html->md: Save converted.md", save_dl(d.value).read_text() == outpre)
    pg.get_by_role("button", name="Clear").click()
    check("markdown: Clear/Sample", md.input_value() == "")
    pg.get_by_role("button", name="Sample").click()
    check("markdown: Sample restores", md.input_value().startswith("# Samurai notes"))


def diff(browser):
    run_section("diff")
    c = Ctx(browser)
    pg = c.page()
    goto(pg, "diff")
    L = pg.get_by_label("Before")
    R = pg.get_by_label("After")
    L.fill("one\ntwo three four\nthree\nfour")
    R.fill("one\ntwo THREE four\nthree\nfive\nsix")
    summary = pg.locator("span.font-mono", has_text="added").first.inner_text()
    check("diff: summary counts (3 added? / removed)", summary == "3 added · 2 removed · 2 unchanged", summary)
    marked = pg.locator("table span[class*='bg-danger']").all_inner_texts()
    check("diff: word-level marks only the changed word", "three" in marked and "THREE" in marked and "two" not in marked, str(marked))
    pg.get_by_role("combobox").select_option("patch")
    patch = pg.locator("pre").first.inner_text()
    # Real unified diff: hunk header, "no newline" markers (the textareas end without one), final newline.
    check("diff: unified patch", patch == "--- left\n+++ right\n@@ -1,4 +1,5 @@\n one\n-two three four\n+two THREE four\n three\n-four\n\\ No newline at end of file\n+five\n+six\n\\ No newline at end of file\n", repr(patch))
    got = copied(pg, lambda: pg.get_by_role("button", name="Copy patch").click())
    check("diff: Copy patch", got == patch)
    with pg.expect_download() as d:
        pg.get_by_role("button", name="Download .diff").click()
    check("diff: download changes.diff", save_dl(d.value).read_text() == patch)
    L.fill("same\nsame")
    R.fill("same\nsame")
    s = pg.locator("span.font-mono", has_text="added").first.inner_text()
    check("diff: identical inputs -> 0 added/removed", "0 added" in s.replace("0 added", "0 added") and "0 removed" in s and "2 unchanged" in s, s)
    L.fill("\n".join(str(i) for i in range(2100)))
    check("diff: >2000 lines gives error", pg.get_by_text("Too many lines").count() == 1)
    L.fill(""); R.fill("x")
    check("diff: empty vs text works", "added" in pg.locator("span.font-mono", has_text="added").first.inner_text())
    check("diff: no console errors", not c.errors, "; ".join(c.errors[:3]))
    c.ctx.close()


# ================================================================ mobile
TABS = {
    "pdf": ["tools", "editor"],
    "file-compressor": [None],
    "characters": ["characters", "encoding", "hex"],
    "batch-rename": ["rename", "normalize", "manifest"],
    "placeholder-text": [None],
    "markdown": ["preview", "organize"],
    "diff": [None],
}


def mobile(browser):
    run_section("390px overflow")
    c = Ctx(browser, width=390)
    pg = c.page()
    for slug, tabs in TABS.items():
        for tab in tabs:
            goto(pg, slug, tab)
            check(f"mobile 390px no overflow: {slug}{'?tab=' + tab if tab else ''}", overflow(pg))
    # with content
    goto(pg, "markdown", "preview")
    pg.get_by_role("button", name="Sample").click()
    pg.wait_for_timeout(300)
    check("mobile 390px no overflow: markdown with content", overflow(pg))
    goto(pg, "diff")
    check("mobile 390px no overflow: diff with content", overflow(pg))
    goto(pg, "pdf", "tools")
    pg.locator("input[type=file]").first.set_input_files(str(TMP / "alpha.pdf"))
    pg.get_by_role("button", name="Inspect", exact=True).last.click()
    pg.get_by_text("3 pages").first.wait_for(timeout=30000)
    check("mobile 390px no overflow: pdf tools with result", overflow(pg))
    goto(pg, "pdf", "editor")
    pg.locator("input[type=file]").first.set_input_files(str(TMP / "ed.pdf"))
    pg.get_by_text("3 pages loaded").wait_for(timeout=30000)
    pg.wait_for_timeout(500)
    check("mobile 390px no overflow: pdf editor with doc", overflow(pg))
    check("mobile: no console errors", not c.errors, "; ".join(c.errors[:3]))
    c.ctx.close()


def main():
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for fn in (pdf_tools, pdf_editor, characters, placeholder, markdown, diff, mobile):
                try:
                    fn(browser)
                except Exception as exc:  # noqa: BLE001
                    check(f"{fn.__name__}: aborted", False, repr(exc)[:400])
            browser.close()
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
    print(f"\n{'ALL PASS' if not failures else 'FAILURES: ' + str(len(failures))} in {time.time() - START:.0f}s")
    for f in failures:
        print("  -", f)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
