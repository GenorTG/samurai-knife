#!/usr/bin/env python3
"""CV -> PDF (WeasyPrint). Usage: cv_pdf.py request.json response.json

Request  {"html": "<!doctype html>…", "fonts_dir": "/abs/dir with the .woff2 files", "out_dir": "/abs/scratch",
          "filename": "cv.pdf", "title": "Name - CV", "author": "Name", "lang": "pl|en"}
Response {"ok": true, "file": "cv.pdf", "mime": "application/pdf", "bytes": N, "pages": N} | {"ok": false, "error": "..."}

The HTML is the CV studio's own sheet (src/lib/cv/render/sheet-html.ts: the preview's markup plus cv-document.css), so
the PDF is what the preview shows. Links become PDF link annotations. Nothing is fetched: the only resources the
document may load are the bundled fonts (https://cv.invalid/cv-fonts/<file>.woff2, read from fonts_dir) and data: URLs
(the photo); any other URL fails the load of that one resource. No JavaScript exists in WeasyPrint.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

BASE = "https://cv.invalid/"
FONT_URL = re.compile(r"^https://cv\.invalid/cv-fonts/([A-Za-z0-9._-]+\.woff2)$")
MAX_HTML = 4 * 1024 * 1024


class ToolError(Exception):
    pass


def fetcher_for(fonts_dir: Path):
    from weasyprint.urls import URLFetcher, URLFetcherResponse

    class CvFetcher(URLFetcher):
        """data: URLs (the photo) and the bundled fonts; everything else fails (no network, no files)."""

        def fetch(self, url: str, headers: Any = None) -> URLFetcherResponse:
            if url.startswith("data:"):
                return super().fetch(url, headers)
            match = FONT_URL.match(url)
            if match:
                path = fonts_dir / match.group(1)
                if path.is_file():
                    return URLFetcherResponse(url, path.read_bytes(), {"Content-Type": "font/woff2"})
            raise ValueError(f"resource not allowed in a CV: {url[:120]}")

    return CvFetcher(allowed_protocols={"data", "https"}, allow_redirects=False)


def render(req: dict[str, Any]) -> dict[str, Any]:
    html = req.get("html")
    if not isinstance(html, str) or not html.strip():
        raise ToolError("html: missing.")
    if len(html.encode("utf-8")) > MAX_HTML:
        raise ToolError("html: too large.")
    fonts_dir = Path(str(req.get("fonts_dir") or "."))
    out_dir = Path(str(req.get("out_dir") or "."))
    out_dir.mkdir(parents=True, exist_ok=True)
    filename = Path(str(req.get("filename") or "cv.pdf")).name
    if not filename.lower().endswith(".pdf"):
        filename += ".pdf"

    import logging

    from weasyprint import HTML
    from weasyprint.text.fonts import FontConfiguration

    # A refused resource is logged by WeasyPrint as a warning; keep stderr quiet (the response says what matters).
    logging.getLogger("weasyprint").setLevel(logging.ERROR)
    fonts = FontConfiguration()
    document = HTML(string=html, base_url=BASE, url_fetcher=fetcher_for(fonts_dir)).render(font_config=fonts)
    target = out_dir / filename
    meta = document.metadata
    meta.title = str(req.get("title") or "CV")[:200]
    meta.authors = [str(req.get("author"))[:200]] if req.get("author") else []
    meta.lang = str(req.get("lang") or "")[:5] or None
    document.write_pdf(target)
    return {"ok": True, "file": filename, "mime": "application/pdf", "bytes": target.stat().st_size, "pages": len(document.pages)}


def main() -> int:
    if len(sys.argv) < 3:
        sys.stderr.write("usage: cv_pdf.py request.json response.json\n")
        return 2
    request_path, response_path = sys.argv[1], sys.argv[2]
    try:
        req = json.loads(Path(request_path).read_text("utf-8"))
        if not isinstance(req, dict):
            raise ToolError("request: expected a JSON object.")
        result = render(req)
    except ToolError as exc:
        result = {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 - surface anything as a clean message
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        sys.stderr.write(repr(exc) + "\n")
    Path(response_path).write_text(json.dumps(result, ensure_ascii=False), "utf-8")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
