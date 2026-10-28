#!/usr/bin/env python3
"""Attacks on the CV studio's newer endpoints over HTTP, against a production build in public mode (docs/TESTING.md):
CV projects (`?project=` isolation and path tricks), the CV file upload (`/api/cv/import/extract`: size, fake and
bomb files), the PDF/HTML export from a browser-sent sheet (`/api/cv/export`: local files, network fetches, script and
links in the sheet), the export file name, and the website address (`/api/site` set-url/verify: loopback, metadata).

Run: KNIFE_DATA_DIR=<the server's> python3 tests/cv_security_probe.py <app-url>   (the server as for security_probe.py;
the PDF checks run pypdf in the Python lane's venv, KNIFE_PYTHON or ../samurai-knife-py/venv)
"""
from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.functional.accounts_public_e2e import Api, Outbox  # noqa: E402

BASE = sys.argv[1].rstrip("/")
DATA = Path(os.environ.get("KNIFE_DATA_DIR", ""))
FAILS: list[str] = []
PASSES = 0
HITS: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> bool:
    global PASSES
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  -> ' + str(detail)[:500]}", flush=True)
    if ok:
        PASSES += 1
    else:
        FAILS.append(name)
    return ok


class Canary(BaseHTTPRequestHandler):
    """Records every request: nothing in an export may make the server fetch from here."""

    def do_GET(self) -> None:  # noqa: N802
        HITS.append(self.path)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"canary")

    def log_message(self, *args) -> None:  # noqa: ANN002
        pass


def raw(method: str, path: str, body: object | None, cookie: str = "", ip: str = "198.51.100.30") -> tuple[int, dict[str, str], bytes]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if method != "GET":
        req.add_header("Origin", BASE)
    if cookie:
        req.add_header("Cookie", cookie)
    req.add_header("X-Forwarded-For", ip)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, {k.lower(): v for k, v in err.headers.items()}, err.read()
    except (urllib.error.URLError, ConnectionError) as err:  # the server closed the connection on an oversized body
        return 0, {}, str(err).encode()


def register(api: Api, box: Outbox, name: str, ip: str) -> str:
    api.call("POST", "/api/account/register", {"username": name, "email": f"{name}@example.org", "password": f"{name} password 1"}, ip=ip)
    mails = box.wait(f"{name}@example.org", 1)
    token = Outbox.token(Outbox.link(mails[0][2], "/verify")) if mails else ""
    api.call("POST", "/api/account/verify", {"token": token}, ip=ip)
    status, _, cookie = api.login(name, f"{name} password 1", ip)
    check(f"{name}: registered, verified, logged in", status == 200 and bool(cookie), status)
    return cookie or ""


VENV_PY = os.environ.get("KNIFE_PYTHON") or str(ROOT.parent / "samurai-knife-py" / "venv" / "bin" / "python")
PDF_PARTS = r"""
import io, json, sys
from pypdf import PdfReader
r = PdfReader(io.BytesIO(sys.stdin.buffer.read()))
out = {"text": "", "images": 0, "links": []}
for p in r.pages:
    out["text"] += (p.extract_text() or "") + "\n"
    out["images"] += len(p.images)
    for a in p.get("/Annots", []) or []:
        uri = (a.get_object().get("/A") or {}).get("/URI")
        if uri:
            out["links"].append(str(uri))
print(json.dumps(out))
"""


def pdf_parts(data: bytes) -> dict:
    """Text, image count and link targets of a PDF (compressed object streams hide them from a byte search)."""
    done = subprocess.run([VENV_PY, "-I", "-c", PDF_PARTS], input=data, capture_output=True, check=True)
    return json.loads(done.stdout)


def main() -> int:
    canary = ThreadingHTTPServer(("127.0.0.1", 0), Canary)
    threading.Thread(target=canary.serve_forever, daemon=True).start()
    cport = canary.server_address[1]
    api = Api(BASE)
    box = Outbox(DATA)

    # ------------------------------------------------------------------------------------------------- guests
    for method, path, body in (("GET", "/api/cv/projects", None), ("POST", "/api/cv/projects", {"action": "create", "name": "x"}),
                               ("POST", "/api/cv/import/extract", {"name": "a.txt", "data": "YQ=="}),
                               ("POST", "/api/cv/export", {"variantId": None, "lang": "en", "format": "txt"}),
                               ("POST", "/api/site", {"action": "set-url", "url": "https://example.org"})):
        status, _, _ = raw(method, path, body)
        check(f"guest: {method} {path} refused", status in (401, 403), status)

    carol = register(api, box, "carol", "198.51.100.31")
    dave = register(api, box, "dave", "198.51.100.32")

    # ------------------------------------------------------------------------------------------------- projects
    status, _, body = raw("POST", "/api/cv/projects", {"action": "create", "name": "Carol secret"}, carol)
    project = json.loads(body).get("project", {}).get("id", "") if status == 201 else ""
    check("carol creates a second project", bool(project), (status, body[:200]))
    status, _, _ = raw("POST", f"/api/cv/patch?project={project}", {"ops": [{"op": "set", "path": "/contact/name", "value": "Carol Secretname"}]}, carol)
    check("carol writes into it", status == 200, status)
    status, _, body = raw("GET", f"/api/cv?project={project}", None, dave)
    check("dave naming carol's project id sees nothing of hers", b"Secretname" not in body, (status, body[:200]))
    for evil in ("../../accounts", "..%2F..%2Faccounts", "main/../../x", "p-" + "a" * 300, "%00"):
        status, _, body = raw("GET", f"/api/cv?project={evil}", None, dave)
        check(f"project path trick {evil[:20]!r} -> refused or own data", status in (200, 400, 404) and b"passwordHash" not in body and b"Secretname" not in body, (status, body[:160]))
    status, _, body = raw("POST", "/api/cv/projects", {"action": "switch", "id": project}, dave)
    check("dave cannot switch to carol's project", status in (400, 404), (status, body[:160]))

    # ------------------------------------------------------------------------------------------------- upload
    def extract(data: bytes, name: str) -> tuple[int, dict]:
        status, _, body = raw("POST", "/api/cv/import/extract", {"name": name, "data": base64.b64encode(data).decode()}, dave)
        try:
            return status, json.loads(body)
        except ValueError:
            return status, {"raw": body[:200]}

    status, body = extract(b"x" * (9 * 1024 * 1024), "big.txt")
    check("upload over 8 MB refused (or the connection cut)", status in (0, 413, 422), (status, body))
    status, body = extract(b"%PDF-1.4 not really", "fake.pdf")
    check("a broken PDF is a readable refusal", status == 422 and body.get("error"), (status, body))
    bomb = io.BytesIO()
    with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        z.writestr("word/document.xml", "<w:document xmlns:w='http://schemas.openxmlformats.org/wordprocessingml/2006/main'><w:body><w:p><w:r><w:t>" + "A" * (300 * 1024 * 1024) + "</w:t></w:r></w:p></w:body></w:document>")
    started = time.monotonic()
    status, body = extract(bomb.getvalue(), "bomb.docx")
    took = time.monotonic() - started
    check(f"a 300 MB zip bomb ({len(bomb.getvalue()) // 1024} KB) is refused or bounded quickly ({took:.1f}s)", took < 60 and (status != 200 or len(body.get("text", "")) <= 400_000), (status, str(body)[:200]))
    status, _, _ = raw("GET", "/login", None)
    check("server still answers after the bomb", status == 200, status)

    # ------------------------------------------------------------------------------------------------- export sheet
    status, _, _ = raw("POST", "/api/cv/patch", {"ops": [{"op": "set", "path": "/contact/name", "value": "Dave Probe"}, {"op": "set", "path": "/summary", "value": {"pl": "Tekst", "en": "Body text"}}]}, dave)
    check("dave's CV has something to export", status == 200, status)
    evil = f"""<article class="cvdoc" data-theme="modern" style="--cv-accent:#123456;background:url(http://127.0.0.1:{cport}/style)">
<style>@import url(http://127.0.0.1:{cport}/import);</style><link rel="stylesheet" href="http://127.0.0.1:{cport}/link">
<img src="file:///etc/passwd"><img src="http://127.0.0.1:{cport}/img">
<svg><image href="http://127.0.0.1:{cport}/svg-href"/><image xlink:href="file:///etc/passwd"/><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>
<object data="file:///etc/passwd"></object><iframe src="http://127.0.0.1:{cport}/frame"></iframe>
<h1 onclick="steal()">Dave Probe</h1><a href="javascript:alert(1)">js</a><a href="file:///etc/passwd">file</a>
<p style="background-image:url(file:///etc/shadow)">Body text</p></article>"""
    status, headers, pdf = raw("POST", "/api/cv/export", {"variantId": None, "lang": "en", "theme": "modern", "format": "pdf", "sheet": evil}, dave)
    if check("hostile sheet: PDF still built (the hostile parts dropped)", status == 200 and pdf[:4] == b"%PDF", (status, pdf[:200])):
        parts = pdf_parts(pdf)
        text = parts["text"]
        check("PDF holds no local file contents", "root:" not in text and "/bin/" not in text, text[:200])
        check("PDF has no javascript/file links", not [u for u in parts["links"] if not u.startswith(("https:", "http:", "mailto:", "tel:"))], parts["links"])
    status, _, html = raw("POST", "/api/cv/export", {"variantId": None, "lang": "en", "theme": "modern", "format": "html", "sheet": evil}, dave)
    page = html.decode("utf-8", "replace")
    check("hostile sheet: HTML built", status == 200 and "Dave Probe" in page, (status, page[:200]))
    for bad in ("<script", "onclick", "javascript:", "file:///", f"127.0.0.1:{cport}", "<iframe", "<object", "@import"):
        check(f"HTML export drops {bad!r}", bad not in page, page[page.find(bad) - 80: page.find(bad) + 80] if bad in page else "")
    time.sleep(1)
    check("the server fetched nothing the sheet named", not HITS, HITS)
    # The stricter cleaning keeps what a real sheet needs: the account's own photo and icons.
    from PIL import Image

    jpeg = io.BytesIO()
    Image.new("RGB", (200, 200), (40, 90, 160)).save(jpeg, "JPEG")
    status, _, _ = raw("POST", "/api/cv/photo", {"dataUrl": "data:image/jpeg;base64," + base64.b64encode(jpeg.getvalue()).decode()}, dave)
    check("dave stores a photo", status == 200, status)
    real = ('<article class="cvdoc" data-theme="sidebar" style="--cv-accent:#1f5f8b"><aside><img class="cv-photo round" src="/api/cv/photo" alt="Dave">'
            '<svg class="cv-icon" viewBox="0 0 24 24" width="9" height="9" aria-hidden="true"><path d="M2 2h20v20H2z" fill="currentColor"></path></svg></aside>'
            '<h1>Dave Probe</h1><p><a href="https://github.com/dave">github.com/dave</a></p></article>')
    status, _, pdf = raw("POST", "/api/cv/export", {"variantId": None, "lang": "en", "theme": "sidebar", "photo": True, "format": "pdf", "sheet": real}, dave)
    parts = pdf_parts(pdf) if status == 200 else {"images": 0, "links": []}
    check("a real sheet keeps the photo and the link in the PDF", parts["images"] >= 1 and "https://github.com/dave" in parts["links"], (status, parts["images"], parts["links"]))
    status, _, html = raw("POST", "/api/cv/export", {"variantId": None, "lang": "en", "theme": "sidebar", "photo": True, "format": "html", "sheet": real}, dave)
    page = html.decode("utf-8", "replace")
    check("…and in the HTML file (photo as a data URL, icon path kept)", 'src="data:image/jpeg;base64,' in page and '<path d="M2 2h20v20H2z"' in page, page[:300])
    status, _, _ = raw("POST", "/api/cv/export", {"variantId": None, "lang": "en", "theme": "modern", "format": "pdf", "sheet": "<article class=\"cvdoc\">" + "x" * (3 * 1024 * 1024) + "</article>"}, dave)
    check("a 3 MB sheet is refused (or the connection cut)", status in (0, 413, 422), status)

    # ------------------------------------------------------------------------------------------------- file name
    raw("POST", "/api/cv/patch", {"ops": [{"op": "set", "path": "/contact/name", "value": "Dave\r\nX-Evil: 1\"; filename=\"../../x.sh"}]}, dave)
    status, headers, _ = raw("POST", "/api/cv/export", {"variantId": None, "lang": "en", "theme": "ats", "format": "txt"}, dave)
    disp = headers.get("content-disposition", "")
    check("export file name: no header injection or path", status == 200 and "x-evil" not in headers and "../" not in disp and "\n" not in disp, (status, disp))

    # ------------------------------------------------------------------------------------------------- website
    for url in ("http://127.0.0.1:3400", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", f"http://127.0.0.1:{cport}/site", "file:///etc/passwd"):
        raw("POST", "/api/site", {"action": "set-url", "url": url}, dave)
        status, _, body = raw("POST", "/api/site", {"action": "verify-url"}, dave)
        check(f"website verify of {url} refused", status != 200 or b'"verified":true' not in body, (status, body[:200]))
    time.sleep(1)
    check("no website check reached the local canary", not any(h.startswith("/site") for h in HITS), HITS)

    canary.shutdown()
    print(f"\n{PASSES} passed, {len(FAILS)} failed")
    if FAILS:
        print("FAILED:", FAILS)
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
