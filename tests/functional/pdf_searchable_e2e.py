"""Focused searchable-PDF editor UI checks; synthetic files and a scratch server only.

python3 tests/functional/pdf_searchable_e2e.py [scratch_url]
No URL starts an isolated current-tree ScratchServer; never defaults to live :3210.
Requires the PDF Python venv with OCRmyPDF/Tesseract and system Python Playwright.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))
from scratch_server import ScratchServer

PYTHON = os.environ.get("KNIFE_PYTHON", str(ROOT.parent / "samurai-knife-py/venv/bin/python"))


def py(code: str, *args: object) -> str:
    return subprocess.run(
        [PYTHON, "-c", code, *map(str, args)], capture_output=True, text=True,
        check=True, timeout=120,
    ).stdout


def pdf_info(path: Path) -> list[dict]:
    return json.loads(py("""
import json, sys
from pypdf import PdfReader
print(json.dumps([{"text": p.extract_text(), "rotation": p.rotation,
                  "width": float(p.mediabox.width), "height": float(p.mediabox.height)}
                 for p in PdfReader(sys.argv[1]).pages]))
""", path))


def fixtures(tmp: Path) -> Path:
    path = tmp / "synthetic-scans.pdf"
    py("""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
root = Path(sys.argv[1])
font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 48)
c = canvas.Canvas(str(root / "synthetic-scans.pdf"))
for index, word in enumerate(("ALPHA", "BRAVO", "CHARLIE")):
    image = Image.new("RGB", (1600, 1000), "white")
    draw = ImageDraw.Draw(image)
    for row, line in enumerate((f"{word} SCANNED DOCUMENT", "SEARCHABLE CONTENT TEST",
                                "A clear synthetic scan for local OCR.", "No private information in this document.")):
        draw.text((80, 90 + 110 * row), line, font=font, fill="black")
    if index == 0:
        image = image.transpose(Image.Transpose.ROTATE_90)
    scan = root / f"{word}.png"
    image.save(scan)
    width, height = image.size
    c.setPageSize((width / 2, height / 2))
    c.drawImage(str(scan), 0, 0, width / 2, height / 2)
    c.showPage()
c.save()
c = canvas.Canvas(str(root / "digital.pdf"))
c.drawString(72, 720, "EXACT DIGITAL TEXT 12345")
c.showPage()
c.save()
""", tmp)
    assert all(not p["text"].strip() for p in pdf_info(path)), "Fixture must have no text layer"
    return path


def run(base: str) -> None:
    if urlparse(base).port == 3210:
        raise ValueError("Refusing live :3210. Use an isolated scratch server.")
    with tempfile.TemporaryDirectory(prefix="knife-searchable-ui-") as directory, sync_playwright() as pw:
        tmp = Path(directory)
        scan = fixtures(tmp)
        browser = pw.chromium.launch()
        context = browser.new_context(viewport={"width": 1440, "height": 1200}, accept_downloads=True)
        context.add_init_script("""
            window.pdfDownloads = [];
            const click = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function () {
                if (this.download) window.pdfDownloads.push({name: this.download, href: this.href});
                return click.call(this);
            };
        """)
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(base + "/tools/pdf?tab=editor")
        expect(page.get_by_text("Open a PDF to start editing", exact=True)).to_be_visible(timeout=60000)
        upload = page.locator("input[type=file]").first
        upload.set_input_files(str(scan))
        expect(page.get_by_text("3 pages loaded in this browser.", exact=True)).to_be_visible(timeout=30000)
        export = page.get_by_role("button", name="Searchable PDF (server)", exact=True)
        expect(export).to_be_enabled()
        expect(page.get_by_label("Deskew scanned pages")).to_be_checked()
        expect(page.get_by_label("Auto-rotate pages")).to_be_checked()
        expect(page.get_by_label("Searchable PDF language")).to_have_value("eng")

        # Rotate the sideways scan upright. Reorder, remove and overlay via real UI.
        page.get_by_role("button", name="↻ Rotate", exact=True).click()
        thumbs = page.locator("button[draggable=true]")
        thumbs.nth(1).click()
        page.get_by_role("button", name="Text", exact=True).click()
        page.get_by_label("Text", exact=True).fill("VISIBLE OVERLAY")
        page.get_by_label("Font size", exact=True).fill("28")
        svg = page.locator("svg[aria-label^='PDF page 2']")
        svg.scroll_into_view_if_needed()
        box = svg.bounding_box()
        assert box
        page.mouse.click(box["x"] + box["width"] * 0.15, box["y"] + box["height"] * 0.82)
        expect(svg.locator("text", has_text="VISIBLE OVERLAY")).to_have_count(1)
        thumbs.nth(2).click()
        page.get_by_role("button", name="Delete page", exact=True).click()
        thumbs.nth(0).drag_to(thumbs.nth(1))
        expect(thumbs.first).to_contain_text("Page 2")

        # Existing client-only export remains vector/text-preserving.
        edited = tmp / "edited.pdf"
        with page.expect_download(timeout=60000) as download:
            page.get_by_role("button", name="Export edited PDF", exact=True).click()
        download.value.save_as(edited)
        raw = pdf_info(edited)
        assert len(raw) == 2 and "VISIBLE OVERLAY" in raw[0]["text"]
        assert raw[1]["rotation"] == 90
        print("ok edited export retains page order, removal, rotation and vector overlay", flush=True)

        # Preserve chosen orientation and exercise non-default params + shared language.
        page.get_by_label("Deskew scanned pages").uncheck()
        page.get_by_label("Auto-rotate pages").uncheck()
        page.get_by_label("Searchable PDF language").select_option("eng+pol")
        # Field wraps each control in a <label>, so get_by_label also sees the <option>
        # rows and an exact match never lands; the accessible name does.
        expect(page.get_by_role("combobox", name="Language", exact=True)).to_have_value("eng+pol")

        # Stable cancellation window: hold only status polling, not the real job POST/DELETE.
        def hold_status(route):
            if route.request.method == "GET" and not route.request.url.endswith("/file"):
                route.fulfill(json={"jobId": route.request.url.rsplit("/", 1)[-1], "status": "running"})
            else:
                route.continue_()

        page.route("**/api/jobs/*", hold_status)
        with page.expect_response(lambda r: r.request.method == "POST" and "/api/pdf?" in r.url) as accepted:
            export.click()
        assert accepted.value.status == 202
        first_job = accepted.value.json()["jobId"]
        expect(page.get_by_role("status").filter(has_text="Creating searchable PDF")).to_be_visible(timeout=30000)
        expect(upload).to_be_disabled()
        expect(page.get_by_label("Searchable PDF language")).to_be_disabled()
        assert page.locator("[inert][aria-busy=true]").count() == 1, "Editing must be inert during server OCR"
        editor = page.get_by_label("PDF editor; keyboard shortcuts are active only while interacting here", exact=True)
        editor.focus()
        page.keyboard.press("Control+z")
        assert page.locator("button[draggable=true]").count() == 2, "Keyboard must not undo during server OCR"
        with page.expect_response(lambda r: r.request.method == "DELETE" and first_job in r.url):
            page.get_by_role("button", name="Cancel searchable PDF", exact=True).click()
        expect(page.get_by_role("status").filter(has_text="Searchable PDF cancelled.")).to_be_visible(timeout=10000)
        expect(export).to_be_enabled()
        assert len(page.evaluate("window.pdfDownloads")) == 1, "Cancelled OCR must not download"
        page.unroute("**/api/jobs/*", hold_status)
        print("ok cancel deletes server job, blocks edits/loading/shortcuts, preserves edits and allows retry", flush=True)

        # Retry must really OCR the scan below the text overlay, not skip that page.
        searchable = tmp / "searchable.pdf"
        with page.expect_download(timeout=180000) as download:
            export.click()
        assert download.value.suggested_filename == "synthetic-scans-searchable.pdf"
        download.value.save_as(searchable)
        expect(page.get_by_role("status").filter(has_text="Searchable PDF downloaded:")).to_be_visible()
        result = pdf_info(searchable)
        assert len(result) == 2, result
        assert "BRAVO" in result[0]["text"] and "VISIBLE OVERLAY" in result[0]["text"], result[0]
        assert "ALPHA" in result[1]["text"], result[1]
        assert "CHARLIE" not in "".join(p["text"] for p in result), result
        captures = page.evaluate("window.pdfDownloads")
        assert captures[-1]["href"].startswith("blob:") and captures[-1]["name"].endswith("-searchable.pdf")
        print("ok actual PDF text: reordered BRAVO + overlay, rotated ALPHA, removed CHARLIE; captured blob download", flush=True)

        # Existing browser OCR still produces text and does not call the server.
        posts: list[str] = []
        page.on("request", lambda r: posts.append(r.url) if r.method == "POST" and "/api/pdf" in r.url else None)
        page.get_by_role("combobox", name="Language", exact=True).select_option("eng")
        page.get_by_role("button", name="Current page", exact=True).click()
        expect(page.get_by_role("status").filter(has_text="OCR finished:")).to_be_visible(timeout=150000)
        assert "BRAVO" in page.locator("textarea[readonly]").first.input_value()
        assert not posts, posts
        with page.expect_download(timeout=10000) as text_download:
            page.get_by_role("button", name="Download OCR text", exact=True).click()
        text_path = tmp / "browser-ocr.txt"
        text_download.value.save_as(text_path)
        assert "BRAVO" in text_path.read_text()
        print("ok browser OCR remains local and downloadable", flush=True)

        # Unmarked digital text must stay exact, not be rasterized/re-recognized.
        upload.set_input_files(str(tmp / "digital.pdf"))
        expect(page.get_by_text("1 page loaded in this browser.", exact=True)).to_be_visible()
        with page.expect_download(timeout=180000) as download:
            export.click()
        digital = tmp / "digital-searchable.pdf"
        download.value.save_as(digital)
        assert "EXACT DIGITAL TEXT 12345" in pdf_info(digital)[0]["text"]
        print("ok unmarked digital text remains exact", flush=True)

        # Client-side tab switch unmounts the tool and cancels its job.
        page.route("**/api/jobs/*", hold_status)
        with page.expect_response(lambda r: r.request.method == "POST" and "/api/pdf?" in r.url) as accepted:
            export.click()
        job_id = accepted.value.json()["jobId"]
        expect(page.get_by_role("status").filter(has_text="Creating searchable PDF")).to_be_visible(timeout=30000)
        with page.expect_response(lambda r: r.request.method == "DELETE" and job_id in r.url):
            page.get_by_role("tab", name="Tools", exact=True).click()
        expect(page.get_by_role("tab", name="Tools", exact=True)).to_have_attribute("aria-selected", "true")
        assert not errors, errors
        print("ok unmount cancels server job; no browser errors", flush=True)
        browser.close()


if __name__ == "__main__":
    if len(sys.argv) > 1:
        run(sys.argv[1].rstrip("/"))
    else:
        with ScratchServer() as server:
            base = server.start(env={"KNIFE_PYTHON": PYTHON})
            # The scratch worktree is a `git stash create` snapshot: tracked edits
            # only. Until pdf_ocr.py is committed it would be missing there, and
            # pdf_tool.py's import of it fails. Copy the worker scripts in.
            if server.cwd != ROOT:
                shutil.copytree(ROOT / "server/py", server.cwd / "server/py", dirs_exist_ok=True)
            run(base)
