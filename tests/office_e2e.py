"""Office sidecar end to end, against REAL docker: install through the API (streamed pull progress), open documents in
the Euro-Office editor with Playwright, type into a docx, save via Ctrl+S (callback status 6) and via closing (status 2),
check the saved bytes, open every blank format, measure RAM and cold start, idle stop + lazy start, knife_doc_* tools,
then remove the sidecar (container + volumes; the image stays cached unless --remove-image).

Isolation: own scratch worktree server (tests/scratch_server.py) bound to the Tailscale address (a container cannot reach
the host's loopback), own KNIFE_DATA_DIR, own port, own compose project (KNIFE_SIDECAR_PREFIX=sk-e2e-<pid>). Never touches
the live :3210 app or other containers.

    python3 tests/office_e2e.py [--host <tailscale-or-LAN-ip>] [--hold] [--remove-image] [--skip-idle]
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scratch_server import ScratchServer  # noqa: E402

from playwright.sync_api import Page, sync_playwright  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []
METRICS: dict[str, object] = {}


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{f' — {detail}' if detail else ''}", flush=True)
    return ok


class Api:
    def __init__(self, base: str) -> None:
        self.base = base

    def call(self, method: str, path: str, body: object | None = None, timeout: float = 60) -> tuple[int, object]:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Origin", self.base)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                raw = res.read()
                ctype = res.headers.get("content-type", "")
                return res.status, json.loads(raw) if "json" in ctype else raw
        except urllib.error.HTTPError as err:
            raw = err.read()
            try:
                return err.code, json.loads(raw)
            except json.JSONDecodeError:
                return err.code, raw

    def wait_op(self, op: dict, timeout: float, samples: list | None = None) -> dict:
        deadline = time.monotonic() + timeout
        last_phase = ""
        while time.monotonic() < deadline:
            _, body = self.call("GET", f"/api/services/ops/{op['opId']}")
            op = body["op"]
            if samples is not None and op.get("pull"):
                samples.append((op["elapsedMs"], op["pull"]["percent"], op["pull"]["downloadedBytes"], op["pull"]["totalBytes"]))
            if op["phase"] != last_phase:
                print(f"    op {op['kind']}: {op['phase']} {op.get('percent', '')}", flush=True)
                last_phase = op["phase"]
            if op["status"] != "running":
                return op
            time.sleep(1)
        raise TimeoutError(f"op {op['kind']} still running after {timeout}s: {op['phase']}")

    def doc(self, doc_id: str) -> dict:
        return self.call("GET", f"/api/office/docs/{doc_id}")[1]["doc"]

    def doc_text(self, doc_id: str) -> str:
        status, raw = self.call("GET", f"/api/office/docs/{doc_id}?download=1")
        assert status == 200, status
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            xml = z.read("word/document.xml").decode()
        return "".join(re.findall(r"<w:t(?:\s[^>]*)?>([^<]*)</w:t>", xml))


def container_names(project: str) -> list[str]:
    out = subprocess.run(["docker", "ps", "-a", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Names}}"], capture_output=True, text=True)
    return [n for n in out.stdout.split() if n]


def mem_mib(name: str) -> float:
    out = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", name], capture_output=True, text=True).stdout.strip()
    m = re.match(r"([\d.]+)\s*([KMG]i?B)", out)
    if not m:
        return -1
    scale = {"KiB": 1 / 1024, "MiB": 1, "GiB": 1024, "KB": 1 / 1000, "MB": 1, "GB": 1000}[m.group(2)]
    return float(m.group(1)) * scale


def wait_editor_ready(page: Page, timeout_ms: int = 240_000) -> str:
    status = page.locator('[data-agent-region="office-editor-status"]')
    status.wait_for(timeout=60_000)
    page.wait_for_function(
        "() => { const t = document.querySelector('[data-agent-region=\"office-editor-status\"]')?.textContent ?? ''; return t.startsWith('Editor ready') || t.startsWith('Could not open'); }",
        timeout=timeout_ms,
    )
    return status.inner_text()


def wait_for(predicate, timeout: float, step: float = 1.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(step)
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("KNIFE_E2E_HOST") or os.environ.get("KNIFE_HOST"))
    parser.add_argument("--hold", action="store_true", help="before cleanup, keep server + sidecar up until Enter (manual poking)")
    parser.add_argument("--remove-image", action="store_true")
    parser.add_argument("--skip-idle", action="store_true")
    args = parser.parse_args()

    prefix = os.environ.get("KNIFE_E2E_SIDECAR_PREFIX") or f"sk-e2e-{os.getpid()}"
    project = f"{prefix}-office"
    server = ScratchServer(host=args.host)
    url = server.start(env={"KNIFE_SIDECAR_PREFIX": prefix})
    api = Api(url)
    print(f"scratch server {url}, data dir {server.data_dir}, compose project {project}", flush=True)
    try:
        status, body = api.call("GET", "/api/services/office")
        svc = body["service"]
        check("status before install: runtime ok, not installed", status == 200 and svc["runtime"]["ok"] and not svc["installed"], json.dumps(svc["runtime"]))

        # ---------------------------------------------------------------- library works without the sidecar
        status, body = api.call("POST", "/api/office/docs", {"action": "create", "format": "docx", "name": "E2E report"})
        check("create docx without sidecar", status == 201, str(status))
        docx = body["doc"]
        status, body = api.call("GET", f"/api/office/docs/{docx['id']}/editor")
        check("editor config refused while not installed (409)", status == 409 and body.get("code") == "sidecar_not_installed", str(body))
        status, _ = api.call("POST", "/api/services/office", {"action": "ensure"})
        check("ensure refused while not installed (409)", status == 409, str(status))
        req = urllib.request.Request(url + "/api/services/office", data=b'{"action":"install"}', method="POST", headers={"Content-Type": "application/json", "Origin": "http://evil.example"})
        try:
            urllib.request.urlopen(req, timeout=10)
            check("install refused from a foreign Origin", False)
        except urllib.error.HTTPError as err:
            check("install refused from a foreign Origin", err.code == 403, str(err.code))

        # ---------------------------------------------------------------- install
        t0 = time.monotonic()
        status, body = api.call("POST", "/api/services/office", {"action": "install"})
        check("install accepted (202 + op)", status == 202 and body["op"]["kind"] == "install", str(status))
        samples: list = []
        op = api.wait_op(body["op"], timeout=3600, samples=samples)
        METRICS["install_s"] = round(time.monotonic() - t0, 1)
        check("install op done", op["status"] == "done", op.get("error") or op["phase"])
        if op["status"] != "done":
            print("\n".join(op["log"][-30:]))
            return 1
        pcts = [s[1] for s in samples]
        METRICS["pull_samples"] = len(samples)
        METRICS["pull_total_bytes"] = max((s[3] for s in samples), default=0)
        check("pull progress was streamed (several increasing samples, or image already cached)", (len(set(pcts)) >= 3 and pcts == sorted(pcts)) or not samples or max(pcts) == 100, f"{len(samples)} samples, distinct {sorted(set(pcts))[:12]}")
        warnings = [line for line in op["log"] if line.startswith("WARNING")]
        check("container can reach the app (ping from inside)", not warnings, "; ".join(warnings))
        status, body = api.call("GET", "/api/services/office?memory=1")
        svc = body["service"]
        check("status: installed, running, healthy", svc["installed"] and svc["ready"] and svc["container"]["state"] == "running", json.dumps(svc["container"]))
        check("published on the scratch host only", svc["publicUrl"].startswith(f"http://{args.host}:"), svc["publicUrl"])
        METRICS["first_start_to_healthy_s"] = round(svc["state"]["lastStartMs"] / 1000, 1)
        METRICS["ram_idle_mib"] = round(mem_mib(svc["container"]["name"]))
        names = container_names(project)
        check("exactly one container in the e2e compose project", len(names) == 1, str(names))
        ports = subprocess.run(["docker", "port", names[0]], capture_output=True, text=True).stdout.strip()
        check("port bound to the scratch host, not 0.0.0.0", ports.count(args.host) >= 1 and "0.0.0.0" not in ports, ports)
        cname = names[0]

        # ---------------------------------------------------------------- editor: open, type, Ctrl+S, close
        marker = f"Knife e2e edit {os.getpid()}"
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1500, "height": 1000})
            console: list[str] = []
            page.on("console", lambda m: console.append(f"{m.type}: {m.text}") if m.type in ("error",) else None)
            t_open = time.monotonic()
            page.goto(f"{url}/tools/office?doc={docx['id']}")
            text = wait_editor_ready(page)
            METRICS["docx_open_s"] = round(time.monotonic() - t_open, 1)
            check("docx opens in the editor", text.startswith("Editor ready"), text)
            frame_title = page.locator("iframe").first.get_attribute("title")
            check("editor iframe titled for the snapshot", (frame_title or "").startswith("Office editor:"), str(frame_title))
            METRICS["ram_one_doc_open_mib"] = round(mem_mib(cname))

            editor = page.frame_locator('iframe[name="frameEditor"]')
            canvas = editor.locator("#editor_sdk")
            canvas.wait_for(timeout=60_000)
            time.sleep(3)
            box = canvas.bounding_box()
            page.mouse.click(box["x"] + box["width"] / 2, box["y"] + 200)
            time.sleep(1)
            page.keyboard.type(marker, delay=40)
            time.sleep(2)
            version_before = api.doc(docx["id"])["version"]
            page.keyboard.press("Control+s")
            saved = wait_for(lambda: api.doc(docx["id"])["version"] > version_before, timeout=90)
            doc_after = api.doc(docx["id"])
            check("Ctrl+S force-saves through the callback (status 6)", bool(saved), f"version {version_before} -> {doc_after['version']}")
            check("force-save kept the session key", doc_after["key"] == docx["key"], f"{docx['key']} -> {doc_after['key']}")
            body_text = api.doc_text(docx["id"])
            check("saved docx contains the typed text", marker in body_text, body_text[:200])

            # Second edit, then close: the session ends and the server sends status 2 with the final document.
            page.mouse.click(box["x"] + box["width"] / 2, box["y"] + 200)
            page.keyboard.press("End")
            page.keyboard.type(" closing", delay=40)
            time.sleep(3)
            key_before_close = api.doc(docx["id"])["key"]
            page.get_by_role("button", name="Close editor").click()
            page.get_by_role("heading", name="Your documents").wait_for(timeout=30_000)
            closed = wait_for(lambda: api.doc(docx["id"])["key"] != key_before_close, timeout=120)
            check("closing the editor saves (status 2) and rotates the key", bool(closed), api.doc(docx["id"])["key"])
            check("final docx has both edits", f"{marker} closing" in api.doc_text(docx["id"]), api.doc_text(docx["id"])[:200])

            # ------------------------------------------------------------ every blank format opens
            for fmt in ["xlsx", "pptx", "odt", "ods", "odp"]:
                status, body = api.call("POST", "/api/office/docs", {"action": "create", "format": fmt, "name": f"E2E {fmt}"})
                d = body["doc"]
                page.goto(f"{url}/tools/office?doc={d['id']}")
                text = wait_editor_ready(page)
                check(f"blank {fmt} opens in the editor", text.startswith("Editor ready"), text)
                page.get_by_role("button", name="Close editor").click()
                page.get_by_role("heading", name="Your documents").wait_for(timeout=30_000)
            METRICS["ram_after_6_docs_mib"] = round(mem_mib(cname))

            # ------------------------------------------------------------ assistant tools
            status, body = api.call("POST", "/api/agent/tool", {"name": "knife_doc_read", "args": {"id": docx["id"]}})
            tool_text = json.dumps(body)
            check("knife_doc_read returns the edited text", status == 200 and marker in tool_text, tool_text[:200])
            status, body = api.call("POST", "/api/agent/tool", {"name": "knife_doc_create", "args": {"format": "pptx", "name": "Agent deck", "slides": [{"title": "Agent slide", "bullets": ["alpha", "beta"]}]}})
            created_text = str(body.get("content", "")) if isinstance(body, dict) else ""
            check("knife_doc_create makes a pptx", status == 200 and "Agent deck.pptx" in created_text, created_text[:200])
            agent_id = re.search(r"([0-9a-f]{16})", created_text)
            if agent_id:
                page.goto(f"{url}/tools/office?doc={agent_id.group(1)}")
                text = wait_editor_ready(page)
                check("assistant-made pptx opens in the editor", text.startswith("Editor ready"), text)
                page.get_by_role("button", name="Close editor").click()

            # ------------------------------------------------------------ cold start + lazy start
            status, body = api.call("POST", "/api/services/office", {"action": "stop"})
            op = api.wait_op(body["op"], timeout=180)
            check("stop op done", op["status"] == "done", op.get("error", ""))
            t_cold = time.monotonic()
            page.goto(f"{url}/tools/office?doc={docx['id']}")
            text = wait_editor_ready(page, timeout_ms=360_000)
            METRICS["cold_open_s"] = round(time.monotonic() - t_cold, 1)
            check("lazy start: opening a document starts the stopped sidecar", text.startswith("Editor ready"), text)
            _, body = api.call("GET", "/api/services/office")
            METRICS["cold_start_to_healthy_s"] = round(body["service"]["state"]["lastStartMs"] / 1000, 1)
            page.get_by_role("button", name="Close editor").click()
            browser.close()
            check("browser console had no DocsAPI load errors", not [c for c in console if "api.js" in c or "DocsAPI" in c], "; ".join(console[:5]))

        # ---------------------------------------------------------------- idle stop
        if not args.skip_idle:
            status, body = api.call("POST", "/api/services/office", {"action": "configure", "idleStopMinutes": 1})
            check("configure idle stop = 1 min", status == 200, str(body))
            stopped = wait_for(lambda: api.call("GET", "/api/services/office")[1]["service"]["container"]["state"] != "running", timeout=300, step=5)
            check("idle stop: the reaper stopped the unused sidecar", bool(stopped), "")

        # ---------------------------------------------------------------- CLI sees the same state
        cli = subprocess.run(["npm", "run", "-s", "services", "--", "status", "office"], cwd=server.cwd, capture_output=True, text=True,
                             env={**os.environ, "KNIFE_DATA_DIR": str(server.data_dir), "KNIFE_HOST": args.host, "KNIFE_PORT": url.rsplit(":", 1)[1], "KNIFE_SIDECAR_PREFIX": prefix})
        check("CLI status reads the same install", "installed: true" in cli.stdout and f"app URL: {url} " in cli.stdout, cli.stdout + cli.stderr[-300:])
    finally:
        if args.hold:
            input(f"--hold: server {url}, data {server.data_dir}; press Enter to clean up ")
        _, body = api.call("POST", "/api/services/office", {"action": "remove", "purge": True, "removeImage": args.remove_image})
        if isinstance(body, dict) and "op" in body:
            op = api.wait_op(body["op"], timeout=300)
            check("remove (purge) op done", op["status"] == "done", op.get("error", ""))
        left = container_names(project)
        vols = subprocess.run(["docker", "volume", "ls", "-q", "--filter", f"label=com.docker.compose.project={project}"], capture_output=True, text=True).stdout.split()
        check("no container or volume of the e2e project left", not left and not vols, f"{left} {vols}")
        server.stop()
    print("\nMETRICS " + json.dumps(METRICS, indent=2))
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
