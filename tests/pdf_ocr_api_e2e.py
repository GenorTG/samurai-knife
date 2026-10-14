"""Searchable PDF HTTP/job contract and real Tesseract cancellation.

Run: ../samurai-knife-py/venv/bin/python tests/pdf_ocr_api_e2e.py
Own scratch server/data/worktree, synthetic PDFs only. Never uses the live app.
"""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

from pypdf import PdfWriter

from pdf_ocr_test import ROOT, scan_pdf, text_of
from scratch_server import ScratchServer


def http(base: str, route: str, method: str = "GET", data: bytes | None = None,
         headers: dict[str, str] | None = None) -> tuple[int, bytes]:
    request = urllib.request.Request(base + route, data=data, method=method,
                                     headers={"Origin": base, **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def upload(base: str, source: Path, params: object, asynchronous: bool = True) -> tuple[int, dict | bytes]:
    boundary = uuid.uuid4().hex
    body = bytearray()
    for name, value in (("action", "ocr"), ("params", json.dumps(params))):
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="scan.pdf"\r\nContent-Type: application/pdf\r\n\r\n'.encode())
    body.extend(source.read_bytes())
    body.extend(f"\r\n--{boundary}--\r\n".encode())
    status, data = http(base, "/api/pdf" + ("?async=1" if asynchronous else ""), "POST", bytes(body),
                        {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    return status, data if data.startswith(b"%PDF-") else json.loads(data)


def wait_job(base: str, job: dict) -> dict:
    deadline = time.monotonic() + 175
    while time.monotonic() < deadline:
        status, data = http(base, job["statusUrl"])
        assert status == 200, data
        result = json.loads(data)
        if result["status"] not in ("queued", "running"):
            return result
        time.sleep(0.1)
    raise AssertionError("OCR async job exceeded route budget")


def processes() -> list[tuple[int, int, str, str]]:
    result = []
    for line in subprocess.check_output(["ps", "-eo", "pid=,pgid=,stat=,args="], text=True).splitlines():
        pid, group, state, args = line.strip().split(None, 3)
        result.append((int(pid), int(group), state, args))
    return result


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="knife-ocr-http-") as temp, ScratchServer() as server:
        root = Path(temp)
        tmpdir = root / "worker-tmp"
        tmpdir.mkdir()
        base = server.start(env={"TMPDIR": str(tmpdir)})
        # ScratchServer snapshots tracked edits; include this lane's new Python
        # modules before invoking a worker, without staging shared-checkout files.
        shutil.copytree(ROOT / "server/py", server.cwd / "server/py", dirs_exist_ok=True)
        source = root / "scan.pdf"
        scan_pdf(source)

        status, result = upload(base, source, {}, asynchronous=False)
        assert status == 200 and isinstance(result, bytes), (status, result)
        output = root / "sync.pdf"
        output.write_bytes(result)
        assert "Searchable document engineering report" in text_of(output)
        print("PASS synchronous OCR returns independently searchable PDF", flush=True)

        status, job = upload(base, source, {"language": "eng", "deskew": False, "rotatePages": False})
        assert status == 202 and isinstance(job, dict), (status, job)
        done = wait_job(base, job)
        assert done["status"] == "done" and done["result"]["mime"] == "application/pdf", done
        status, data = http(base, done["result"]["url"])
        assert status == 200 and data.startswith(b"%PDF-")
        output = root / "async.pdf"
        output.write_bytes(data)
        assert "Searchable document engineering report" in text_of(output)
        http(base, job["statusUrl"], "DELETE")
        print("PASS async 202 → done → file download", flush=True)

        for params in (None, [], {"language": "fra"}, {"deskew": "true"}, {"force_ocr": True}):
            status, result = upload(base, source, params)
            assert status == 400 and isinstance(result, dict) and not result["ok"], (params, status, result)
        print("PASS invalid requests rejected before job creation", flush=True)

        broken = root / "broken.pdf"
        broken.write_bytes(b"not a PDF")
        status, job = upload(base, broken, {})
        assert status == 202 and isinstance(job, dict), (status, job)
        failed = wait_job(base, job)
        assert failed["status"] == "failed" and "readable PDF" in failed["error"], failed
        http(base, job["statusUrl"], "DELETE")
        print("PASS async malformed PDF reports actionable failure", flush=True)

        many = root / "many.pdf"
        writer = PdfWriter()
        for _ in range(20):
            writer.append(source)
        writer.write(many)
        status, job = upload(base, many, {})
        assert status == 202 and isinstance(job, dict), (status, job)
        deadline = time.monotonic() + 30
        group = None
        while time.monotonic() < deadline:
            snapshot = processes()
            worker = next((row for row in snapshot if str(server.cwd / "server/py/scripts/pdf_tool.py") in row[3]), None)
            if worker:
                group = worker[1]
                if any(row[1] == group and row[2][0] != "Z" and "tesseract" in row[3] for row in snapshot):
                    break
            time.sleep(0.02)
        else:
            raise AssertionError("Never observed real Tesseract descendant")
        started = time.monotonic()
        status, data = http(base, job["statusUrl"], "DELETE")
        assert status == 200 and json.loads(data)["status"] == "cancelled", data
        assert time.monotonic() - started < 5, "cancel should not wait for OCR completion"
        survivors = [row for row in processes() if row[1] == group and row[2][0] not in ("Z", "X")]
        assert not survivors, survivors
        status, data = http(base, job["statusUrl"] + "/file")
        assert status != 200, "cancelled OCR must not publish a partial PDF"
        print("PASS cancel kills real OCRmyPDF/Tesseract group before DELETE returns", flush=True)

        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and list(tmpdir.glob("knife-*")):
            time.sleep(0.05)
        assert not list(tmpdir.glob("knife-*")), list(tmpdir.iterdir())
        print("PASS job input/output/OCR scratch directories cleaned up", flush=True)
        print("6/6 OCR API checks passed", flush=True)


if __name__ == "__main__":
    main()
