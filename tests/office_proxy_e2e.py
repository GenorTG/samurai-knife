"""Office editor behind the app's own proxy (scripts/office-proxy.mjs), against REAL docker and a real browser.

A scratch server (private mode, Tailscale/LAN address, own data dir, own compose project) with
KNIFE_OFFICE_PUBLIC_URL=http://office.knife.test:<port>; Chromium maps app.knife.test and office.knife.test to the scratch
address (--host-resolver-rules), so the app and the editor are two origins of one site, as in production. Checks: the
sidecar is published on loopback only; the office host refuses requests without the ticket cookie and every service/admin
path; the editor loads, types, force-saves (callback 6) and saves on close (callback 2) through the proxy; xlsx and pptx
open; no request the editor made was refused by the proxy; the app is never served on the office host. Then removes the
sidecar.

    python3 tests/office_proxy_e2e.py --host <tailscale-or-LAN-ip> [--hold]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from office_e2e import Api, check, container_names, wait_editor_ready, wait_for, RESULTS  # noqa: E402
from scratch_server import ScratchServer, free_port  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

OVERLAY = ["scripts/office-proxy.mjs", "scripts/client-address.mjs", "src/lib/office/proxy.ts", "tests/office_proxy_e2e.py"]


def raw(host: str, port: int, path: str, host_header: str, headers: dict[str, str] | None = None) -> tuple[int, object, str]:
    req = urllib.request.Request(f"http://{host}:{port}{path}", headers={"Host": host_header, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return res.status, res.headers, res.read(2000).decode(errors="replace")
    except urllib.error.HTTPError as err:
        return err.code, err.headers, err.read(2000).decode(errors="replace")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("KNIFE_E2E_HOST") or os.environ.get("KNIFE_HOST"))
    parser.add_argument("--hold", action="store_true")
    args = parser.parse_args()
    if not args.host:
        print("--host <tailscale-or-LAN-ip> is required (a container cannot reach loopback)")
        return 2

    prefix = os.environ.get("KNIFE_E2E_SIDECAR_PREFIX") or f"sk-proxy-{os.getpid()}"
    project = f"{prefix}-office"
    port = free_port(args.host)
    office_host = f"office.knife.test:{port}"
    app_base = f"http://app.knife.test:{port}"
    server = ScratchServer(host=args.host)
    url = server.start(
        env={
            "KNIFE_PORT": str(port),
            "KNIFE_SIDECAR_PREFIX": prefix,
            "KNIFE_OFFICE_PUBLIC_URL": f"http://{office_host}",
            "KNIFE_ALLOWED_HOSTS": "app.knife.test",
            "KNIFE_SECURITY_HEADERS": "1",
        },
        overlay=OVERLAY,
    )
    api = Api(url)
    print(f"scratch server {url}, office host {office_host}, compose project {project}", flush=True)
    try:
        check("server log announces the proxy", "[office-proxy] serving the office editor on" in server.log_tail(20000), server.log_tail(600))
        status, body = api.call("POST", "/api/office/docs", {"action": "create", "format": "docx", "name": "Proxy report"})
        docx = body["doc"]
        status, body = api.call("POST", "/api/services/office", {"action": "install"})
        op = api.wait_op(body["op"], timeout=3600)
        check("install op done", op["status"] == "done", op.get("error") or op["phase"])
        if op["status"] != "done":
            print("\n".join(op["log"][-30:]))
            return 1
        status, body = api.call("GET", "/api/services/office")
        svc = body["service"]
        check("public URL is the proxied office host", svc["publicUrl"] == f"http://{office_host}", svc["publicUrl"])
        names = container_names(project)
        ports = subprocess.run(["docker", "port", names[0]], capture_output=True, text=True).stdout.strip()
        check("sidecar published on 127.0.0.1 only", ports.startswith("80/tcp -> 127.0.0.1:") and args.host not in ports and "0.0.0.0" not in ports, ports)

        # ------------------------------------------------------------ the office host from outside
        status, _, text = raw(args.host, port, "/web-apps/apps/api/documents/api.js", office_host)
        check("api.js without a ticket: 403", status == 403, f"{status} {text[:80]}")
        for path in ["/coauthoring/CommandService.ashx", "/ConvertService.ashx", "/info/info.json", "/internal/cluster/inactive", "/ai-proxy/x", "/admin", "/healthcheck", "/", "/api/account"]:
            status, _, _ = raw(args.host, port, path, office_host)
            check(f"office host refuses {path}", status in (404, 429), str(status))
        status, _, text = raw(args.host, port, "/api/office/docs", office_host)
        check("the app's API is never served on the office host", status in (404, 429) and "docs" not in text, f"{status} {text[:80]}")
        status, body = api.call("GET", f"/api/office/docs/{docx['id']}/editor")
        api_url = body.get("apiUrl", "")
        check("editor config loads api.js from the office host with a ticket", api_url.startswith(f"http://{office_host}/web-apps/apps/api/documents/api.js?knife_ticket=v1."), api_url[:120])
        path = api_url.split(office_host, 1)[1]
        status, headers, _ = raw(args.host, port, path, office_host)
        cookie = headers.get("Set-Cookie") or ""
        check("a valid ticket sets the HttpOnly SameSite=Strict cookie", status == 200 and cookie.startswith("knife_office=v1.") and "HttpOnly" in cookie and "SameSite=Strict" in cookie, f"{status} {cookie[:60]}")
        check("office responses carry frame-ancestors", "frame-ancestors" in (headers.get("Content-Security-Policy") or ""), headers.get("Content-Security-Policy") or "")
        forged = path.replace("knife_ticket=v1.", "knife_ticket=v1.x")
        status, _, _ = raw(args.host, port, forged, office_host)
        check("a forged ticket is refused", status == 403, str(status))
        before_browser = server.log_tail(200000).count("[office-proxy] refused")

        # ------------------------------------------------------------ the editor through the proxy
        marker = f"Proxy e2e edit {os.getpid()}"
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=[f"--host-resolver-rules=MAP app.knife.test {args.host}, MAP office.knife.test {args.host}"])
            page = browser.new_page(viewport={"width": 1500, "height": 1000})
            refused: list[str] = []
            page.on("response", lambda r: refused.append(f"{r.status} {r.url}") if "office.knife.test" in r.url and r.status in (403, 404, 405, 413, 429, 502, 503) else None)
            ws_urls: list[str] = []
            page.on("websocket", lambda ws: ws_urls.append(ws.url))
            page.goto(f"{app_base}/tools/office?doc={docx['id']}")
            text = wait_editor_ready(page)
            check("docx opens in the editor through the proxy", text.startswith("Editor ready"), text)
            frame = page.locator('iframe[name="frameEditor"]')
            check("editor iframe is on the office origin", (frame.get_attribute("src") or "").startswith(f"http://{office_host}/"), frame.get_attribute("src") or "")
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
            check("Ctrl+S force-saves through the proxy (callback 6)", bool(saved), str(api.doc(docx["id"])["version"]))
            check("saved docx contains the typed text", marker in api.doc_text(docx["id"]), api.doc_text(docx["id"])[:200])
            check("the editor's websocket went through the office host", any("office.knife.test" in u and "/doc/" in u for u in ws_urls), str(ws_urls[:3]))
            key_before = api.doc(docx["id"])["key"]
            page.get_by_role("button", name="Close editor").click()
            page.get_by_role("heading", name="Your documents").wait_for(timeout=30_000)
            check("closing saves (callback 2) and rotates the key", bool(wait_for(lambda: api.doc(docx["id"])["key"] != key_before, timeout=120)))
            for fmt in ["xlsx", "pptx"]:
                _, body = api.call("POST", "/api/office/docs", {"action": "create", "format": fmt, "name": f"Proxy {fmt}"})
                page.goto(f"{app_base}/tools/office?doc={body['doc']['id']}")
                text = wait_editor_ready(page)
                check(f"{fmt} opens through the proxy", text.startswith("Editor ready"), text)
                page.get_by_role("button", name="Close editor").click()
                page.get_by_role("heading", name="Your documents").wait_for(timeout=30_000)
            browser.close()
        check("the browser saw no refused office request", not refused, "; ".join(refused[:10]))
        log = server.log_tail(400000)
        new_refusals = [line for line in log.splitlines() if "[office-proxy] refused" in line][before_browser:]
        check("the proxy refused nothing the editor asked for", not new_refusals, "; ".join(new_refusals[:10]))
        if args.hold:
            input(f"holding: app {app_base}, office {office_host}; Enter to clean up")
    finally:
        try:
            status, body = api.call("POST", "/api/services/office", {"action": "remove", "purge": True})
            if status == 202:
                api.wait_op(body["op"], timeout=300)
        except Exception as error:  # noqa: BLE001
            print(f"cleanup: {error}")
        left = container_names(project)
        check("sidecar removed", not left, str(left))
        server.stop()
    failed = [name for name, ok, _ in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed" + (f"; FAILED: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
