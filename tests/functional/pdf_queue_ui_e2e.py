"""PDF tool under queue pressure: honest Queued/Processing status, Cancel, cleanup on navigation, results unchanged.

Scratch server with a one-slot heavy lane (see tests/queue_e2e.py docstring for the env), then:
    python3 tests/functional/pdf_queue_ui_e2e.py http://127.0.0.1:3301
Run it with the system python3 (playwright); fixtures and checks use the engine venv (reportlab, pypdf) via subprocess.
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from playwright.sync_api import sync_playwright

VENV_PY = os.environ.get("KNIFE_PYTHON") or str(Path(__file__).resolve().parents[3] / "samurai-knife-py" / "venv" / "bin" / "python")

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3301").rstrip("/")
failures: list[str] = []
TMP = Path(tempfile.mkdtemp(prefix="pdfq-ui-"))


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f" | {str(detail)[:250]}"))
    if not ok:
        failures.append(name)


def venv(code, *args):
    return subprocess.run([VENV_PY, "-c", code, *args], capture_output=True, text=True, check=True).stdout


def mkpdf(pages, tag, name):
    p = TMP / name
    venv("""
import sys
from reportlab.pdfgen import canvas
pages, tag, out = int(sys.argv[1]), sys.argv[2], sys.argv[3]
c = canvas.Canvas(out)
for i in range(pages):
    c.drawString(100, 700, f"{tag} page {i} " + "lorem ipsum " * 12)
    c.showPage()
c.save()
""", str(pages), tag, str(p))
    return p


def api(method, path, body=None, headers=None):
    req = urllib.request.Request(BASE + path, body, {"Origin": BASE, **(headers or {})}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def lane():
    return json.loads(api("GET", "/api/system/queue")[1])["lanes"]["heavy"]


def occupy(big: Path) -> str:
    b = uuid.uuid4().hex
    body = (f'--{b}\r\nContent-Disposition: form-data; name="action"\r\n\r\ncompress\r\n--{b}\r\n'
            'Content-Disposition: form-data; name="file"; filename="big.pdf"\r\nContent-Type: application/pdf\r\n\r\n').encode() \
        + big.read_bytes() + f"\r\n--{b}--\r\n".encode()
    s, raw = api("POST", "/api/pdf?async=1", body, {"Content-Type": f"multipart/form-data; boundary={b}"})
    assert s == 202, (s, raw[:200])
    return json.loads(raw)["jobId"]


def wait(pred, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.1)
    return False


BIG = mkpdf(6000, "big", "big.pdf")
SMALL = mkpdf(3, "small", "small.pdf")
URL = f"{BASE}/tools/pdf?tab=tools"

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    errors: list[str] = []
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    def status_text() -> str:
        return page.get_by_role("status").filter(has_text="").all_inner_texts().__str__()

    def pdf_status() -> str:
        # the status line right under the run button; other role=status regions (loading, toasts) may exist
        loc = page.locator("p[role=status]")
        return " | ".join(t.strip() for t in loc.all_inner_texts() if t.strip())

    def attach(path):
        """set_input_files, retried until the tool lists the file (a change event before hydration is lost)."""
        for _ in range(6):
            page.locator("input[type=file]").first.set_input_files(str(path))
            try:
                page.get_by_text("1 file ·").wait_for(timeout=3000)
                return
            except Exception:
                page.wait_for_timeout(500)
        raise AssertionError("tool never listed the attached file")

    def open_tool():
        page.goto(URL)
        page.wait_for_selector("input[type=file]", state="attached", timeout=30000)
        page.wait_for_selector("p[role=status]", state="attached", timeout=30000)  # the lazy tool chunk has rendered
        page.wait_for_function("() => !document.body.innerText.includes('Loading tool')", timeout=30000)
        attach(SMALL)

    # 1. idle tool: a result with no queue pressure, status line present
    open_tool()
    check("status region exists and is empty while idle", page.locator("p[role=status]").count() == 1 and pdf_status() == "", pdf_status())
    page.get_by_role("button", name="Inspect", exact=True).last.click()
    check("small job completes with the unchanged result UI (document table shows 3 pages)",
          wait(lambda: page.get_by_text("small.pdf").count() > 0 and page.get_by_text("3", exact=True).count() > 0, 20))
    check("status line is clear again after the job", wait(lambda: pdf_status() == ""), pdf_status())

    # 2. heavy lane busy -> honest Queued, then Cancel
    big_job = occupy(BIG)
    check("heavy lane is occupied by the API job", wait(lambda: lane()["running"] == 1), lane())
    open_tool()
    page.get_by_role("button", name="Inspect", exact=True).last.click()
    check("status shows 'Queued (next up)…' while waiting behind a running job", wait(lambda: "Queued (next up)" in pdf_status(), 15), pdf_status())
    check("server agrees: one job queued", lane()["queued"] == 1, lane())
    check("button reads Working… and Cancel is offered", page.get_by_role("button", name="Cancel", exact=True).count() == 1
          and page.get_by_role("button", name="Working…").count() == 1)
    page.get_by_role("button", name="Cancel", exact=True).click()
    check("after Cancel: status 'Cancelled.' and the run button is back", wait(lambda: pdf_status() == "Cancelled."
          and page.get_by_role("button", name="Inspect", exact=True).count() > 0), pdf_status())
    check("server: the job left the queue (DELETE reached it)", wait(lambda: lane()["queued"] == 0), lane())
    check("no error notice after a user cancel", page.get_by_text("failed").count() == 0)

    # 3. position text with two ahead
    other = occupy(SMALL)           # queued behind big_job (position 0)
    page.get_by_role("button", name="Inspect", exact=True).last.click()
    check("status shows 'Queued (1 ahead)…' with one job queued before it", wait(lambda: "Queued (1 ahead)" in pdf_status(), 15), pdf_status())

    # 4. navigating away cancels the job (unmount cleanup)
    page.goto(f"{BASE}/")
    check("leaving the page removes the queued job from the server", wait(lambda: lane()["queued"] == 1, 10), lane())
    # (queued == 1 is `other`, the API-created one; the UI job must be gone)

    # 5. once the lane frees up the UI shows Processing… and still downloads
    api("DELETE", f"/api/jobs/{big_job}")
    api("DELETE", f"/api/jobs/{other}")
    check("lane drained", wait(lambda: lane()["running"] == 0 and lane()["queued"] == 0), lane())
    open_tool()
    page.get_by_role("button", name="Compress", exact=True).first.click()
    with page.expect_download(timeout=60000) as dl:
        page.get_by_role("button", name="Compress", exact=True).last.click()
    out = TMP / "dl.pdf"
    dl.value.save_as(str(out))
    check("compress via async job downloads a valid 3-page PDF", venv("import sys, pypdf; print(len(pypdf.PdfReader(sys.argv[1]).pages))", str(out)).strip() == "3")
    check("download note shown", wait(lambda: page.get_by_text("Saved:").count() > 0))

    # 6. a running job: Processing…, then Cancel kills it on the server
    page.goto(URL)
    page.wait_for_selector("p[role=status]", state="attached", timeout=30000)
    page.wait_for_function("() => !document.body.innerText.includes('Loading tool')", timeout=30000)
    attach(BIG)
    page.get_by_role("button", name="Compress", exact=True).first.click()
    page.get_by_role("button", name="Compress", exact=True).last.click()
    check("status shows 'Processing…' while the job runs", wait(lambda: "Processing…" in pdf_status(), 20), pdf_status())
    check("server: heavy lane running=1", lane()["running"] == 1, lane())
    page.get_by_role("button", name="Cancel", exact=True).click()
    check("Cancel on a running job -> 'Cancelled.'", wait(lambda: pdf_status() == "Cancelled."), pdf_status())
    check("server: the process was killed (running=0)", wait(lambda: lane()["running"] == 0, 8), lane())
    check("no page errors", not errors, errors[:3])
    browser.close()

print("ALL PASS" if not failures else f"{len(failures)} FAILURES: {failures}")
sys.exit(1 if failures else 0)
