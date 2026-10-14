"""Docs group: pdf, text, diff, markdown, file-compressor, characters, batch-rename, placeholder-text."""
import base64
import io
import random
import re
import unicodedata
import zlib

from tests.coverage.core import Case, Ctx, first_error, has, matches, used
from tests.coverage.fixtures import b64, make_pdf

GROUP = "docs"
SKIPS: dict[tuple[str, str | None], str] = {
    ("office", None): "editing happens in a cross-origin iframe served by a docker sidecar the coverage server does not install; library + knife_doc_* tools are covered by tests/office_e2e.py",
    ("sidecars", None): "installs and starts docker containers on the host (real side effects, ~5 GB pull); covered by tests/office_e2e.py",
}

_TEXT = "Samurai Knife 侍"
_PDF = make_pdf([f"Page {i}" for i in range(1, 8)])



def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def _all_in(hay: str, items) -> str | None:
    miss = [i for i in items if i not in hay]
    return None if not miss else f"missing: {miss[:3]}"


def _readonly_text(c: Ctx) -> str:
    values = c.page.evaluate("Array.from(document.querySelectorAll('main textarea[readonly], main input[readonly]')).map(el => el.value)")
    return "\n".join(values)


# ---- batch-rename:rename (find/replace, then prefix + stem + suffix + ext; ext = after LAST dot)
_REN_IN = ["IMG_0042.jpg", "IMG_0043.final.PNG", "holiday-0042.jpg", "notes IMG_7.txt"]


def _rename(names, find, repl, prefix, suffix):
    out = []
    for n in names:
        r = n.replace(find, repl)
        d = r.rfind(".")
        stem, ext = (r[:d], r[d:]) if d > 0 else (r, "")
        out.append(f"{prefix}{stem}{suffix}{ext}")
    return out


_REN_OUT = _rename(_REN_IN, "IMG_", "holiday-", "2024-", "_final")

# ---- batch-rename:normalize
_RESERVED = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$", re.I)


def _normalize_name(n: str) -> str:
    n = unicodedata.normalize("NFKC", n)
    n = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", n)
    n = re.sub(r"\s+", " ", n).strip()
    n = re.sub(r"[. ]+$", "", n)
    if not n or n in (".", ".."):
        n = "_"
    if _RESERVED.match(n):
        n = "_" + n
    return n


_NORM_IN = ["\uff32eport\uff1a Q3/Q4 *draft*.docx", "con.txt", "holiday   pics...", "\ufb01le\u2116 1.txt"]
_NORM_OUT = [_normalize_name(n) for n in _NORM_IN]

# ---- batch-rename:manifest
_MAN_A = {"src/app.ts": "9f2c", "public/logo.svg": "41ab", "docs/guide.md": "c0de", "lib/util.js": "7777", "config/prod.yml": "e1e1"}
_MAN_B = {"src/app.ts": "9f2c", "public/logo.svg": "42ff", "lib/util.js": "7777", "config/prod.yml": "e1e2", "src/new/index.ts": "0abc", "README.md": "5151"}
_MAN_EXP = ([f"ADDED {p}" for p in _MAN_B if p not in _MAN_A] + [f"REMOVED {p}" for p in _MAN_A if p not in _MAN_B]
            + [f"CHANGED {p}" for p in _MAN_B if p in _MAN_A and _MAN_A[p] != _MAN_B[p]])


def _man_sections_ok(answer: str):
    """Each path must sit in its own category: split the reply at the added/removed/changed words and check membership."""
    low = answer.lower()
    idx = {w: low.find(w) for w in ("added", "removed", "changed")}
    if min(idx.values()) < 0:
        return "reply does not name all three categories"
    order = sorted(idx, key=idx.get)
    spans = {}
    for i, w in enumerate(order):
        spans[w] = low[idx[w]:idx[order[i + 1]] if i + 1 < len(order) else len(low)]
    want = {"added": [p for p in _MAN_B if p not in _MAN_A], "removed": [p for p in _MAN_A if p not in _MAN_B],
            "changed": [p for p in _MAN_B if p in _MAN_A and _MAN_A[p] != _MAN_B[p]]}
    for w, paths in want.items():
        for p in paths:
            if p.lower() not in spans[w]:
                return f"{p} not listed under {w}"
    return None

# ---- text:wrap
def _wrap_line(line: str, width: int) -> str:
    out, cur = [], ""
    for w in line.split():
        if cur and len(cur) + 1 + len(w) > width:
            out.append(cur)
            cur = ""
        if not cur and len(w) > width:
            out += [w[i:i + width] for i in range(0, len(w), width)]
        else:
            cur = f"{cur} {w}" if cur else w
    if cur:
        out.append(cur)
    return "\n".join(out)


_WRAP_IN = "The shogun ordered the blacksmith to forge a blade lighter than silk and sharper than winter wind.\n\nSerial number SAMURAI-KNIFE-ULTRALONGIDENTIFIER-0042"
_WRAP_OUT = "\n".join(_wrap_line(l, 30) for l in _WRAP_IN.split("\n"))

# ---- text:quotes
_QUOTE_IN = "\"Don't go,\" she said -- it's 1990-1995 and the dog's \"happy\"."
_QUOTE_OUT = "\u201cDon\u2019t go,\u201d she said \u2014 it\u2019s 1990\u20131995 and the dog\u2019s \u201chappy\u201d."

# ---- file-compressor
_LOG = "".join(f"2024-03-{(i % 28) + 1:02d} INFO worker-{i % 7} processed batch {i * 37 % 1000} ok\n" for i in range(150)).encode()
_LOG_SAVED = (1 - len(zlib.compress(_LOG, 6)) / len(_LOG)) * 100

# ---- characters
_CH = "cafe\u0301 \U0001F469\u200d\U0001F4BB \U0001F1F5\U0001F1F1"
_CH_CP, _CH_B8 = len(_CH), len(_CH.encode())
_CH_GR = 8  # c a f (e+U+0301) space (woman ZWJ laptop) space (PL flag)
_ENC = b"\xff\xfe" + "Za\u017c\u00f3\u0142\u0107 gotowe\r\n".encode("utf-16-le")


def _hex_blob() -> bytes:
    rnd = random.Random(7)
    b = bytearray(rnd.choice([0, *range(0x80, 0x100)]) for _ in range(96))
    b[0x2B:0x2B + 11] = b"KATANA-v2.7"
    return bytes(b)


_HEX = _hex_blob()


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

    Case("batch-rename", "rename",
         "I'm renaming photo files in bulk. In each name replace the text \"IMG_\" with \"holiday-\", then put \"2024-\" at the front and \"_final\" "
         "right before the file extension (the extension is whatever follows the last dot). Show me the new name for each, and tell me if any two end up with the same name.\n\n"
         + "\n".join(_REN_IN),
         lambda c: first_error(_all_in(c.haystack(), _REN_OUT),
                               matches(c.answer, r"collision|conflict|duplicate|same name|identical|clash"))),
    Case("batch-rename", "normalize",
         "Make these file names safe for both Windows and Linux. Apply Unicode compatibility normalization (NFKC), replace the characters < > : \" / \\ | ? * with an underscore, "
         "collapse runs of whitespace into one space, strip trailing dots and spaces, and prefix Windows reserved device names (like CON) with an underscore. "
         "Give me the cleaned list, one per line:\n\n" + "\n".join(_NORM_IN),
         lambda c: _all_in(c.haystack(), _NORM_OUT)),
    Case("batch-rename", "manifest",
         "Here are two file manifests (path, two spaces, hash), the old one and the new one. Which paths were added, removed, and which have a changed hash?\n\n"
         "OLD:\n" + "\n".join(f"{p}  {h}" for p, h in _MAN_A.items()) + "\n\nNEW:\n" + "\n".join(f"{p}  {h}" for p, h in _MAN_B.items()),
         lambda c: first_error(
             _all_in(c.answer, [e.split(" ", 1)[1] for e in _MAN_EXP]),
             _man_sections_ok(c.answer))),
    Case("pdf", "editor",
         "The attached scan.pdf is a scanned page (just a picture, no text layer). Read what it says and tell me the text.\n\nscan.pdf (base64):\n" + b64(_SCAN),
         lambda c: first_error(matches(c.answer, r"SAMURAI\W+SWORD"), None if used(c, "upload_file") else "never attached the file"),
         timeout_ms=360000),
    Case("text", "wrap",
         "Reflow this text so no line is longer than 30 characters: break only between words, but split any single word that is itself longer than 30 characters "
         "into 30-character chunks. Keep the blank line between the two paragraphs. Give me the result.\n\n" + _WRAP_IN,
         lambda c: None if _WRAP_OUT in c.page_only() or _WRAP_OUT in c.answer else first_error(
             _all_in(c.haystack(), _WRAP_OUT.split("\n")), "wrapped text not exact")),
    Case("text", "quotes",
         "Typeset this sentence properly: convert the straight double and single quotes to curly typographic quotes and apostrophes, turn the spaced double hyphen into an em dash, "
         "and use an en dash in the number range. Reply with just the finished sentence.\n\n" + _QUOTE_IN,
         lambda c: has(c.haystack(), _QUOTE_OUT)),
    Case("markdown", "preview",
         "Convert this HTML snippet into Markdown (headings with #, bold with **, links as [text](url), bullet lists with -):\n\n"
         '<h2>Release <em>notes</em></h2><p>See the <a href="https://example.org/x">changelog</a> and <strong>upgrade</strong> soon.</p><ul><li>one</li><li>two</li></ul>',
         lambda c: first_error(
             matches(c.haystack(), r"^## Release [*_]notes[*_]\s*$".replace("^", "(?m)^")),
             has(c.haystack(), "[changelog](https://example.org/x)", "**upgrade**", "- one", "- two"))),
    Case("markdown", "organize",
         "Tidy this Markdown document: a heading may only go one level deeper than the previous one (fix jumps), use '-' for all bullets, renumber ordered lists from 1, "
         "and add a table of contents with links right after the title. Give me the cleaned Markdown.\n\n"
         "# Guide\n#### Deep dive\n* alpha\n+ beta\n3. one\n3. two\n",
         lambda c: first_error(
             has(c.haystack(), "## Deep dive", "- alpha", "- beta", "1. one", "2. two", "(#deep-dive)"),
             None if "#### Deep dive" not in _readonly_text(c) else "heading jump not fixed in output",
             None if "* alpha" not in _readonly_text(c) and "+ beta" not in _readonly_text(c) else "bullets not normalised in output")),
    Case("file-compressor", None,
         "Please gzip this log file (report.log, base64 below). Tell me what the compressed file is named and by what percentage it shrank.\n\n" + b64(_LOG),
         lambda c: first_error(
             has(c.haystack(), "report.log.gz"),
             used_pct(c, _LOG_SAVED),
             None if used(c, "upload_file") else "never attached the file")),
    Case("characters", "characters",
         f"How many user-perceived characters (graphemes), Unicode code points and UTF-8 bytes does this text contain? Text: {_CH}",
         lambda c: first_error(*[matches(c.answer, rf"(?<![\d.]){n}(?![\d.])") for n in (_CH_GR, _CH_CP, _CH_B8)])),
    Case("characters", "encoding",
         "This file, notes.txt (base64), shows up as gibberish in my editor. What text encoding is it, and does it start with a byte order mark?\n\n" + b64(_ENC),
         lambda c: first_error(matches(c.answer, r"UTF-?16[\s-]*(LE|little)|little[\s-]*endian"),
                               matches(c.answer, r"BOM|byte[\s-]order"), None if used(c, "upload_file") else "never attached the file")),
    Case("characters", "hex",
         "There's a human-readable marker string hidden inside this binary file, blob.bin (base64). What is the string and at which byte offset (in hex) does it start?\n\n" + b64(_HEX),
         lambda c: first_error(has(c.answer, "KATANA-v2.7"), matches(c.answer, r"0x0*2b\b|\b0*2b\b|\b43\b"),
                               None if used(c, "upload_file") else "never attached the file")),
    Case("placeholder-text", None,
         "Generate 4 paragraphs of lorem ipsum filler text for a mockup, keep the generated text on screen so I can copy it, and tell me the total word count.",
         _ph_oracle),
]
