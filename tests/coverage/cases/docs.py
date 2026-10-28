"""Docs group: pdf, text, diff, markdown, characters, placeholder-text."""
import base64
import io
import re
import unicodedata

from tests.coverage.core import Case, Ctx, first_error, has, matches, used
from tests.coverage.fixtures import b64, make_pdf

GROUP = "docs"
SKIPS: dict[tuple[str, str | None], str] = {
    ("office", None): "editing happens in a cross-origin iframe served by a docker sidecar the coverage server does not install; library + knife_doc_* tools are covered by tests/office_e2e.py",
    ("sidecars", None): "installs and starts docker containers on the host (real side effects, ~5 GB pull); covered by tests/office_e2e.py",
    **{("artcraft", app): "an iframe of a cross-origin WebAssembly app served by the craft docker sidecar the coverage server does not install; covered by tests/craft_e2e.py"
       for app in ("photocraft", "vectorcraft", "filmcraft", "lightcraft", "effectcraft", "designcraft", "pdfcraft", "figcraft", "wordcraft", "soundcraft", "deckcraft", "cadcraft", "gridcraft")},
    ("db-course", "sql"): "needs the learn-db docker sidecar (PostgreSQL + PostGIS) the coverage server does not install; the page flow, every lesson and the tutor tools are covered by tests/learn_db_e2e.py",
}

_TEXT = "Samurai Knife 侍"
_PDF = make_pdf([f"Page {i}" for i in range(1, 8)])


# ---- batch-rename:rename (find/replace, then prefix + stem + suffix + ext; ext = after LAST dot)


# ---- batch-rename:normalize


# ---- batch-rename:manifest


# ---- text:wrap


# ---- text:quotes

# ---- file-compressor

# ---- characters
_CH = "cafe\u0301 \U0001F469\u200d\U0001F4BB \U0001F1F5\U0001F1F1"
_CH_CP, _CH_B8 = len(_CH), len(_CH.encode())
# The prompt carries e + U+0301, but models re-encode it as precomposed é in their own tool arguments (the stored user
# message still holds U+0301): that is the provider, not the app. Accept the counts of either form, graphemes are 8 in both.
_CH_NFC = unicodedata.normalize("NFC", _CH)
_CH_COUNTS = {(len(_CH), len(_CH.encode())), (len(_CH_NFC), len(_CH_NFC.encode()))}


def _chars(c: Ctx):
    num = lambda n: re.search(rf"(?<![\d.]){n}(?![\d.])", c.answer) is not None  # noqa: E731
    if not num(_CH_GR):
        return f"grapheme count {_CH_GR} not in the answer"
    return None if any(num(cp) and num(b8) for cp, b8 in _CH_COUNTS) else f"code points/bytes not one of {sorted(_CH_COUNTS)}"
_CH_GR = 8  # c a f (e+U+0301) space (woman ZWJ laptop) space (PL flag)
_ENC = b"\xff\xfe" + "Za\u017c\u00f3\u0142\u0107 gotowe\r\n".encode("utf-16-le")


def _scan_pdf() -> bytes:
    # Small grayscale JPEG-in-PDF (~5 KB): the model has to copy the base64 by hand. A 1-bit scan would be smaller
    # but the PDF editor's OCR returns nothing for it (see the coverage report), and a Flate page is hundreds of KB.
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("L", (430, 110), 255)
    ImageDraw.Draw(img).text((16, 30), "SAMURAI SWORD", fill=0,
                             font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 42))
    buf = io.BytesIO()
    img.save(buf, "PDF", resolution=150, quality=30)
    return buf.getvalue()


_SCAN = _scan_pdf()


def _ph_oracle(c: Ctx):
    """The text must be ON THE PAGE (4 paragraphs, lorem) and the word count the agent states must be that text's real count."""
    paras = [v for v in c.values() if len(v.split("\n\n")) == 4 and v.lower().startswith("lorem")]
    if not paras:
        return "no 4-paragraph lorem text on page"
    n = len(paras[0].split())
    return None if re.search(rf"(?<![\d.]){n}(?![\d.])", c.answer) else f"answer does not state the page text's word count {n}"


def used_pct(c: Ctx, expected: float, tol: float = 4.0) -> str | None:
    nums = [float(x) for x in re.findall(r"(\d{1,3}(?:\.\d+)?)\s*%", c.haystack())]
    return None if any(abs(n - expected) <= tol for n in nums) else f"no percentage within {tol} of {expected:.1f}: {nums[:5]}"

CASES = [
    Case("text", "kit", f"I need the base64 encoding of this text, exactly as written: {_TEXT}",
         lambda c: has(c.haystack(), base64.b64encode(_TEXT.encode()).decode())),
    Case("diff", None,
         "Compare these two versions of a file and tell me how many lines were added and how many were removed.\n\n"
         "BEFORE:\nalpha\nbeta\ngamma\ndelta\nepsilon\n\nAFTER:\nalpha\nBETA2\nnew1\nnew2\ngamma\nepsilon\n",
         lambda c: first_error(matches(c.answer, r"3[^.\n]{0,40}add|add[^.\n]{0,40}3|\+\s*3"),
                               matches(c.answer, r"2[^.\n]{0,40}remov|remov[^.\n]{0,40}2|-\s*2"))),
    Case("pdf", "tools",
         "I have a PDF called report.pdf (base64 below). How many pages does it have?\n\n" + b64(_PDF),
         lambda c: first_error(matches(c.answer, r"\b7\b|seven"), None if used(c, "upload_file") else "never attached the file")),

    Case("pdf", "editor",
         "The attached scan.pdf is a scanned page (just a picture, no text layer). Read what it says and tell me the text.\n\nscan.pdf (base64):\n" + b64(_SCAN),
         lambda c: first_error(matches(c.answer, r"SAMURAI\W+SWORD"), None if used(c, "upload_file") else "never attached the file"),
         timeout_ms=360000),
    Case("markdown", "preview",
         "Convert this HTML snippet into Markdown (headings with #, bold with **, links as [text](url), bullet lists with -):\n\n"
         '<h2>Release <em>notes</em></h2><p>See the <a href="https://example.org/x">changelog</a> and <strong>upgrade</strong> soon.</p><ul><li>one</li><li>two</li></ul>',
         lambda c: first_error(
             matches(c.haystack(), r"^## Release [*_]notes[*_]\s*$".replace("^", "(?m)^")),
             has(c.haystack(), "[changelog](https://example.org/x)", "**upgrade**", "- one", "- two"))),
    Case("characters", "characters",
         f"How many user-perceived characters (graphemes), Unicode code points and UTF-8 bytes does this text contain? Text: {_CH}",
         _chars),
    Case("characters", "encoding",
         "This file, notes.txt (base64), shows up as gibberish in my editor. What text encoding is it, and does it start with a byte order mark?\n\n" + b64(_ENC),
         lambda c: first_error(matches(c.answer, r"UTF-?16[\s-]*(LE|little)|little[\s-]*endian"),
                               matches(c.answer, r"BOM|byte[\s-]order"), None if used(c, "upload_file") else "never attached the file")),
    Case("text", "generate",
         "Generate 4 paragraphs of lorem ipsum filler text for a mockup, keep the generated text on screen so I can copy it, and tell me the total word count.",
         _ph_oracle),
]
