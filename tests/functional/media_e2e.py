#!/usr/bin/env python3
"""Real-browser functional test for the media tools.

Covers image-crop (crop/trim), image-compare, image-resize
(resize/scrub/responsive/favicon), svg-optimize (optimize/sanitize/png), qr and
color. Every tab is fed real fixtures, driven
through the real UI, and asserted on actual output (text, downloaded bytes
parsed with PIL / an XML parser, clipboard content). Each tab runs at 1280px
and at 390px; the latter also asserts there is no horizontal overflow.

No model or network service is used.

    python3 tests/functional/media_e2e.py [http://127.0.0.1:3210]
"""
import base64
import colorsys
import io
import os
import shutil
import sys
import tempfile
import time
import xml.dom.minidom as minidom

from PIL import Image
from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3210").rstrip("/")
TMP = tempfile.mkdtemp(prefix="media_e2e_")
FAILS: list[str] = []
CURRENT = {"name": ""}

try:
    import cv2
    import numpy as np
except Exception:  # decoding QR is skipped when OpenCV is missing
    cv2 = None


def check(cond, msg):
    if cond:
        print(f"ok   {CURRENT['name']}: {msg}")
    else:
        print(f"FAIL {CURRENT['name']}: {msg}")
        FAILS.append(f"{CURRENT['name']}: {msg}")


# ------------------------------------------------------------------ fixtures
def fpath(name):
    return os.path.join(TMP, name)


def make_png(name, size, fn=None, mode="RGBA", color=(0, 0, 0, 0)):
    img = Image.new(mode, size, color)
    if fn:
        px = img.load()
        for y in range(size[1]):
            for x in range(size[0]):
                px[x, y] = fn(x, y)
    img.save(fpath(name))
    return fpath(name)


RED, GREEN, BLUE = (255, 0, 0, 255), (0, 255, 0, 255), (0, 0, 255, 255)


def build_fixtures():
    fx = {}
    fx["halves"] = make_png("halves.png", (200, 100), lambda x, y: RED if x < 100 else BLUE)
    fx["trim"] = make_png(
        "trim.png", (100, 80),
        lambda x, y: (10, 200, 30, 255) if 20 <= x < 60 and 10 <= y < 40 else ((255, 255, 255, 5) if (x, y) == (99, 79) else (0, 0, 0, 0)),
    )
    fx["red100"] = make_png("red100.png", (100, 100), lambda x, y: RED)
    fx["red100b"] = make_png("red100b.png", (100, 100), lambda x, y: RED)
    fx["half_blue"] = make_png("half_blue.png", (100, 100), lambda x, y: BLUE if x < 50 else RED)
    fx["red250"] = make_png("red250.png", (100, 100), lambda x, y: (250, 0, 0, 255))
    fx["red50"] = make_png("red50.png", (50, 50), lambda x, y: RED)
    alpha_fn = lambda x, y: (255, 0, 0, 0) if y < 2 else ((0, 255, 0, 128) if y < 5 else (0, 0, 255, 255))
    fx["alpha"] = make_png("alpha.png", (10, 10), alpha_fn)
    fx["wide"] = make_png("wide.png", (400, 200), lambda x, y: RED if x < 200 else BLUE)
    fx["w1000"] = make_png("w1000.png", (1000, 500), lambda x, y: (x % 256, y % 256, 90, 255), mode="RGB", color=(0, 0, 0))
    fx["sq300"] = make_png("sq300.png", (300, 300), lambda x, y: (200, 30, 90, 255))
    fx["sheet0"] = make_png("sheet0.png", (300, 100), lambda x, y: RED)
    fx["sheet1"] = make_png("sheet1.png", (80, 200), lambda x, y: GREEN)
    fx["sheet2"] = make_png("sheet2.png", (120, 120), lambda x, y: BLUE)
    fx["tiny"] = [make_png(f"t{i:02d}.png", (8, 8), lambda x, y: RED) for i in range(22)]

    # JPEG with EXIF + PNG with text chunks for the metadata scrubber
    exif = Image.Exif()
    exif[0x010F] = "SECRETCAMERAMAKE"
    exif[0x0131] = "SECRETSOFTWARE"
    jimg = Image.new("RGB", (64, 48), (120, 80, 200))
    jimg.save(fpath("exif.jpg"), exif=exif, quality=95)
    fx["exif_jpg"] = fpath("exif.jpg")
    from PIL.PngImagePlugin import PngInfo
    info = PngInfo()
    info.add_text("Author", "SECRETAUTHOR")
    info.add_text("Comment", "SECRETCOMMENT")
    Image.new("RGB", (64, 48), (10, 120, 30)).save(fpath("meta.png"), pnginfo=info)
    fx["meta_png"] = fpath("meta.png")

    # noisy PNG > 250 KB for the data-uri size warning
    noise = Image.frombytes("RGB", (400, 400), os.urandom(400 * 400 * 3))
    noise.save(fpath("noise.png"))
    fx["noise"] = fpath("noise.png")

    # real LCG-free gradient for palette: left red / right blue
    fx["palette"] = make_png("palette.png", (64, 64), lambda x, y: RED if x < 32 else BLUE)
    return fx


# ------------------------------------------------------------------- helpers
def goto(page, path):
    page.goto(f"{BASE}{path}", wait_until="load")
    page.wait_for_selector("main, h1", timeout=20000)
    page.wait_for_load_state("networkidle")


def upload(page, path, nth=0, **kw):
    page.locator("input[type=file]").nth(nth).set_input_files(path)


def download(page, click):
    with page.expect_download(timeout=15000) as dl:
        click()
    d = dl.value
    p = os.path.join(TMP, "dl_" + d.suggested_filename)
    d.save_as(p)
    with open(p, "rb") as fh:
        data = fh.read()
    return d.suggested_filename, data


def img_of(data):
    im = Image.open(io.BytesIO(data))
    im.load()
    return im


def clip(page):
    return page.evaluate("window.__clip")


def settle(page, ms=700):
    page.wait_for_timeout(ms)


def near(a, b, tol=2):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


# --------------------------------------------------------------- tab tests
def t_crop(page, fx):
    goto(page, "/tools/image-crop?tab=crop")
    upload(page, fx["halves"])
    page.get_by_label("Horizontal position (%)").fill("0")
    page.get_by_label("Crop width (%)").fill("100")
    page.get_by_role("button", name="Preview crop").click()
    page.get_by_text("100 × 100 crop").wait_for()
    dims = page.evaluate("[document.querySelector('canvas').width, document.querySelector('canvas').height]")
    check(dims == [100, 100], f"square crop of 200x100 is 100x100 (got {dims})")
    c = page.evaluate("Array.from(document.querySelector('canvas').getContext('2d').getImageData(50,50,1,1).data)")
    check(c == [255, 0, 0, 255], "left position crops the red half")
    name, data = download(page, lambda: page.get_by_role("button", name="Export PNG").click())
    im = img_of(data)
    check(name == "cropped.png" and im.format == "PNG" and im.size == (100, 100), f"export png {name} {im.size}")
    check(im.convert("RGBA").getpixel((50, 50)) == (255, 0, 0, 255), "exported pixels are red")
    page.get_by_label("Horizontal position (%)").fill("100")
    _, data = download(page, lambda: page.get_by_role("button", name="Export PNG").click())
    check(img_of(data).convert("RGBA").getpixel((50, 50)) == (0, 0, 255, 255), "right position exports the blue half")
    page.get_by_label("Aspect ratio").select_option("16:9")
    page.get_by_role("button", name="Preview crop").click()
    page.get_by_text("178 × 100 crop").wait_for()
    check(True, "16:9 on 200x100 gives 178x100")
    page.get_by_label("Aspect ratio").select_option("free")
    page.get_by_label("Crop width (%)").fill("50")
    page.get_by_role("button", name="Preview crop").click()
    page.get_by_text("100 × 50 crop").wait_for()
    check(True, "free 50% gives 100x50")
    page.get_by_label("Aspect ratio").select_option("portrait")
    page.get_by_label("Crop width (%)").fill("100")
    page.get_by_role("button", name="Preview crop").click()
    page.get_by_text("75 × 100 crop").wait_for()
    check(True, "portrait 3:4 of 200x100 gives 75x100")


def t_trim(page, fx):
    goto(page, "/tools/image-crop?tab=trim")
    upload(page, fx["trim"])
    name, data = download(page, lambda: page.get_by_role("button", name="Trim and download PNG").click())
    im = img_of(data)
    check(name == "trim-trimmed.png", f"filename {name}")
    check(im.size == (80, 70), f"alpha 5 stray pixel at (99,79) kept at threshold 0 -> {im.size}")
    page.get_by_label("Treat alpha at or below as transparent (0–254)").fill("10")
    name, data = download(page, lambda: page.get_by_role("button", name="Trim and download PNG").click())
    im = img_of(data).convert("RGBA")
    check(im.size == (40, 30), f"threshold 10 trims to 40x30 (got {im.size})")
    check(im.getpixel((0, 0)) == (10, 200, 30, 255) and im.getpixel((39, 29)) == (10, 200, 30, 255), "trimmed edges are the opaque colour")
    check(page.get_by_text("Trimmed 100×80 to 40×30.").count() == 1, "status shows before/after size")
    # fully transparent image: error, no crash
    make_png("clear.png", (10, 10))
    upload(page, fpath("clear.png"))
    page.get_by_role("button", name="Trim and download PNG").click()
    page.get_by_text("No visible pixels were found").wait_for()
    check(True, "fully transparent image reports an error")


def t_compare(page, fx):
    goto(page, "/tools/image-compare")
    ins = page.locator("input[type=file]")
    btn = page.get_by_role("button", name="Compare images")
    check(btn.is_disabled(), "compare disabled until both images chosen")
    ins.nth(0).set_input_files(fx["red100"])
    ins.nth(1).set_input_files(fx["red100b"])
    btn.click()
    page.get_by_text("0.00%", exact=True).wait_for()
    check(page.get_by_text("100×100", exact=True).count() == 1, "size stat 100x100")
    check(page.get_by_text("0.00", exact=True).count() == 1, "identical images: MAE 0.00")
    ins.nth(1).set_input_files(fx["half_blue"])
    btn.click()
    page.get_by_text("50.00%", exact=True).wait_for()
    check(page.get_by_text("63.75", exact=True).count() == 1, "half blue vs red: changed 50%, MAE 63.75")
    ins.nth(1).set_input_files(fx["red250"])
    btn.click()
    page.get_by_text("1.25", exact=True).wait_for()
    check(page.get_by_text("0.00%", exact=True).count() == 1, "subtle 5/255 difference is below threshold 12")
    page.get_by_label("Per-pixel difference threshold").fill("0")
    btn.click()
    page.get_by_text("100.00%", exact=True).wait_for()
    check(True, "threshold 0 flags every pixel")
    ins.nth(1).set_input_files(fx["red50"])
    page.get_by_label("Per-pixel difference threshold").fill("12")
    btn.click()
    page.get_by_text("0.00%", exact=True).wait_for()
    check(page.get_by_text("100×100", exact=True).count() == 1, "different-size second image is resized to the first")


def wait_render(page):
    settle(page, 500)
    page.get_by_text("Rendering…").wait_for(state="detached", timeout=10000)


def t_resize(page, fx):
    goto(page, "/tools/image-resize?tab=resize")
    upload(page, fx["wide"])
    page.get_by_text("400×200 ·").wait_for()
    check(True, "source dimensions shown")
    wait_render(page)
    name, data = download(page, lambda: page.get_by_role("button", name="Download", exact=True).click())
    im = img_of(data)
    check(im.size == (400, 200) and im.format == "PNG" and name == "wide-400x200.png", f"identity export {name} {im.size}")
    page.get_by_role("button", name="1200 w").click()
    wait_render(page)
    _, data = download(page, lambda: page.get_by_role("button", name="Download", exact=True).click())
    im = img_of(data)
    check(im.size == (1200, 600), f"1200 w preset keeps ratio -> {im.size}")
    page.get_by_label("Width").fill("100")
    check(page.get_by_label("Height").input_value() == "50", "locked ratio updates height")
    wait_render(page)
    _, data = download(page, lambda: page.get_by_role("button", name="Download", exact=True).click())
    im = img_of(data).convert("RGBA")
    check(im.size == (100, 50), "width 100 -> 100x50")
    check(near(im.getpixel((10, 25)), (255, 0, 0, 255), 3) and near(im.getpixel((90, 25)), (0, 0, 255, 255), 3), "content is preserved")
    page.get_by_role("button", name="Copy filename").click()
    check(clip(page) == "wide-100x50.png", f"copy filename -> {clip(page)}")
    # unlock ratio
    page.locator("button[title*='spect']").click()
    page.get_by_label("Width").fill("300")
    check(page.get_by_label("Height").input_value() == "50", "unlocked ratio keeps height")
    page.locator("button[title*='spect']").click()
    # JPEG flattening
    page.get_by_role("button", name="800 × 600").click()
    page.get_by_label("Format").select_option("image/jpeg")
    page.get_by_label("Background colour").wait_for()
    wait_render(page)
    name, data = download(page, lambda: page.get_by_role("button", name="Download", exact=True).click())
    im = img_of(data)
    check(im.format == "JPEG" and im.size == (800, 600) and name == "wide-800x600.jpg", f"jpeg export {name} {im.size} {im.format}")
    check(near(im.convert("RGB").getpixel((400, 5)), (255, 255, 255), 6), "contain leaves flatten colour in the margin")
    page.get_by_label("Fit").select_option("cover")
    wait_render(page)
    _, data = download(page, lambda: page.get_by_role("button", name="Download", exact=True).click())
    im = img_of(data).convert("RGB")
    check(near(im.getpixel((300, 5)), (255, 0, 0), 30) and near(im.getpixel((500, 595)), (0, 0, 255), 30), "cover fills the box (no margin)")
    check(near(im.getpixel((40, 300)), (255, 0, 0), 30) and near(im.getpixel((760, 300)), (0, 0, 255), 30), "cover keeps left red / right blue")
    # PNG contain keeps transparency
    page.get_by_label("Fit").select_option("contain")
    page.get_by_label("Format").select_option("image/png")
    wait_render(page)
    _, data = download(page, lambda: page.get_by_role("button", name="Download", exact=True).click())
    check(img_of(data).convert("RGBA").getpixel((400, 5))[3] == 0, "PNG contain margin stays transparent")
    page.get_by_label("Format").select_option("image/webp")
    wait_render(page)
    name, data = download(page, lambda: page.get_by_role("button", name="Download", exact=True).click())
    check(img_of(data).format == "WEBP" and name.endswith(".webp"), "webp export")
    # clear returns to dropzone
    page.get_by_role("button", name="Clear").click()
    check(page.get_by_text("Pick an image to start.").count() == 1, "clear resets")
    # non image rejected
    open(fpath("x.txt"), "w").write("hi")
    page.locator("input[type=file]").set_input_files({"name": "x.txt", "mimeType": "text/plain", "buffer": b"hi"})
    page.get_by_text("That is not an image file.").wait_for()
    check(True, "non-image rejected")


def t_scrub(page, fx):
    goto(page, "/tools/image-resize?tab=scrub")
    src = open(fx["exif_jpg"], "rb").read()
    check(b"SECRETCAMERAMAKE" in src and b"Exif" in src, "fixture JPEG really carries EXIF")
    upload(page, fx["exif_jpg"])
    page.get_by_label("Clean output format").select_option("image/jpeg")
    name, data = download(page, lambda: page.get_by_role("button", name="Re-encode and download").click())
    im = img_of(data)
    check(name == "exif-clean.jpg" and im.format == "JPEG" and im.size == (64, 48), f"clean jpeg {name} {im.size}")
    check(b"SECRETCAMERAMAKE" not in data and b"SECRETSOFTWARE" not in data and b"Exif" not in data, "EXIF is gone from output bytes")
    check(len(im.getexif()) == 0, "PIL sees no EXIF tags")
    check(near(im.convert("RGB").getpixel((10, 10)), (120, 80, 200), 6), "pixels preserved")
    page.get_by_text("Saved JPG without embedded source metadata.").wait_for()
    # PNG text chunks
    msrc = open(fx["meta_png"], "rb").read()
    check(b"SECRETAUTHOR" in msrc, "fixture PNG carries text chunks")
    upload(page, fx["meta_png"])
    page.get_by_label("Clean output format").select_option("image/png")
    name, data = download(page, lambda: page.get_by_role("button", name="Re-encode and download").click())
    im = img_of(data)
    check(name == "meta-clean.png" and im.format == "PNG", f"clean png {name}")
    check(b"SECRETAUTHOR" not in data and b"SECRETCOMMENT" not in data and not im.info.get("Author"), "PNG text chunks are gone")
    page.get_by_label("Clean output format").select_option("image/webp")
    name, data = download(page, lambda: page.get_by_role("button", name="Re-encode and download").click())
    check(img_of(data).format == "WEBP" and name == "meta-clean.webp", "webp clean output")


def t_responsive(page, fx):
    goto(page, "/tools/image-resize?tab=responsive")
    upload(page, fx["w1000"])
    page.get_by_label("Target widths", exact=False).fill("960, 320 640 2000 320 abc")
    page.get_by_role("button", name="Generate variants").click()
    page.get_by_text("320w ·").wait_for()
    rows = page.locator("text=/^\\d+w · /").all_inner_texts()
    check([r.split("w")[0] for r in rows] == ["320", "640", "960"], f"sorted, deduped, never upscaled -> {rows}")
    srcset = page.locator("pre").inner_text()
    check('320.webp 320w' in srcset and 'w1000-640.webp 640w' in srcset and "2000" not in srcset, "srcset text is correct")
    expected = {320: (320, 160), 640: (640, 320), 960: (960, 480)}
    for width, size in expected.items():
        row = page.get_by_text(f"{width}w ·").first.locator("xpath=..")
        name, data = download(page, lambda r=row: r.get_by_role("button", name="Download").click())
        im = img_of(data)
        check(im.format == "WEBP" and im.size == size and name == f"w1000-{width}.webp", f"{name} {im.size}")
    page.get_by_label("Target widths", exact=False).fill("5000")
    page.get_by_role("button", name="Generate variants").click()
    page.get_by_text("Enter widths between 1 and source width (1000px).").wait_for()
    check(page.locator("pre").count() == 0, "no srcset on error")


def t_favicon(page, fx):
    goto(page, "/tools/image-resize?tab=favicon")
    upload(page, fx["sq300"])
    page.get_by_role("button", name="Generate PNG icons").click()
    page.get_by_text("512 × 512 PNG").wait_for()
    for size in (16, 32, 48, 180, 512):
        row = page.get_by_text(f"{size} × {size} PNG", exact=True).locator("xpath=..")
        name, data = download(page, lambda r=row: r.get_by_role("button", name="Download").click())
        im = img_of(data)
        fmt = im.format
        im = im.convert("RGBA")
        check(fmt == "PNG" and im.size == (size, size) and name == f"icon-{size}.png", f"{name} {im.size}")
        check(near(im.getpixel((size // 2, size // 2)), (200, 30, 90, 255), 3), f"icon-{size} colour preserved")


# ---- SVG
def parse_xml_ok(s):
    try:
        minidom.parseString(s)
        return True
    except Exception:
        return False


def t_svg_optimize(page, fx):
    goto(page, "/tools/svg-optimize?tab=optimize")
    page.get_by_role("button", name="Optimize SVG").click()
    out = page.get_by_label("Optimized SVG")
    out.wait_for()
    o = out.input_value()
    check(parse_xml_ok(o) and "<!--" not in o and "metadata" not in o and "<circle" in o, f"default sample optimized: {o}")
    check("\n" not in o, "inter-tag whitespace removed")
    pct = page.get_by_text("Character reduction").locator("xpath=..").inner_text()
    check("%" in pct and not pct.strip().endswith("-0.0%") and "0.0%" not in pct.replace("Character reduction", ""), f"reduction stat {pct!r}")
    page.get_by_role("button", name="Copy optimized SVG").click()
    check(clip(page) == o, "copy button copies output")
    src = ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '
           'xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" inkscape:version="1.0" sodipodi:docname="a.svg" viewBox="0 0 10 10">\n'
           '  <!-- c -->\n  <g inkscape:label="L" id="g1">\n    <text><tspan>Hello</tspan> <tspan>World</tspan></text>\n  </g>\n</svg>')
    page.get_by_label("Input SVG").fill(src)
    page.get_by_role("button", name="Optimize SVG").click()
    page.wait_for_function("document.querySelector('textarea[readonly]')?.value.includes('Hello')")
    o = out.input_value()
    check(parse_xml_ok(o), "optimized XML is well-formed")
    check("inkscape:version" not in o and "inkscape:label" not in o and "sodipodi:docname" not in o, "editor attributes removed")
    check('id="g1"' in o and 'viewBox="0 0 10 10"' in o, "real attributes kept")
    check("<tspan>Hello</tspan> <tspan>World</tspan>" in o, "significant whitespace between tspans is preserved")
    page.get_by_label("Input SVG").fill("<svg><oops></svg>")
    page.get_by_role("button", name="Optimize SVG").click()
    page.get_by_text("Input must be well-formed SVG.").wait_for()
    check(page.get_by_label("Optimized SVG").count() == 0, "no output on invalid input")


def t_svg_sanitize(page, fx):
    goto(page, "/tools/svg-optimize?tab=sanitize")
    page.get_by_role("button", name="Sanitize and preview").click()
    clean = page.get_by_label("Cleaned SVG")
    clean.wait_for()
    c = clean.input_value()
    check("<script" not in c and "alert" not in c and "<rect" in c and "Safe preview" in c, "script removed, safe content kept")
    prev = page.get_by_role("img", name="Sanitized SVG preview")
    check(prev.count() == 1 and "image/svg+xml" in (prev.get_attribute("style") or ""), "preview element has an svg background")
    page.get_by_role("button", name="Copy cleaned SVG").click()
    check(clip(page) == c, "copy output")
    name, data = download(page, lambda: page.get_by_role("button", name="Download SVG").click())
    check(name == "sanitized.svg" and data.decode() == c, "download equals cleaned markup")
    evil = ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="x()">'
            '<foreignObject><div>hi</div></foreignObject><a href="javascript:alert(1)"><rect width="5" height="5" onclick="y()" fill="red"/></a>'
            '<use href="http://evil/x.svg#a"/><use href="#ok"/><image href="http://evil/i.png"/><style>@import url(http://evil)</style>'
            '<circle id="ok" r="2" style="fill:url(http://evil/x)" fill="blue"/></svg>')
    page.get_by_label("SVG markup").fill(evil)
    page.get_by_role("button", name="Sanitize and preview").click()
    page.wait_for_function("!document.querySelector('textarea[readonly]')?.value.includes('Safe preview')")
    c = clean.input_value()
    bad = ["onload", "onclick", "foreignObject", "javascript", "evil", "<image", "<style", "<a "]
    check(not any(b in c for b in bad), f"all dangerous constructs removed -> {c}")
    check('href="#ok"' in c and 'id="ok"' in c and 'fill="blue"' in c, "local href and safe attrs kept")
    page.get_by_label("SVG markup").fill("not svg")
    page.get_by_role("button", name="Sanitize and preview").click()
    page.get_by_text("Input must be a well-formed SVG document.").wait_for()
    check(True, "invalid input shows error")


def t_svg_png(page, fx):
    goto(page, "/tools/svg-optimize?tab=png")
    name, data = download(page, lambda: page.get_by_role("button", name="Rasterize and download").click())
    im = img_of(data).convert("RGBA")
    check(name == "vector.png" and im.size == (640, 240), f"default 640x240 png ({im.size})")
    check(im.getpixel((0, 0))[3] == 0, "rounded corner is transparent")
    check(near(im.getpixel((600, 200)), (0x76, 0x58, 0xE8, 255), 4), f"fill colour rendered {im.getpixel((600, 200))}")
    # white text pixels exist on the left
    check(any(p[0] > 240 and p[1] > 240 and p[2] > 240 and p[3] > 200 for p in im.crop((60, 80, 280, 160)).getdata()), "white 'Vector' text rendered")
    page.get_by_text("Exported 640 × 240 PNG from sanitized SVG.").wait_for()
    page.get_by_label("Output width (px)").fill("100")
    page.get_by_label("Output height (px)").fill("50")
    _, data = download(page, lambda: page.get_by_role("button", name="Rasterize and download").click())
    check(img_of(data).size == (100, 50), "custom size 100x50")
    page.get_by_label("SVG markup").fill('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>x()</script><rect width="10" height="10" fill="#00ff00"/></svg>')
    page.get_by_label("Output width (px)").fill("20")
    page.get_by_label("Output height (px)").fill("20")
    _, data = download(page, lambda: page.get_by_role("button", name="Rasterize and download").click())
    check(img_of(data).convert("RGBA").getpixel((10, 10)) == (0, 255, 0, 255), "green rect with script stripped rasterizes")
    page.get_by_label("SVG markup").fill("nope")
    page.get_by_role("button", name="Rasterize and download").click()
    page.get_by_text("Input must be a well-formed SVG document.").wait_for()
    check(True, "invalid SVG reports error and no download")


# ---- lottie
def stat_value(page, label):
    t = page.get_by_text(label, exact=True).locator("xpath=..").text_content() or ""
    return t.replace(label, "", 1).strip()


# ---- qr
def decode_qr(data):
    if cv2 is None:
        return None
    arr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    img = cv2.copyMakeBorder(img, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=255)
    txt, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
    return txt


def t_qr(page, fx):
    goto(page, "/tools/qr")
    page.locator("svg rect, svg path").first.wait_for()
    default = "https://github.com/GenorTG/samurai-knife"
    check(page.locator("main").get_by_text("Characters", exact=True).locator("xpath=..").inner_text().split()[-1] == str(len(default)), "characters stat")
    name, data = download(page, lambda: page.get_by_role("button", name="Download PNG").click())
    im = img_of(data)
    check(name == "qr-512.png" and im.size == (512, 512), f"png {name} {im.size}")
    if cv2 is not None:
        check(decode_qr(data) == default, f"PNG decodes back to the text ({decode_qr(data)!r})")
    else:
        print("skip qr decode (no cv2)")
    page.get_by_role("button", name="Copy SVG URI").click()
    uri = clip(page)
    svg = base64.b64decode(uri.split(",", 1)[1]).decode()
    check(uri.startswith("data:image/svg+xml;base64,") and parse_xml_ok(svg), "copied SVG URI decodes to valid SVG")
    if cv2 is not None:
        # render the copied svg via the page itself and decode the screenshot
        png = page.evaluate(
            """async (uri) => { const i = new Image(); i.src = uri; await i.decode(); const c = document.createElement('canvas'); c.width = 300; c.height = 300;
            const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0,0,300,300); x.drawImage(i, 0, 0, 300, 300); return c.toDataURL('image/png').split(',')[1]; }""", uri)
        check(decode_qr(base64.b64decode(png)) == default, "copied SVG URI also decodes to the text")
    # new text + size typed by hand (character by character)
    page.get_by_label("Text or URL").fill("HELLO WORLD 123 abc")
    size = page.get_by_label("Size", exact=True)
    size.fill("")
    size.press_sequentially("256")
    check(size.input_value() == "256", f"size can be typed digit by digit ({size.input_value()})")
    settle(page, 500)
    name, data = download(page, lambda: page.get_by_role("button", name="Download PNG").click())
    check(name == "qr-256.png" and img_of(data).size == (256, 256), f"size 256 -> {name} {img_of(data).size}")
    if cv2 is not None:
        check(decode_qr(data) == "HELLO WORLD 123 abc", "typed text round-trips")
    # error-correction levels change density
    bytes_by_level = {}
    for lv in ("L", "H"):
        page.get_by_label("Error correction").select_option(lv)
        settle(page, 450)
        bytes_by_level[lv] = int(page.get_by_text("SVG bytes").locator("xpath=..").inner_text().split()[-1])
    check(bytes_by_level["H"] > bytes_by_level["L"], f"H is denser than L {bytes_by_level}")
    # quiet zone
    page.get_by_label("Error correction").select_option("M")
    m = page.get_by_label("Quiet zone")
    m.fill("0")
    settle(page, 450)
    _, data = download(page, lambda: page.get_by_role("button", name="Download PNG").click())
    im = img_of(data).convert("L")
    check(im.getpixel((0, 0)) == 0, "quiet zone 0 -> finder pattern touches the corner")
    m.fill("4")
    settle(page, 450)
    _, data = download(page, lambda: page.get_by_role("button", name="Download PNG").click())
    check(img_of(data).convert("L").getpixel((0, 0)) == 255, "quiet zone 4 -> white corner")
    # too long
    page.get_by_label("Text or URL").fill("x" * 2100)
    settle(page, 500)
    check(page.get_by_text("is past what a QR code can hold").count() == 1, "too-long notice")
    check(page.get_by_role("button", name="Download PNG").is_disabled(), "no PNG when the library rejects the text")
    page.get_by_role("button", name="Clear").click()
    check(page.get_by_text("Type something above").count() == 1 and page.get_by_role("button", name="Download PNG").is_disabled(), "clear empties preview")


# ---- color
def hsl_ref(r, g, b):
    h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    return f"hsl({round(h * 360)} {round(s * 100)}% {round(l * 100)}%)"


def lum(r, g, b):
    f = lambda c: (c / 255 / 12.92) if c / 255 <= 0.04045 else (((c / 255) + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def ratio(rgb, other):
    a, b = lum(*rgb), lum(*other)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def kv(page, key):
    return page.locator("dt", has_text=key).locator("xpath=following-sibling::dd").first.inner_text()


def t_color(page, fx):
    goto(page, "/tools/color")
    inp = page.get_by_label("Any format the browser understands")
    check(kv(page, "HEX") == "#c9a227" and kv(page, "RGB") == "rgb(201 162 39)", "default hex -> rgb")
    check(kv(page, "HSL") == hsl_ref(201, 162, 39), f"hsl {kv(page, 'HSL')} vs {hsl_ref(201, 162, 39)}")
    check(kv(page, "Alpha") == "opaque", "opaque")
    onbg = ratio((201, 162, 39), (0x0A, 0x0A, 0x09))
    onink = ratio((201, 162, 39), (0xEC, 0xEB, 0xE7))
    check(stat_value(page, "On the dark bg").startswith(f"{onbg:.2f} : 1"), f"contrast on bg {stat_value(page, 'On the dark bg')} vs {onbg:.2f}")
    check(stat_value(page, "On the ink colour").startswith(f"{onink:.2f} : 1"), f"contrast on ink {stat_value(page, 'On the ink colour')} vs {onink:.2f}")
    inp.fill("#ff0000")
    check(kv(page, "RGB") == "rgb(255 0 0)" and kv(page, "HSL") == "hsl(0 100% 50%)", "red hsl")
    check(kv(page, "OKLCH") == "oklch(0.628 0.258 29)", f"red oklch {kv(page, 'OKLCH')}")
    inp.fill("#00ff00")
    check(kv(page, "OKLCH") == "oklch(0.866 0.295 142)", f"green oklch {kv(page, 'OKLCH')}")
    inp.fill("#000")
    check(stat_value(page, "On the dark bg").endswith("fails") and stat_value(page, "On the ink colour").endswith("AAA"), "black: fails on dark bg, AAA on ink")
    inp.fill("#fff")
    check(stat_value(page, "On the dark bg").endswith("AAA"), "white AAA on dark bg")
    check(f"{ratio((255, 255, 255), (0x0A, 0x0A, 0x09)):.2f} : 1" in stat_value(page, "On the dark bg"), "white contrast number")
    inp.fill("#ff000080")
    check(kv(page, "HEX") == "#ff000080" and kv(page, "Alpha") == "0.50", "8-digit hex alpha")
    inp.fill("rgb(0 128 255 / 50%)")
    check(kv(page, "HEX") == "#0080ff80" and kv(page, "Alpha") == "0.50", f"rgb with percent alpha ({kv(page, 'HEX')})")
    inp.fill("rgb(10%, 20%, 30%)")
    check(kv(page, "RGB") == "rgb(26 51 77)", f"rgb percentages ({kv(page, 'RGB')})")
    inp.fill("hsl(120 100% 25%)")
    check(kv(page, "HEX") == "#008000", f"hsl parse ({kv(page, 'HEX')})")
    inp.fill("hsl(240deg, 100%, 50%)")
    check(kv(page, "HEX") == "#0000ff", "hsl with deg and commas")
    def native_rgb(css):
        """Chrome's own OKLCH parser (canvas) is the oracle: independent of the tool's conversion matrices."""
        return page.evaluate("""(css) => { const c = document.createElement('canvas'); c.width = c.height = 1; const x = c.getContext('2d');
            x.fillStyle = css; x.fillRect(0, 0, 1, 1); return Array.from(x.getImageData(0, 0, 1, 1).data).slice(0, 3); }""", css)

    def hex_rgb():
        return [int(kv(page, "HEX")[i:i + 2], 16) for i in (1, 3, 5)]

    # (0.628 0.258 29) is NOT pure red: Chrome gives (255, 0, 3). The old "within 2 of (255, 0, 0)" only passed because the inverse
    # matrix had a wrong blue row (bug found 2026-10-10: oklch(1 0 0) rendered #fffec9).
    for css in ("oklch(0.628 0.258 29)", "oklch(62.8% 0.258 29)", "oklch(0.62796 0.25768 29.234)", "oklch(0.5 0 0)", "oklch(0.86644 0.29483 142.495)", "oklch(0.7 0.1 200)"):
        inp.fill(css)
        check(near(hex_rgb(), native_rgb(css), 1), f"oklch parse {css} -> {kv(page, 'HEX')} vs Chrome {native_rgb(css)}")
    inp.fill("oklch(1 0 0)")
    check(kv(page, "HEX") == "#ffffff", f"oklch white is white ({kv(page, 'HEX')})")
    inp.fill("oklch(0 0 0)")
    check(kv(page, "HEX") == "#000000", f"oklch black is black ({kv(page, 'HEX')})")
    inp.fill("rgb(300 -5 0)")
    check(kv(page, "HEX") == "#ff0000", f"out-of-range rgb is clamped to a valid hex ({kv(page, 'HEX')})")
    for bad in ("banana", "rgb(a b c)", "#12", "hsl(x 1% 2%)"):
        inp.fill(bad)
        settle(page, 300)
        check(page.get_by_text("is not hex, rgb(), hsl() or oklch().").count() == 1 and page.locator("dt", has_text="HEX").count() == 0, f"invalid {bad!r} -> error, no values")
    # tint ramp
    inp.fill("#c9a227")
    settle(page, 300)
    block = page.locator("pre").first.inner_text()
    lines = [l for l in block.splitlines() if "--knife-" in l]
    check(len(lines) == 9 and block.startswith(":root {") and block.rstrip().endswith("}"), "css block has 9 variables")
    check("--knife-05: #c9a227;" in lines[4], "middle step is the input colour")
    lumi = [lum(*[int(l.split("#")[1][i:i + 2], 16) for i in (0, 2, 4)]) for l in lines]
    check(all(lumi[i] > lumi[i + 1] for i in range(8)), "ramp goes monotonically light -> dark")
    check(page.locator("div[title^='#']").count() == 9, "9 ramp swatches")
    page.get_by_role("button", name="Copy CSS").click()
    check(clip(page) == block, "Copy CSS copies the block")
    # palette
    upload(page, fx["palette"])
    page.get_by_text("2 swatches").wait_for()
    hexes = page.locator("input[readonly]").evaluate_all("els => els.map(e => e.value)")
    check(sorted(hexes) == ["#0000ff", "#ff0000"], f"palette of a red/blue image -> {hexes}")


# ------------------------------------------------------------------ runner
TESTS = [
    ("image-crop/crop", t_crop), ("image-crop/trim", t_trim),
    ("image-compare", t_compare),
    ("image-resize/resize", t_resize), ("image-resize/scrub", t_scrub), ("image-resize/responsive", t_responsive),
    ("image-resize/favicon", t_favicon),
    ("svg-optimize/optimize", t_svg_optimize), ("svg-optimize/sanitize", t_svg_sanitize), ("svg-optimize/png", t_svg_png),
    ("qr", t_qr), ("color", t_color),
]

CLIP_STUB = "window.__clip = null; Object.defineProperty(navigator, 'clipboard', {value: {writeText: async (t) => { window.__clip = t; }}, configurable: true});"


def run_all(browser, fx, viewport, label):
    ctx = browser.new_context(viewport=viewport, accept_downloads=True)
    ctx.add_init_script(CLIP_STUB)
    narrow = viewport["width"] < 600
    for name, fn in TESTS:
        if os.environ.get("ONLY") and os.environ["ONLY"] not in name:
            continue
        CURRENT["name"] = f"{name}@{label}"
        page = ctx.new_page()
        problems: list[str] = []
        page.on("pageerror", lambda e, p=problems: p.append(f"pageerror: {e}"))
        page.on("console", lambda m, p=problems: m.type == "error" and p.append(f"console: {m.text[:200]}"))
        page.set_default_timeout(10000)
        t0 = time.time()
        try:
            fn(page, fx)
            if narrow:
                over = page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
                check(over <= 0, f"no horizontal overflow at 390px (overflow {over}px)")
        except Exception as exc:  # noqa: BLE001
            check(False, f"exception {type(exc).__name__}: {str(exc).splitlines()[0][:220]}")
            try:
                page.screenshot(path=os.path.join(TMP, f"fail_{name.replace('/', '_')}_{label}.png"))
            except Exception:  # noqa: BLE001
                pass
        check(not problems, f"zero console/page errors {problems[:3] if problems else ''}")
        print(f"     ({time.time() - t0:.1f}s)")
        page.close()
    ctx.close()


def main():
    fx = build_fixtures()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            run_all(browser, fx, {"width": 1280, "height": 900}, "1280")
            run_all(browser, fx, {"width": 390, "height": 800}, "390")
            browser.close()
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
    print()
    if FAILS:
        print(f"{len(FAILS)} FAILURE(S)")
        for f in FAILS:
            print("  -", f)
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
