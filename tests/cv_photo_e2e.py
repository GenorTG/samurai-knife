#!/usr/bin/env python3
"""CV photo + document layouts through the real UI (/tools/cv-studio): upload and crop a photo in the Profile tab, switch the
four layouts in CV versions, print to PDF, export the DOCX, remove the photo.

Oracles are independent of the app: the stored photo is read back over HTTP and decoded with Pillow (square, JPEG, EXIF and
GPS gone), the DOCX is opened as a zip, the printed PDF is parsed with pypdf when the venv has it. Synthetic data only.

Usage: python3 tests/cv_photo_e2e.py <base_url>   (needs a FRESH data dir: the run imports a profile)
       SHOTS=/dir saves a screenshot of every layout.
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import traceback
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3210").rstrip("/")
SHOTS = os.environ.get("SHOTS", "")
FAILS: list[str] = []

PROFILE = {
    "contact": {
        "name": "Jan Testowy",
        "headline": {"pl": "Inżynier oprogramowania", "en": "Software engineer"},
        "location": {"pl": "Warszawa", "en": "Warsaw"},
        "email": "jan@example.com",
        "phone": "+48 500 000 000",
        "links": [{"label": "github.com/jan-test", "url": "https://github.com/jan-test"}],
    },
    "summary": {"pl": "Inżynier z pięcioletnim doświadczeniem w narzędziach webowych.", "en": "Engineer with five years of web tooling."},
    "experience": [
        {"id": "acme", "org": "Acme Sp. z o.o.", "role": {"pl": "Starszy programista", "en": "Senior developer"}, "start": "2021-03", "end": None, "location": "Warszawa",
         "bullets": [{"id": "acme-api", "text": {"pl": "Zaprojektowałem API obsługujące 2 mln zapytań dziennie.", "en": "Designed an API serving 2M requests per day."}}]},
    ],
    "skills": [{"id": "lang", "name": {"pl": "Języki", "en": "Languages"}, "items": ["Python", "TypeScript"]}],
    "education": [{"id": "pw", "institution": "Politechnika Testowa", "detail": {"pl": "Informatyka", "en": "Computer science"}, "start": "2014-10", "end": "2019-06"}],
    "languages": [{"id": "pl", "name": {"pl": "Polski", "en": "Polish"}, "level": {"pl": "ojczysty", "en": "native"}}],
}


def check(cond: bool, label: str) -> None:
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        FAILS.append(label)


def api(method: str, path: str, body: object | None = None) -> tuple[int, bytes, dict[str, str]]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"content-type": "application/json", "Origin": BASE})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, res.read(), {k.lower(): v for k, v in res.headers.items()}
    except urllib.error.HTTPError as err:
        return err.code, err.read(), {k.lower(): v for k, v in err.headers.items()}


def make_photo(path: Path) -> None:
    """A 1200x900 landscape JPEG with EXIF (camera + GPS) and a red dot left of centre, so the crop is visible."""
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (1200, 900), (70, 110, 160))
    ImageDraw.Draw(image).ellipse((350, 250, 650, 550), fill=(200, 40, 40))
    exif = Image.Exif()
    exif[0x010F] = "TestCam"  # Make
    exif[0x8825] = {1: "N", 2: (52.0, 13.0, 0.0)}  # GPSInfo
    image.save(path, "JPEG", exif=exif.tobytes())


def main() -> int:
    status, body, _ = api("GET", "/api/cv")
    if json.loads(body).get("profile", {}).get("contact", {}).get("name"):
        print("refusing to run: this data dir already has a CV profile (use a fresh KNIFE_DATA_DIR)")
        return 2
    status, body, _ = api("POST", "/api/cv/import", {"profile": PROFILE})
    check(status == 200, f"profile imported ({status})")
    check(api("GET", "/api/cv/photo")[0] == 404, "no photo before upload: 404")

    tmp = Path(tempfile.mkdtemp(prefix="cv-photo-e2e-"))
    source = tmp / "portrait.jpg"
    make_photo(source)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1500, "height": 1100}, accept_downloads=True)
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # ---- Profile tab: upload + crop
        page.goto(f"{BASE}/tools/cv-studio?tab=profile")
        panel = page.locator("[data-cv-path='/photo']")
        expect(panel).to_be_visible(timeout=60_000)
        panel.locator("input[type=file]").set_input_files(str(source))
        crop = page.get_by_role("img", name="Photo crop preview")
        expect(crop).to_be_visible()
        zoom = page.get_by_label("Zoom")
        zoom.fill("1.5")
        page.get_by_label("Left / right").fill("0.35")
        page.get_by_role("button", name="Save photo").click()
        stored = panel.get_by_role("img", name="Your CV photo")
        expect(stored).to_be_visible()
        page.wait_for_function("() => { const i = document.querySelector('img[alt=\"Your CV photo\"]'); return i && i.complete && i.naturalWidth > 0; }")

        status, raw, headers = api("GET", "/api/cv/photo")
        check(status == 200 and headers.get("content-type", "").startswith("image/jpeg"), f"stored photo served as JPEG ({status})")
        from PIL import Image

        with Image.open(io.BytesIO(raw)) as img:
            check(img.format == "JPEG" and img.width == img.height and 200 <= img.width <= 800, f"square JPEG ≤800px ({img.format} {img.size})")
            check(len(img.getexif()) == 0, "EXIF (camera, GPS) stripped by the browser re-encode")
            # The crop centre moved left (0.35) onto the red dot: the middle pixel is red.
            r, g, b = img.convert("RGB").getpixel((img.width // 2, img.height // 2))
            check(r > 150 and g < 90, f"crop follows the sliders (centre pixel {r},{g},{b})")
        meta = json.loads(api("GET", "/api/cv/photo?meta=1")[1])["photo"]
        check(meta and meta["bytes"] == len(raw), "meta matches the stored file")

        # ---- CV versions: four layouts
        page.goto(f"{BASE}/tools/cv-studio?tab=variants")
        sheet = page.locator("[data-cv-document]")
        expect(sheet).to_be_visible(timeout=60_000)
        layouts = page.get_by_role("radiogroup", name="Document layout")
        for layout, label in (("ats", "ATS layout"), ("modern", "Modern layout"), ("sidebar", "Sidebar layout"), ("elegant", "Elegant layout")):
            layouts.get_by_role("radio", name=label).click()
            expect(sheet).to_have_attribute("data-theme", layout)
            photo = sheet.locator("img.cv-photo")
            if layout == "ats":
                check(photo.count() == 0, "ATS: no photo, whatever the switch says")
                check(page.get_by_role("radiogroup", name="Print the photo").count() == 0, "ATS: no photo switch offered")
            else:
                expect(photo).to_be_visible()
                loaded = photo.evaluate("i => i.complete && i.naturalWidth > 0")
                check(loaded, f"{layout}: photo printed and loaded")
            if layout == "sidebar":
                side = sheet.locator(".cv-side")
                check("jan@example.com" in side.inner_text() and "Politechnika Testowa" in side.inner_text(), "sidebar: contact and education in the left column")
                check("Acme" in sheet.locator(".cv-main").inner_text(), "sidebar: experience in the main column")
            if SHOTS:
                Path(SHOTS).mkdir(parents=True, exist_ok=True)
                sheet.screenshot(path=str(Path(SHOTS) / f"layout-{layout}.png"))

        page.get_by_role("radio", name="Square photo").click()
        expect(sheet).to_have_attribute("data-photo", "square")
        page.get_by_role("radio", name="Hide the photo").click()
        expect(sheet.locator("img.cv-photo")).to_have_count(0)
        page.get_by_role("radio", name="Show the photo").click()
        page.get_by_role("radio", name="Round photo").click()
        expect(sheet).to_have_attribute("data-photo", "round")

        # ---- print (what "Save as PDF" produces)
        layouts.get_by_role("radio", name="Sidebar layout").click()
        page.emulate_media(media="print")
        pdf_path = tmp / "cv.pdf"
        page.pdf(path=str(pdf_path), prefer_css_page_size=True, print_background=True)
        page.emulate_media(media="screen")
        try:
            from pypdf import PdfReader

            reader = PdfReader(str(pdf_path))
            text = "\n".join(pg.extract_text() or "" for pg in reader.pages)
            check(len(reader.pages) == 1, f"printed sidebar CV is one A4 page ({len(reader.pages)})")
            check("Jan Testowy" in text and "Politechnika Testowa" in text and "Cookies" not in text, "PDF holds the sheet only")
            check(any("/XObject" in str(pg.get("/Resources", {})) for pg in reader.pages), "PDF carries the photo")
        except ImportError:
            print("SKIP pdf checks (pypdf not installed in this python)")
        if SHOTS:
            (Path(SHOTS) / "sidebar.pdf").write_bytes(pdf_path.read_bytes())

        # ---- DOCX export uses the same layout + photo
        with page.expect_download() as dl:
            page.get_by_role("button", name="Download DOCX").click()
        docx = tmp / "cv.docx"
        dl.value.save_as(str(docx))
        with zipfile.ZipFile(docx) as archive:
            media = [n for n in archive.namelist() if n.startswith("word/media/")]
            xml = archive.read("word/document.xml").decode("utf-8")
        check(len(media) == 1 and media[0].endswith(".png"), f"DOCX carries the round photo ({media})")
        check(xml.count("<w:tbl>") == 1 and "EDF2F7" in xml, "DOCX sidebar = one shaded two-column table")
        layouts.get_by_role("radio", name="ATS layout").click()
        with page.expect_download() as dl:
            page.get_by_role("button", name="Download DOCX").click()
        dl.value.save_as(str(docx))
        with zipfile.ZipFile(docx) as archive:
            check(not [n for n in archive.namelist() if n.startswith("word/media/")], "ATS DOCX has no image")

        # ---- remove
        page.goto(f"{BASE}/tools/cv-studio?tab=profile")
        panel = page.locator("[data-cv-path='/photo']")
        panel.get_by_role("button", name="Remove photo").click()
        expect(panel.get_by_role("img", name="Your CV photo")).to_have_count(0)
        check(api("GET", "/api/cv/photo")[0] == 404, "photo removed: 404")
        check(api("POST", "/api/cv/photo", {"dataUrl": "data:image/png;base64,iVBORw0KGgo="})[0] == 422, "non-JPEG upload refused (422)")

        check(not errors, f"no page errors ({errors[:3]})")
        browser.close()

    print(f"\n{'OK' if not FAILS else 'FAILED'}: {len(FAILS)} failure(s)")
    for f in FAILS:
        print("  -", f)
    return 1 if FAILS else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        sys.exit(1)
