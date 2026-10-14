"""Bounded, local searchable-PDF conversion; never force-rasterize text pages."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from pypdf import PdfReader

MAX_BYTES = 50 * 1024 * 1024
MAX_PAGES = 20
# Leave headroom for preflight, process-group cleanup and response delivery within
# the route's 180-second budget. Queue wait does not count against that budget.
OCR_TIMEOUT_SECONDS = 150
LANGUAGES = ("eng", "pol", "eng+pol")


class OcrError(ValueError):
    """An actionable OCR failure safe to return to the caller."""


def validate_request(req: dict) -> tuple[Path, str, bool, bool]:
    files = req.get("files")
    if not isinstance(files, list) or len(files) != 1:
        raise OcrError("OCR needs exactly one PDF.")
    params = req.get("params", {})
    if not isinstance(params, dict):
        raise OcrError("OCR params must be a JSON object.")
    if set(params) - {"language", "deskew", "rotatePages"}:
        raise OcrError("OCR accepts only language, deskew and rotatePages parameters.")
    language = params.get("language", "eng")
    if language not in LANGUAGES:
        raise OcrError("OCR language must be eng, pol or eng+pol.")
    deskew = params.get("deskew", True)
    rotate = params.get("rotatePages", True)
    if not isinstance(deskew, bool) or not isinstance(rotate, bool):
        raise OcrError("OCR deskew and rotatePages must be booleans.")
    source = Path(files[0])
    if not source.is_file():
        raise OcrError("The input PDF is missing. Upload it again.")
    if source.stat().st_size > MAX_BYTES:
        raise OcrError("OCR supports PDFs up to 50 MB. Split or reduce the scan first.")
    try:
        reader = PdfReader(source)
        if reader.is_encrypted:
            raise OcrError("Unlock this password-protected PDF before running OCR.")
        pages = len(reader.pages)
    except OcrError:
        raise
    except Exception as exc:
        raise OcrError("The file is not a readable PDF. Export it as a PDF and try again.") from exc
    if not 1 <= pages <= MAX_PAGES:
        raise OcrError("OCR supports 1–20 pages per job. Use Extract or Split for a longer PDF.")
    return source, language, deskew, rotate


def ocr_environment(language: str, rotate: bool) -> dict[str, str]:
    if importlib.util.find_spec("ocrmypdf") is None:
        raise OcrError("Server OCR is not installed. Install server/py/requirements.txt in the PDF worker venv.")
    if not shutil.which("tesseract"):
        raise OcrError("Server OCR needs Tesseract on PATH. Install Tesseract with eng, pol and osd language data.")
    env = os.environ.copy()
    local_data = Path(sys.prefix) / "share" / "knife-tessdata"
    if "TESSDATA_PREFIX" not in env and local_data.is_dir():
        env["TESSDATA_PREFIX"] = str(local_data)
    # A single heavy queue job must not consume every host CPU.
    env["OMP_THREAD_LIMIT"] = "1"
    try:
        probe = subprocess.run(
            ["tesseract", "--list-langs"], env=env, capture_output=True,
            text=True, timeout=5, check=True,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise OcrError("Tesseract could not load its language data. Run server/py/setup_ocr.py with the PDF worker Python.") from exc
    available = set(probe.stdout.splitlines())
    required = set(language.split("+")) | ({"osd"} if rotate else set())
    missing = required - available
    if missing:
        raise OcrError(
            f"Server OCR is missing language data: {', '.join(sorted(missing))}. "
            "Run server/py/setup_ocr.py with the PDF worker Python."
        )
    return env


def ocr_pdf(req: dict) -> dict:
    source, language, deskew, rotate = validate_request(req)
    env = ocr_environment(language, rotate)
    out_dir = Path(req["out_dir"])
    name = f"{source.stem}-searchable.pdf"
    target = out_dir / name
    # Keep all OCR intermediate files under the existing job-owned output dir.
    # Node kills this entire inherited process group on cancel/timeout, then
    # deletes the directory. Do NOT start a new subprocess session here.
    with tempfile.TemporaryDirectory(prefix="ocr-", dir=out_dir) as scratch:
        env["TMPDIR"] = scratch
        command = [
            sys.executable, "-m", "ocrmypdf", "--mode", "skip",
            "--output-type", "pdf", "--optimize", "0", "--jobs", "2",
            "--rasterizer", "pypdfium", "--max-image-mpixels", "40",
            "--tesseract-timeout", str(OCR_TIMEOUT_SECONDS),
            "--tesseract-non-ocr-timeout", str(OCR_TIMEOUT_SECONDS),
            "--language", language,
        ]
        if deskew:
            command.append("--deskew")
        if rotate:
            command.append("--rotate-pages")
        command.extend([str(source), str(target)])
        # A file, not a PIPE: descendants cannot keep communicate() waiting
        # after the CLI is killed on timeout. Their group is reaped by Node.
        with (Path(scratch) / "ocr.log").open("w+") as log:
            try:
                result = subprocess.run(
                    command, env=env, stdout=log, stderr=log,
                    timeout=OCR_TIMEOUT_SECONDS, check=False,
                )
            except subprocess.TimeoutExpired as exc:
                raise OcrError("OCR exceeded 150 seconds. Split the PDF into fewer pages or reduce scan resolution, then retry.") from exc
            log.seek(0)
            details = log.read()
    if result.returncode:
        # Keep diagnostics in worker logs, not user-facing temporary paths.
        sys.stderr.write(details[-12000:])
        if "digital signature" in details.lower():
            raise OcrError("This PDF is digitally signed. OCR would invalidate the signature; use an unsigned source copy.")
        if result.returncode in (3, 9):
            raise OcrError("Server OCR dependencies are incomplete. Install server/py/requirements.txt and run server/py/setup_ocr.py.")
        if "pixels" in details.lower() or "image too large" in details.lower():
            raise OcrError("A scan image is too large for OCR. Reduce its resolution (aim for 300 dpi) and retry.")
        raise OcrError("OCR could not process this PDF. Try a freshly exported, unlocked PDF or a smaller page range.")
    if "[skipped page]" in details or "took too long to OCR" in details:
        raise OcrError("OCR could not finish every scanned page. Split the PDF or reduce scan resolution and retry.")
    return {"ok": True, "file": name, "mime": "application/pdf", "bytes": target.stat().st_size}
