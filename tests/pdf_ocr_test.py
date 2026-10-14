"""Real OCR worker integration: generated scans, Poppler text/raster oracles.

Run: ../samurai-knife-py/venv/bin/python tests/pdf_ocr_test.py
No live data, server or model needed. Requires pdftotext/pdftoppm (Poppler).
"""
from __future__ import annotations

import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server" / "py" / "scripts"))
import pdf_ocr  # noqa: E402

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
EN_LINES = [
    "Searchable document engineering report",
    "Every scanned page contains useful information.",
    "The quick brown fox jumps over the lazy dog.",
    "Local recognition preserves private documents.",
    "Reliable results need independent verification.",
    "Correct rotation makes this page easy to read.",
] * 4
PL_LINES = [
    "Polski dokument do rozpoznawania tekstu.",
    "Zażółć gęślą jaźń. Łódź, źródło, żółw i ćma.",
    "Wśród pól rośnie piękny dąb i śpiewają ptaki.",
    "Rzetelna próba sprawdza polskie litery.",
] * 6


def scan_pdf(path: Path, lines: list[str] | None = None, angle: float = 0) -> None:
    image = Image.new("RGB", (1800, 2400), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(FONT, 44)
    for index, line in enumerate(lines or EN_LINES):
        draw.text((110, 110 + index * 86), line, font=font, fill="black")
    if angle:
        image = image.rotate(angle, expand=True, fillcolor="white")
    image.save(path, "PDF", resolution=200)


def text_of(path: Path) -> str:
    return subprocess.check_output(["pdftotext", str(path), "-"], text=True)


def raster(path: Path, page: int = 1) -> Image.Image:
    data = subprocess.check_output([
        "pdftoppm", "-f", str(page), "-l", str(page), "-scale-to", "800",
        "-singlefile", "-png", str(path),
    ])
    with Image.open(io.BytesIO(data)) as image:
        return image.convert("L")


def residual_skew(image: Image.Image) -> float:
    """Independent projection-profile geometry, not an OCR engine's claim."""
    scores = []
    mono = image.point(lambda value: 0 if value < 150 else 255)
    for step in range(-12, 13):
        angle = step / 2
        rotated = mono.rotate(angle, fillcolor=255)
        data = rotated.tobytes()
        counts = [data[i:i + rotated.width].count(0) for i in range(0, len(data), rotated.width)]
        scores.append((sum(count * count for count in counts), angle))
    return max(scores)[1]


class OcrIntegration(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="knife-ocr-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "scan.pdf"
        scan_pdf(self.source)

    def request(self, params: object | None = None, files: list[Path] | None = None) -> dict:
        return {
            "action": "ocr", "params": {} if params is None else params,
            "files": [str(file) for file in (files if files is not None else [self.source])],
            "out_dir": str(self.root),
        }

    def run_worker(self, req: dict | None = None) -> dict:
        request = self.root / "request.json"
        response = self.root / "response.json"
        request.write_text(json.dumps(req or self.request()), encoding="utf-8")
        run = subprocess.run(
            [sys.executable, str(ROOT / "server/py/scripts/pdf_tool.py"), str(request), str(response)],
            capture_output=True, text=True, timeout=175,
        )
        result = json.loads(response.read_text())
        if result["ok"]:
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(result["mime"], "application/pdf")
            self.assertGreater(result["bytes"], 0)
        return result

    def output(self, req: dict | None = None) -> Path:
        result = self.run_worker(req)
        self.assertTrue(result["ok"], result.get("error"))
        return self.root / result["file"]

    def test_default_searchable_english_pdf(self) -> None:
        self.assertFalse(text_of(self.source).strip(), "fixture must be image-only")
        output = self.output()
        self.assertIn("Searchable document engineering report", text_of(output))
        self.assertEqual(len(PdfReader(output).pages), 1)

    def test_sideways_scan_rotates_to_portrait(self) -> None:
        scan_pdf(self.source, angle=90)
        self.assertGreater(raster(self.source).width, raster(self.source).height)
        output = self.output()
        self.assertIn("Correct rotation makes this page easy to read", text_of(output))
        result = raster(output)
        self.assertLess(result.width, result.height)

    def test_deskew_really_corrects_image_geometry(self) -> None:
        scan_pdf(self.source, angle=4)
        self.assertGreater(abs(residual_skew(raster(self.source))), 3)
        output = self.output()
        self.assertIn("Local recognition preserves private documents", text_of(output))
        self.assertLessEqual(abs(residual_skew(raster(output))), 0.5)

    def test_polish_diacritics_and_bilingual_language(self) -> None:
        scan_pdf(self.source, PL_LINES)
        output = self.output(self.request({"language": "pol"}))
        self.assertIn("Zażółć gęślą jaźń", text_of(output))
        self.assertIn("Łódź", text_of(output))
        scan_pdf(self.source, PL_LINES[:12] + EN_LINES[:12])
        output = self.output(self.request({"language": "eng+pol"}))
        recognized = text_of(output)
        self.assertIn("Zażółć gęślą jaźń", recognized)
        self.assertIn("Searchable document engineering report", recognized)

    def test_mixed_pdf_preserves_digital_page_and_ocrs_scan(self) -> None:
        digital = self.root / "digital.pdf"
        doc = canvas.Canvas(str(digital))
        doc.drawString(70, 700, "Digital original 012345 - must remain vector text")
        doc.setStrokeColorRGB(1, 0, 0)
        doc.rect(65, 680, 400, 55)
        doc.save()
        writer = PdfWriter()
        writer.append(digital)
        writer.append(self.source)
        mixed = self.root / "mixed.pdf"
        writer.write(mixed)
        output = self.output(self.request(files=[mixed]))
        before = PdfReader(mixed).pages[0]
        after = PdfReader(output).pages[0]
        self.assertEqual(before.extract_text(), after.extract_text())
        self.assertEqual(before.get_contents().get_data(), after.get_contents().get_data())
        self.assertEqual(raster(mixed).tobytes(), raster(output).tobytes())
        self.assertEqual(len(PdfReader(output).pages), 2)
        self.assertIn("Searchable document engineering report", text_of(output))

    def test_disabled_image_processing_preserves_scan_pixels(self) -> None:
        output = self.output(self.request({"deskew": False, "rotatePages": False}))
        self.assertEqual(raster(self.source).tobytes(), raster(output).tobytes())
        self.assertIn("Searchable document engineering report", text_of(output))

    def test_invalid_parameters_files_and_limits(self) -> None:
        cases = [
            (self.request({"language": "fra"}), "language"),
            (self.request({"language": ["eng"]}), "language"),
            (self.request({"deskew": "true"}), "booleans"),
            (self.request({"rotatePages": 1}), "booleans"),
            (self.request({"force_ocr": True}), "accepts only"),
            (self.request(params=[]), "JSON object"),
            (self.request(files=[]), "exactly one"),
            (self.request(files=[self.source, self.source]), "exactly one"),
        ]
        for request, message in cases:
            with self.subTest(request=request):
                result = self.run_worker(request)
                self.assertFalse(result["ok"])
                self.assertIn(message, result["error"])
        self.source.write_bytes(b"not a pdf")
        self.assertIn("readable PDF", self.run_worker()["error"])
        writer = PdfWriter()
        for _ in range(21):
            writer.add_blank_page(width=600, height=800)
        writer.write(self.source)
        self.assertIn("1–20 pages", self.run_worker()["error"])
        with self.source.open("wb") as handle:
            handle.truncate(pdf_ocr.MAX_BYTES + 1)
        self.assertIn("50 MB", self.run_worker()["error"])

    def test_encrypted_input_is_actionable(self) -> None:
        writer = PdfWriter(clone_from=self.source)
        writer.encrypt("synthetic-password")
        protected = self.root / "protected.pdf"
        writer.write(protected)
        result = self.run_worker(self.request(files=[protected]))
        self.assertFalse(result["ok"])
        self.assertIn("Unlock", result["error"])

    def test_missing_dependency_and_language_errors(self) -> None:
        with patch.object(pdf_ocr.shutil, "which", return_value=None):
            with self.assertRaisesRegex(pdf_ocr.OcrError, "Tesseract on PATH"):
                pdf_ocr.ocr_environment("eng", True)
        with patch.object(pdf_ocr.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "eng\nosd\n")):
            with self.assertRaisesRegex(pdf_ocr.OcrError, "missing language data: pol"):
                pdf_ocr.ocr_environment("pol", True)

    def test_inner_timeout_gives_split_guidance(self) -> None:
        # The real CLI process is started, then timed out before it can OCR.
        with patch.object(pdf_ocr, "OCR_TIMEOUT_SECONDS", 0.01):
            with self.assertRaisesRegex(pdf_ocr.OcrError, "Split the PDF"):
                pdf_ocr.ocr_pdf(self.request())
        self.assertEqual(list(self.root.glob("ocr-*")), [], "intermediates must be removed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
