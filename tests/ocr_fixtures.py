"""Deterministic OCR fixtures: a scanned-looking PNG and a one-page image-only PDF of a paragraph with known words.

  python3 tests/ocr_fixtures.py <out_dir> [pages]   # writes scan.png (page 1), scan.pdf, truth.txt

Text is rendered at 150 dpi on an A4 sheet, rotated slightly and given sensor noise, so the only way to
read it is OCR (the PDF has no text layer). `truth.txt` is the independent oracle for word accuracy.
"""
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

TRUTH = (
    "Invoice 2048 was issued to Northwind Traders on 14 March 2026 for the sum of $1,250.75. "
    "Payment is due within 30 days, and late fees of 1.5% apply after that. "
    "Please quote reference KX-7731 on every transfer, otherwise the finance team cannot match it. "
    "The warehouse in Gdansk shipped 48 crates, 12 pallets and 3 containers last week; "
    "two of them arrived damaged, so a claim has been filed with the carrier. "
    "Questions? Contact Alice Johnson at the accounts desk, extension 5509, before Friday."
)
DPI = 150
PAGE = (round(8.27 * DPI), round(11.69 * DPI))  # A4
FONTS = [
    "/usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
]


def _font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONTS:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def _wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, width: int) -> list[str]:
    lines: list[str] = []
    line = ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=font) <= width:
            line = trial
        else:
            lines.append(line)
            line = word
    return lines + [line]


def _page(text: str, rng: random.Random) -> Image.Image:
    sheet = Image.new("L", PAGE, 250)
    draw = ImageDraw.Draw(sheet)
    font = _font(round(12 * DPI / 72))  # 12 pt
    margin = round(0.9 * DPI)
    y = margin
    for line in _wrap(draw, text, font, PAGE[0] - 2 * margin):
        draw.text((margin, y), line, fill=25, font=font)
        y += round(font.size * 1.6)
    sheet = sheet.rotate(0.6, resample=Image.Resampling.BICUBIC, fillcolor=250).filter(ImageFilter.GaussianBlur(0.6))
    px = sheet.load()
    assert px is not None
    for _ in range(PAGE[0] * PAGE[1] // 40):
        x, yy = rng.randrange(PAGE[0]), rng.randrange(PAGE[1])
        px[x, yy] = max(0, min(255, px[x, yy] + rng.randint(-45, 25)))
    return sheet


def build(out: Path, seed: int = 7, pages: int = 1) -> dict[str, Path]:
    """Page k carries the paragraph with invoice number 2048+k and reference KX-(7731+k), so pages differ."""
    rng = random.Random(seed)
    out.mkdir(parents=True, exist_ok=True)
    texts = [TRUTH.replace("2048", str(2048 + k)).replace("7731", str(7731 + k)) if k else TRUTH for k in range(pages)]
    sheets = [_page(t, rng) for t in texts]
    paths = {"png": out / "scan.png", "pdf": out / "scan.pdf", "truth": out / "truth.txt"}
    sheets[0].save(paths["png"], dpi=(DPI, DPI))
    rgb = [s.convert("RGB") for s in sheets]
    rgb[0].save(paths["pdf"], "PDF", resolution=DPI, save_all=True, append_images=rgb[1:])
    paths["truth"].write_text("\n".join(texts) + "\n", encoding="utf-8")
    return paths


if __name__ == "__main__":
    made = build(Path(sys.argv[1] if len(sys.argv) > 1 else "."), pages=int(sys.argv[2]) if len(sys.argv) > 2 else 1)
    print({k: str(v) for k, v in made.items()})
