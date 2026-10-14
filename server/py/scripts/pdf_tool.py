#!/usr/bin/env python3
"""PDF workbench — one script, several verbs.

Usage: pdf_tool.py request.json response.json

Request shape:
{
  "action": "info" | "text" | "extract" | "merge" | "rotate" | "split" | "metadata",
  "files": ["/abs/path/a.pdf", ...],
  "out_dir": "/abs/scratch",
  "params": { ... action-specific ... }
}

Response shape (written to response.json):
{"ok": true, "data": {...}}                      -> JSON payload
{"ok": true, "file": "name.pdf", "mime": "..."}  -> single artifact in out_dir
{"ok": true, "files": [{"file": ..., "mime": ...}]} -> multiple artifacts
{"ok": false, "error": "human readable"}
"""

from __future__ import annotations

import io
import json
import sys
import zipfile
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from reportlab.lib.colors import Color, black
from reportlab.pdfgen import canvas

from pdf_ocr import OcrError, ocr_pdf


class ToolError(Exception):
    """Raised for anything the user can fix."""


def parse_pages(spec, total: int) -> list[int]:
    """'1-3,7,9-11' -> zero-based indices. Empty spec means every page."""
    spec = (spec or "").strip()
    if not spec:
        return list(range(total))

    out: list[int] = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            raise ToolError(f"Bad page range near '{chunk}'.")
        if "-" in chunk:
            lo, _, hi = chunk.partition("-")
            try:
                lo_i, hi_i = int(lo), int(hi)
            except ValueError as exc:
                raise ToolError(f"Bad page range '{chunk}'.") from exc
            if lo_i < 1 or hi_i < lo_i or hi_i > total:
                raise ToolError(f"Page range '{chunk}' is outside 1-{total}.")
            out.extend(range(lo_i - 1, hi_i))
        else:
            try:
                one = int(chunk)
            except ValueError as exc:
                raise ToolError(f"Bad page number '{chunk}'.") from exc
            if one < 1 or one > total:
                raise ToolError(f"Page {one} is outside 1-{total}.")
            out.append(one - 1)

    if not out:
        raise ToolError("Page range selected no pages.")
    return sorted(set(out))


def open_reader(path: str, password: str = "") -> PdfReader:
    file = Path(path)
    if not file.is_file():
        raise ToolError(f"Missing file: {file.name}")
    try:
        reader = PdfReader(str(file))
    except Exception as exc:  # pypdf raises bare exceptions
        raise ToolError(f"{file.name} is not readable as a PDF ({exc}).") from exc
    if reader.is_encrypted:
        try:
            if not reader.decrypt(password):
                raise ToolError(f"{file.name} is password-protected.")
        except ToolError:
            raise
        except Exception as exc:
            raise ToolError(f"{file.name} is password-protected ({exc}).") from exc
    return reader


def write_pdf(writer: PdfWriter, out_dir: Path, name: str) -> dict:
    target = out_dir / name
    with target.open("wb") as handle:
        writer.write(handle)
    return {"file": name, "mime": "application/pdf", "bytes": target.stat().st_size}


def action_info(req: dict) -> dict:
    files = req.get("files") or []
    if not files:
        raise ToolError("No PDF supplied.")
    out = []
    for path in files:
        reader = open_reader(path)
        meta = reader.metadata
        info = {
            "name": Path(path).name,
            "pages": len(reader.pages),
            "bytes": Path(path).stat().st_size,
            "encrypted": reader.is_encrypted,
            "title": meta.title if meta else None,
            "author": meta.author if meta else None,
            "producer": meta.producer if meta else None,
            "creator": meta.creator if meta else None,
            "modified": str(meta.modification_date) if meta and meta.modification_date else None,
            "page_sizes": [],
        }
        for page in reader.pages[: min(len(reader.pages), 12)]:
            box = page.mediabox
            info["page_sizes"].append(
                {"page": len(info["page_sizes"]) + 1, "w": round(float(box.width), 1), "h": round(float(box.height), 1)}
            )
        out.append(info)
    return {"ok": True, "data": {"documents": out}}


def action_text(req: dict) -> dict:
    files = req.get("files") or []
    if not files:
        raise ToolError("No PDF supplied.")
    params = req.get("params") or {}
    pages_spec = params.get("pages", "")
    join_char = "\n\n" if params.get("pages_break", True) else "\n"

    chunks = []
    total_pages = 0
    for path in files:
        reader = open_reader(path)
        total_pages += len(reader.pages)
        indices = parse_pages(pages_spec, len(reader.pages))
        for index in indices:
            page_text = reader.pages[index].extract_text() or ""
            chunks.append(f"--- {Path(path).name} · page {index + 1} ---\n{page_text}")

    text = join_char.join(chunks)
    return {
        "ok": True,
        "data": {
            "text": text,
            "chars": len(text),
            "pages_scanned": total_pages if not pages_spec else len(chunks),
        },
    }


def action_extract(req: dict) -> dict:
    files = req.get("files") or []
    if len(files) != 1:
        raise ToolError("Extract needs exactly one PDF.")
    reader = open_reader(files[0])
    indices = parse_pages((req.get("params") or {}).get("pages", ""), len(reader.pages))
    writer = PdfWriter()
    for index in indices:
        writer.add_page(reader.pages[index])
    name = f"{Path(files[0]).stem}-pages.pdf"
    return {"ok": True, **write_pdf(writer, Path(req["out_dir"]), name)}


def action_merge(req: dict) -> dict:
    files = req.get("files") or []
    if len(files) < 2:
        raise ToolError("Merge needs at least two PDFs.")
    writer = PdfWriter()
    for path in files:
        reader = open_reader(path)
        writer.append(reader)
    return {"ok": True, **write_pdf(writer, Path(req["out_dir"]), "merged.pdf")}


def action_rotate(req: dict) -> dict:
    files = req.get("files") or []
    if len(files) != 1:
        raise ToolError("Rotate needs exactly one PDF.")
    params = req.get("params") or {}
    angle = int(params.get("angle", 90))
    if angle not in (90, 180, 270):
        raise ToolError("Angle must be 90, 180 or 270.")
    reader = open_reader(files[0])
    indices = set(parse_pages(params.get("pages", ""), len(reader.pages)))
    writer = PdfWriter()
    for index, page in enumerate(reader.pages):
        if index in indices:
            page.rotate(angle)
        writer.add_page(page)
    name = f"{Path(files[0]).stem}-rotated.pdf"
    return {"ok": True, **write_pdf(writer, Path(req["out_dir"]), name)}


def action_split(req: dict) -> dict:
    files = req.get("files") or []
    if len(files) != 1:
        raise ToolError("Split needs exactly one PDF.")
    params = req.get("params") or {}
    per_file = int(params.get("per_file", 1))
    if per_file < 1:
        raise ToolError("Pages per file must be at least 1.")

    reader = open_reader(files[0])
    total = len(reader.pages)
    stem = Path(files[0]).stem
    out_dir = Path(req["out_dir"])

    artifacts = []
    for start in range(0, total, per_file):
        writer = PdfWriter()
        for page in reader.pages[start : start + per_file]:
            writer.add_page(page)
        name = f"{stem}-{start + 1:03d}.pdf"
        artifacts.append(write_pdf(writer, out_dir, name))

    zip_name = f"{stem}-split.zip"
    with zipfile.ZipFile(out_dir / zip_name, "w", zipfile.ZIP_DEFLATED) as archive:
        for artifact in artifacts:
            archive.write(out_dir / artifact["file"], artifact["file"])

    return {
        "ok": True,
        "file": zip_name,
        "mime": "application/zip",
        "bytes": (out_dir / zip_name).stat().st_size,
        "data": {"parts": len(artifacts)},
    }


def parse_order(spec: str, total: int) -> list[int]:
    """Parse a page permutation while preserving order, e.g. '3,1,2'."""
    spec = (spec or "").strip()
    if not spec:
        raise ToolError("Enter the complete new page order.")
    pages: list[int] = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            raise ToolError("Page order contains an empty item.")
        if "-" in chunk:
            lo, _, hi = chunk.partition("-")
            try:
                start, end = int(lo), int(hi)
            except ValueError as exc:
                raise ToolError(f"Bad page range '{chunk}'.") from exc
            if start < 1 or end < start or end > total:
                raise ToolError(f"Page range '{chunk}' is outside 1-{total}.")
            pages.extend(range(start - 1, end))
        else:
            try:
                page = int(chunk)
            except ValueError as exc:
                raise ToolError(f"Bad page number '{chunk}'.") from exc
            if page < 1 or page > total:
                raise ToolError(f"Page {page} is outside 1-{total}.")
            pages.append(page - 1)
    if len(pages) != total or set(pages) != set(range(total)):
        raise ToolError(f"Reorder must list each of the {total} pages exactly once.")
    return pages


def action_reorder(req: dict) -> dict:
    files = req.get("files") or []
    if len(files) != 1:
        raise ToolError("Reorder needs exactly one PDF.")
    reader = open_reader(files[0])
    indices = parse_order((req.get("params") or {}).get("pages", ""), len(reader.pages))
    writer = PdfWriter()
    for index in indices:
        writer.add_page(reader.pages[index])
    name = f"{Path(files[0]).stem}-reordered.pdf"
    return {"ok": True, **write_pdf(writer, Path(req["out_dir"]), name)}


def action_compress(req: dict) -> dict:
    files = req.get("files") or []
    if len(files) != 1:
        raise ToolError("Compress needs exactly one PDF.")
    reader = open_reader(files[0])
    writer = PdfWriter(clone_from=reader)
    for page in writer.pages:
        page.compress_content_streams(level=9)
    writer.compress_identical_objects(remove_duplicates=True, remove_unreferenced=True)
    name = f"{Path(files[0]).stem}-compressed.pdf"
    return {"ok": True, **write_pdf(writer, Path(req["out_dir"]), name)}


def action_stamp(req: dict, watermark: bool) -> dict:
    files = req.get("files") or []
    if len(files) != 1:
        raise ToolError("Stamping needs exactly one PDF.")
    params = req.get("params") or {}
    text = str(params.get("stamp_text", "")).strip()
    if watermark and not text:
        raise ToolError("Enter watermark text.")
    if watermark and not text.isascii():
        raise ToolError("Watermark currently supports basic Latin characters only.")

    reader = open_reader(files[0])
    writer = PdfWriter()
    try:
        start_number = int(params.get("start_number", 1))
    except (TypeError, ValueError) as exc:
        raise ToolError("Starting page number must be an integer.") from exc
    if not 1 <= start_number <= 1_000_000:
        raise ToolError("Starting page number must be between 1 and 1,000,000.")
    try:
        opacity = max(0.08, min(float(params.get("opacity", 0.2)), 0.6))
    except (TypeError, ValueError) as exc:
        raise ToolError("Watermark opacity must be numeric.") from exc
    for index, page in enumerate(reader.pages):
        width = float(page.mediabox.width)
        height = float(page.mediabox.height)
        overlay_data = io.BytesIO()
        overlay = canvas.Canvas(overlay_data, pagesize=(width, height), pageCompression=1)
        if watermark:
            overlay.saveState()
            overlay.translate(width / 2, height / 2)
            overlay.rotate(45)
            overlay.setFillColor(Color(0, 0, 0, alpha=opacity))
            overlay.setFont("Helvetica-Bold", max(24, min(width, height) / 9))
            overlay.drawCentredString(0, 0, text[:100])
            overlay.restoreState()
        else:
            overlay.setFillColor(black)
            overlay.setFont("Helvetica", 10)
            overlay.drawCentredString(width / 2, 18, str(start_number + index))
        overlay.save()
        overlay_data.seek(0)
        page.merge_page(PdfReader(overlay_data).pages[0])
        writer.add_page(page)

    suffix = "watermarked" if watermark else "numbered"
    name = f"{Path(files[0]).stem}-{suffix}.pdf"
    return {"ok": True, **write_pdf(writer, Path(req["out_dir"]), name)}


def action_number(req: dict) -> dict:
    return action_stamp(req, watermark=False)


def action_watermark(req: dict) -> dict:
    return action_stamp(req, watermark=True)


def action_protect(req: dict) -> dict:
    files = req.get("files") or []
    if len(files) != 1:
        raise ToolError("Protect needs exactly one PDF.")
    password = str((req.get("params") or {}).get("password", ""))
    if len(password) < 8:
        raise ToolError("Use a password with at least 8 characters.")
    reader = open_reader(files[0])
    writer = PdfWriter(clone_from=reader)
    writer.encrypt(user_password=password, algorithm="AES-256")
    name = f"{Path(files[0]).stem}-protected.pdf"
    return {"ok": True, **write_pdf(writer, Path(req["out_dir"]), name)}


def action_unlock(req: dict) -> dict:
    files = req.get("files") or []
    if len(files) != 1:
        raise ToolError("Unlock needs exactly one PDF.")
    password = str((req.get("params") or {}).get("password", ""))
    reader = open_reader(files[0], password)
    if not reader.is_encrypted:
        raise ToolError("This PDF is not password-protected.")
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    name = f"{Path(files[0]).stem}-unlocked.pdf"
    return {"ok": True, **write_pdf(writer, Path(req["out_dir"]), name)}


ACTIONS = {
    "ocr": ocr_pdf,
    "info": action_info,
    "text": action_text,
    "extract": action_extract,
    "merge": action_merge,
    "rotate": action_rotate,
    "split": action_split,
    "reorder": action_reorder,
    "compress": action_compress,
    "number": action_number,
    "watermark": action_watermark,
    "protect": action_protect,
    "unlock": action_unlock,
}


def main() -> int:
    if len(sys.argv) < 3:
        sys.stderr.write("usage: pdf_tool.py request.json response.json\n")
        return 2

    request_path, response_path = sys.argv[1], sys.argv[2]

    try:
        req = json.loads(Path(request_path).read_text("utf-8"))
        action = req.get("action")
        handler = ACTIONS.get(action)
        if handler is None:
            raise ToolError(f"Unknown action '{action}'.")
        Path(req.get("out_dir") or ".").mkdir(parents=True, exist_ok=True)
        result = handler(req)
    except (ToolError, OcrError) as exc:
        result = {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 - surface anything as a clean message
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        sys.stderr.write(repr(exc) + "\n")

    Path(response_path).write_text(json.dumps(result, ensure_ascii=False), "utf-8")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
