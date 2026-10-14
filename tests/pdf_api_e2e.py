"""PDF API end-to-end: all 12 actions against a live server, outputs verified with pypdf.

Usage: ../samurai-knife-py/venv/bin/python tests/pdf_api_e2e.py [base_url]
"""
import io
import json
import sys
import urllib.error
import urllib.request
import uuid

from pypdf import PdfReader
from reportlab.pdfgen import canvas

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3210").rstrip("/")
failures: list[str] = []


def make_pdf(pages: int, tag: str) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for i in range(1, pages + 1):
        c.drawString(100, 700, f"{tag} page {i}")
        c.showPage()
    c.save()
    return buf.getvalue()


def post(action: str, files: list[tuple[str, bytes]], params: dict | None = None):
    boundary = uuid.uuid4().hex
    parts: list[bytes] = []

    def field(name: str, value: str) -> None:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())

    field("action", action)
    if params is not None:
        field("params", json.dumps(params))
    for name, data in files:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
            "Content-Type: application/pdf\r\n\r\n".encode() + data + b"\r\n"
        )
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(
        f"{BASE}/api/pdf",
        b"".join(parts),
        {"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, resp.headers.get("Content-Type", ""), resp.read()
    except urllib.error.HTTPError as err:
        return err.code, err.headers.get("Content-Type", ""), err.read()


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("ok   " if ok else "FAIL ") + name + (f" | {detail}" if detail else ""))
    if not ok:
        failures.append(name)


def page_texts(data: bytes, password: str | None = None) -> list[str]:
    r = PdfReader(io.BytesIO(data))
    if r.is_encrypted:
        r.decrypt(password or "")
    return [(p.extract_text() or "").strip() for p in r.pages]


src = make_pdf(3, "A")
other = make_pdf(2, "B")

s, _, b = post("info", [("a.pdf", src)])
check("info", s == 200 and json.loads(b)["ok"], b[:120].decode())

s, _, b = post("text", [("a.pdf", src)])
check("text", s == 200 and "A page 2" in b.decode(), b[:100].decode())

s, _, b = post("extract", [("a.pdf", src)], {"pages": "2-3"})
t = page_texts(b) if s == 200 else []
check("extract 2-3", t == ["A page 2", "A page 3"], str(t))

s, _, b = post("merge", [("a.pdf", src), ("b.pdf", other)])
t = page_texts(b) if s == 200 else []
check("merge", t == ["A page 1", "A page 2", "A page 3", "B page 1", "B page 2"], str(t))

s, _, b = post("rotate", [("a.pdf", src)], {"pages": "1", "angle": 90})
r = PdfReader(io.BytesIO(b)) if s == 200 else None
check("rotate", r is not None and [p.get("/Rotate", 0) for p in r.pages] == [90, 0, 0])

s, ct, b = post("split", [("a.pdf", src)], {"per_file": 1})
check("split", s == 200 and len(b) > 0, f"{ct} {len(b)}B")

s, _, b = post("reorder", [("a.pdf", src)], {"pages": "3,1,2"})
t = page_texts(b) if s == 200 else []
check("reorder", t == ["A page 3", "A page 1", "A page 2"], str(t))

s, _, b = post("compress", [("a.pdf", src)])
check("compress", s == 200 and len(page_texts(b)) == 3)

s, _, b = post("number", [("a.pdf", src)], {"start_number": 5})
t = page_texts(b) if s == 200 else []
check("number", len(t) == 3 and "5" in t[0] and "7" in t[2], str(t))

s, _, b = post("watermark", [("a.pdf", src)], {"stamp_text": "DRAFT", "opacity": 0.3})
t = page_texts(b) if s == 200 else []
check("watermark", len(t) == 3 and all("DRAFT" in x for x in t), str(t))

s, _, enc = post("protect", [("a.pdf", src)], {"password": "s3cret-pw"})
r = PdfReader(io.BytesIO(enc)) if s == 200 else None
check("protect", r is not None and r.is_encrypted)

s, _, b = post("unlock", [("a.pdf", enc)], {"password": "s3cret-pw"})
t = page_texts(b) if s == 200 else []
check("unlock", t == ["A page 1", "A page 2", "A page 3"], str(t))

s, _, b = post("protect", [("a.pdf", src)], {"password": "short"})
check("protect short password rejected", s == 400 and b"at least 8" in b, f"{s} {b[:100].decode()}")

s, _, b = post("unlock", [("a.pdf", enc)], {"password": "wrong-pass-1"})
check("unlock wrong password rejected", s == 400 and b"not readable" not in b, f"{s} {b[:120].decode()}")

s, _, b = post("unlock", [("a.pdf", src)], {"password": "whatever1"})
check("unlock unencrypted rejected", s == 400 and b"not password-protected" in b, f"{s} {b[:100].decode()}")

s, _, b = post("bogus", [("a.pdf", src)])
check("unknown action rejected", s == 400, f"{s} {b[:100].decode()}")

s, _, b = post("info", [("bad.pdf", b"not a pdf")])
check("corrupt input rejected", s == 400, f"{s} {b[:100].decode()}")

# A declared body over the job budget (KNIFE_JOBS_MAX_MB, default 2048 MB) is refused before the server buffers it: send only the
# headers, claiming 100 GB, and expect a 413 without ever sending a body.
import http.client  # noqa: E402
import urllib.parse  # noqa: E402

host = urllib.parse.urlparse(BASE)
conn = http.client.HTTPConnection(host.hostname, host.port, timeout=30)
conn.putrequest("POST", "/api/pdf")
conn.putheader("Content-Type", "multipart/form-data; boundary=x")
conn.putheader("Origin", BASE)
conn.putheader("Content-Length", str(100 * 1024 ** 3))
conn.endheaders()
resp = conn.getresponse()
body = resp.read()
check("a declared 100 GB upload is refused with 413 before any body is read", resp.status == 413 and b"Upload is over" in body, f"{resp.status} {body[:100]!r}")
conn.close()

print("ALL PASS" if not failures else f"{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
