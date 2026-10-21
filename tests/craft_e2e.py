"""ArtCraft apps end to end, against REAL docker and the real release zips: install the `craft` sidecar from the ArtCraft
page in Firefox (seven pinned zips downloaded, sha256-checked, unpacked; an unprivileged read-only nginx), then

- check the container hardening (read-only root, no capabilities, uid 101, no-new-privileges, pids cap) and the craft
  origin's headers (application/wasm, gzip twins, caching per app, CSP + frame-ancestors = the app, nosniff, no cookies,
  GET/HEAD only, unknown paths 404);
- open every one of the seven tabs in Firefox: the iframe carries exactly the app's sandbox, the app starts (its canvas is
  sized and drawn, its loading/failure text is gone) and no console message mentions CSP, MIME types or the sandbox;
- PhotoCraft: open a generated PNG through the file input (Ctrl+O) and Quick Export it as PNG (a download whose pixels
  match); PdfCraft: open a generated PDF the same way and save it (Ctrl+S; the download keeps both pages and the text);
- "Open in new tab" serves the same app top-level; stop -> reopen = lazy start; remove + purge leaves no container,
  network, volume or data.

WebGL2 in Firefox needs a display: the suite re-runs itself under `xvfb-run` (Firefox then uses llvmpipe; headless
Firefox has no WebGL2). Over the plain-http Tailscale address WebGPU is off, so the wgpu apps draw
with WebGL2: the same path a browser on the tailnet takes.

Isolation: own scratch worktree server (tests/scratch_server.py) bound to the Tailscale/LAN address, own KNIFE_DATA_DIR,
port and compose project (KNIFE_SIDECAR_PREFIX=sk-craft-e2e-<pid>): never the live :3210 app or its
`samurai-knife-craft` project. The nginx image (~20 MB) stays cached unless --remove-image.

    python3 tests/craft_e2e.py [--host <tailscale-or-LAN-ip>] [--hold] [--remove-image] [--shots DIR] [--only app,app]
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scratch_server import ROOT, ScratchServer  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []
METRICS: dict[str, object] = {}
SERVICE = "craft"
APPS = ["photocraft", "vectorcraft", "filmcraft", "lightcraft", "effectcraft", "designcraft", "pdfcraft"]
NAMES = {"photocraft": "PhotoCraft", "vectorcraft": "VectorCraft", "filmcraft": "FilmCraft", "lightcraft": "LightCraft", "effectcraft": "EffectCraft", "designcraft": "DesignCraft", "pdfcraft": "PdfCraft"}
SANDBOX = {app: "allow-scripts allow-same-origin allow-downloads allow-popups" for app in APPS}
SANDBOX["lightcraft"] += " allow-modals"
# New modules a fresh checkout may not have committed yet (the scratch worktree holds tracked files only).
OVERLAY = ["src/lib/craft", "src/app/api/craft", "src/tools/craft", "src/lib/services/sites.ts", "scripts/craft-proxy.mjs"]
# Console text that means the craft origin's headers or the iframe sandbox got in an app's way. Firefox's own note that
# it does not know the `clipboard-read`/`clipboard-write` permission names (the iframe's `allow`, from the apps' notes)
# is not one of them.
BAD_CONSOLE = re.compile(r"content[- ]security[- ]policy|\bCSP\b|MIME|sandbox|Refused to|was blocked|NS_ERROR_CORRUPTED_CONTENT", re.I)
BENIGN = re.compile(r"Feature Policy: Skipping unsupported feature name|preloaded with link preload was not used")


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{f' — {detail}' if detail else ''}", flush=True)
    return ok


def default_host() -> str | None:
    host = os.environ.get("KNIFE_E2E_HOST") or os.environ.get("KNIFE_HOST")
    if host:
        return host
    for env in (ROOT / ".env.local", ROOT.parent / "Samurai-Knife" / ".env.local"):
        if env.exists():
            for line in env.read_text().splitlines():
                if line.startswith("KNIFE_HOST="):
                    return line.split("=", 1)[1].strip().strip('"') or None
    return None


class Api:
    def __init__(self, base: str) -> None:
        self.base = base

    def call(self, method: str, path: str, body: object | None = None, timeout: float = 60) -> tuple[int, dict]:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Origin", self.base)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.status, json.loads(res.read() or b"{}")
        except urllib.error.HTTPError as err:
            raw = err.read()
            try:
                return err.code, json.loads(raw)
            except json.JSONDecodeError:
                return err.code, {"raw": raw.decode(errors="replace")}

    def wait_op(self, op: dict, timeout: float) -> dict:
        deadline = time.monotonic() + timeout
        last = ""
        while time.monotonic() < deadline:
            _, body = self.call("GET", f"/api/services/ops/{op['opId']}")
            op = body["op"]
            if op["phase"] != last:
                print(f"    op {op['kind']}: {op['phase']} {op.get('percent', '')}", flush=True)
                last = op["phase"]
            if op["status"] != "running":
                return op
            time.sleep(1)
        raise TimeoutError(f"op {op['kind']} still running after {timeout}s")


def head(url: str, method: str = "GET", headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], bytes]:
    req = urllib.request.Request(url, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, {k.lower(): v for k, v in res.headers.items()}, res.read()
    except urllib.error.HTTPError as err:
        return err.code, {k.lower(): v for k, v in err.headers.items()}, err.read()


def docker_lines(*args: str) -> list[str]:
    out = subprocess.run(["docker", *args], capture_output=True, text=True)
    return [line for line in out.stdout.split() if line]


def sample_png(path: Path) -> None:
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (640, 400), (30, 90, 160))
    draw = ImageDraw.Draw(image)
    draw.ellipse((220, 100, 420, 300), fill=(250, 200, 40))
    draw.rectangle((40, 40, 160, 160), fill=(200, 40, 60))
    image.save(path)


def sample_pdf(path: Path) -> None:
    sys.path.insert(0, str(ROOT))
    from tests.coverage.fixtures import make_pdf

    path.write_bytes(make_pdf(["ArtCraft PDF page one", "Second page here"]))


def pdf_facts(path: Path) -> tuple[int, str]:
    """(pages, text): pypdf from the Python lane's venv when present, else a byte-level count of /Type /Page."""
    venv = ROOT.parent / "samurai-knife-py" / "venv" / "bin" / "python"
    if venv.exists():
        out = subprocess.run([str(venv), "-I", "-c", "import json,sys,pypdf; r=pypdf.PdfReader(sys.argv[1]); print(json.dumps([len(r.pages), ' '.join(p.extract_text() or '' for p in r.pages)]))", str(path)],
                             capture_output=True, text=True)
        if out.returncode == 0:
            pages, text = json.loads(out.stdout)
            return pages, text
    data = path.read_bytes()
    return len(re.findall(rb"/Type\s*/Page[^s]", data)), data.decode("latin-1")


def drawn(png: bytes) -> int:
    """Distinct colours in a screenshot (a blank or failed canvas has a handful)."""
    from PIL import Image

    return len(Image.open(io.BytesIO(png)).convert("RGB").getcolors(1 << 20) or [])


APP_READY_JS = """() => {
  const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const loading = [...document.querySelectorAll('#loading, [id$=_loading]')].some((el) => el.offsetParent !== null && el.textContent.trim());
  const failed = /failed to (start|load)|stopped working/i.test(document.body.innerText);
  return { ready: Boolean(canvas && canvas.width > 300 && canvas.height > 150 && !loading && !failed), canvas: canvas ? [canvas.width, canvas.height] : null, loading, failed, text: document.body.innerText.slice(0, 200), secure: isSecureContext };
}"""


def wait_app(page, app: str, timeout_s: float = 180) -> dict:
    frame = None
    deadline = time.monotonic() + timeout_s
    last: dict = {}
    while time.monotonic() < deadline:
        frame = frame or next((f for f in page.frames if f"/{app}/" in f.url), None)
        if frame:
            try:
                last = frame.evaluate(APP_READY_JS)
                if last["ready"] or last["failed"]:
                    return last
            except Exception as err:  # navigation inside the frame (FilmCraft may reload itself with ?webgl)
                last = {"error": str(err)[:200]}
                frame = None
        time.sleep(1)
    return last


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=default_host())
    parser.add_argument("--hold", action="store_true", help="before cleanup, keep server + sidecar up until Enter")
    parser.add_argument("--remove-image", action="store_true")
    parser.add_argument("--shots", default=str(ROOT / ".tmp" / "craft-e2e"))
    parser.add_argument("--only", default=",".join(APPS), help="comma-separated app ids to open")
    args = parser.parse_args()
    if not args.host:
        print("Need --host (the Tailscale/LAN address; the browser reaches the sidecar there).")
        return 2
    # Always a private X server: a DISPLAY inherited from a desktop session may be gone (or someone's real screen).
    if shutil.which("xvfb-run") and not os.environ.get("CRAFT_E2E_XVFB"):
        os.environ["CRAFT_E2E_XVFB"] = "1"
        return subprocess.call(["xvfb-run", "-a", "-s", "-screen 0 1920x1400x24", sys.executable, *sys.argv])
    from playwright.sync_api import sync_playwright

    shots = Path(args.shots)
    shots.mkdir(parents=True, exist_ok=True)
    work = shots / "files"
    work.mkdir(exist_ok=True)
    sample_png(work / "sample.png")
    sample_pdf(work / "sample.pdf")
    only = [app for app in args.only.split(",") if app in APPS]

    prefix = os.environ.get("KNIFE_E2E_SIDECAR_PREFIX") or f"sk-craft-e2e-{os.getpid()}"
    project = f"{prefix}-{SERVICE}"
    server = ScratchServer(host=args.host)
    url = server.start(env={"KNIFE_SIDECAR_PREFIX": prefix}, overlay=OVERLAY)
    api = Api(url)
    print(f"scratch server {url}, data dir {server.data_dir}, compose project {project}", flush=True)
    try:
        status, body = api.call("GET", f"/api/services/{SERVICE}")
        svc = body["service"]
        check("status before install: runtime ok, not installed", status == 200 and svc["runtime"]["ok"] and not svc["installed"], json.dumps(svc["runtime"])[:200])
        status, body = api.call("GET", "/api/craft")
        check("launch URLs before install: 409 not_installed", status == 409, str(body)[:200])

        with sync_playwright() as pw:
            browser = pw.firefox.launch(headless=False)
            context = browser.new_context(viewport={"width": 1600, "height": 1300}, accept_downloads=True)
            page = context.new_page()
            console: list[str] = []
            page.on("console", lambda msg: msg.type in ("error", "warning") and console.append(f"[{msg.type}] {msg.text}"))
            page.on("pageerror", lambda err: console.append(f"[pageerror] {err}"))

            # Install from the page (the compact sidecar card).
            page.goto(f"{url}/tools/artcraft?tab=photocraft")
            install = page.get_by_role("button", name="Install ArtCraft apps")
            install.wait_for(timeout=60_000)
            check("ArtCraft page shows the install card while not installed", install.is_visible())
            page.screenshot(path=str(shots / "00-not-installed.png"))
            t0 = time.monotonic()
            install.click()
            page.locator("main [role=status]", has_text="PhotoCraft loaded from").first.wait_for(timeout=600_000)
            METRICS["install_to_loaded_s"] = round(time.monotonic() - t0, 1)
            check("install from the page: downloads, verifies, starts, loads PhotoCraft", True, f"{METRICS['install_to_loaded_s']} s")

            status, body = api.call("GET", f"/api/services/{SERVICE}")
            svc = body["service"]
            origin = svc["publicUrl"]
            check("running, healthy, published on its own port of the app's address", svc["ready"] and origin.startswith(f"http://{args.host}:") and origin != url, origin)
            check("no warnings after install", not svc["warnings"], "; ".join(svc["warnings"]))
            assets = Path(server.data_dir) / "services" / SERVICE / "assets"
            folders = sorted(p.name for p in assets.iterdir())
            check("assets: one versioned folder per app + one config, no leftovers", len(folders) == 8 and sum(f.startswith("conf-") for f in folders) == 1 and not any(f.startswith(".") for f in folders), " ".join(folders))
            check("downloads removed after unpacking", not (Path(server.data_dir) / "services" / SERVICE / "downloads").exists())

            # Container hardening.
            name = next(iter(docker_lines("ps", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Names}}")), "")
            inspect = json.loads(subprocess.run(["docker", "inspect", name], capture_output=True, text=True).stdout or "[{}]")[0]
            host_config = inspect.get("HostConfig", {})
            check("container: read-only root, cap_drop ALL, no cap_add, no-new-privileges, pids 64, 256 MiB",
                  host_config.get("ReadonlyRootfs") is True and host_config.get("CapDrop") == ["ALL"] and not host_config.get("CapAdd")
                  and "no-new-privileges:true" in (host_config.get("SecurityOpt") or []) and host_config.get("PidsLimit") == 64
                  and host_config.get("Memory") == 256 * 1024 * 1024, json.dumps({k: host_config.get(k) for k in ("ReadonlyRootfs", "CapDrop", "CapAdd", "SecurityOpt", "PidsLimit", "Memory")}))
            user = subprocess.run(["docker", "exec", name, "id", "-u"], capture_output=True, text=True).stdout.strip()
            check("nginx runs as uid 101 (not root)", user == "101", user)
            mounts = [(m.get("Destination"), m.get("RW")) for m in inspect.get("Mounts", [])]
            check("only the assets folder is mounted, read-only", mounts == [("/srv/craft", False)], str(mounts))

            # The craft origin's headers.
            status, headers, body_bytes = head(f"{origin}/photocraft/")
            csp = headers.get("content-security-policy", "")
            check("index: 200 no-cache, nosniff, no cookie", status == 200 and headers.get("cache-control") == "no-cache" and headers.get("x-content-type-options") == "nosniff" and "set-cookie" not in headers, json.dumps(headers)[:300])
            check("CSP: wasm-unsafe-eval, no unsafe-eval, frame-ancestors = this app", "'wasm-unsafe-eval'" in csp and "'unsafe-eval'" not in csp and re.search(rf"frame-ancestors [^;]*{re.escape(url)}", csp) is not None, csp[-200:])
            status, headers, _ = head(f"{origin}/vectorcraft/" + next(p.name for p in (assets / next(f for f in folders if f.startswith("vectorcraft"))  / "vectorcraft").glob("*_bg.wasm")), "HEAD", {"Accept-Encoding": "gzip"})
            check("hash-named wasm: application/wasm, gzip twin, immutable", status == 200 and headers.get("content-type") == "application/wasm" and headers.get("content-encoding") == "gzip" and "immutable" in headers.get("cache-control", ""), json.dumps(headers)[:300])
            status, headers, _ = head(f"{origin}/lightcraft/lightcraft_web_bg.wasm", "HEAD", {"Accept-Encoding": "gzip"})
            check("LightCraft wasm (same name every release): revalidated, not immutable", status == 200 and headers.get("cache-control") == "no-cache", json.dumps(headers)[:300])
            status, headers, _ = head(f"{origin}/photocraft/app/parts.txt")
            check("PhotoCraft parts.txt revalidates", status == 200 and headers.get("cache-control") == "no-cache")
            part = next(p.name for p in (assets / next(f for f in folders if f.startswith("photocraft")) / "photocraft" / "app").glob("*.part-*"))
            status, headers, _ = head(f"{origin}/photocraft/app/{part}", "HEAD", {"Accept-Encoding": "gzip"})
            check("PhotoCraft wasm part: byte for byte (no Content-Encoding), immutable", status == 200 and "content-encoding" not in headers and "immutable" in headers.get("cache-control", ""), json.dumps(headers)[:300])
            check("POST refused (405), unknown path 404, dotfile 404",
                  head(f"{origin}/photocraft/", "POST")[0] == 405 and head(f"{origin}/nope")[0] == 404 and head(f"{origin}/photocraft/.htaccess")[0] == 404 and head(f"{origin}/")[0] == 404)
            status, headers, _ = head(f"{origin}/pdfcraft")
            check("/pdfcraft -> relative redirect to /pdfcraft/", status in (200, 301) and (status == 200 or headers.get("location") == "/pdfcraft/"), f"{status} {headers.get('location')}")

            # Every app in its tab.
            for app in only:
                console.clear()
                t1 = time.monotonic()
                page.goto(f"{url}/tools/artcraft?tab={app}")
                page.locator("main [role=status]", has_text=f"{NAMES[app]} loaded from").first.wait_for(timeout=180_000)
                frame_el = page.locator(f"[data-craft-app={app}] iframe")
                sandbox = frame_el.get_attribute("sandbox")
                check(f"{app}: iframe sandbox is exactly the README's", sandbox == SANDBOX[app], sandbox or "")
                state = wait_app(page, app)
                METRICS[f"{app}_start_s"] = round(time.monotonic() - t1, 1)
                time.sleep(3)
                frame_el.scroll_into_view_if_needed()
                png = frame_el.screenshot(path=str(shots / f"10-{app}.png"))
                colours = drawn(png)
                check(f"{app}: starts and draws its UI (WebGL2 over plain http)", bool(state.get("ready")) and colours > 40, f"{METRICS[f'{app}_start_s']} s, canvas {state.get('canvas')}, {colours} colours, {state.get('text', '')[:80]!r}")
                bad = [line for line in console if BAD_CONSOLE.search(line) and not BENIGN.search(line)]
                check(f"{app}: no console message about CSP, MIME or the sandbox", not bad, " | ".join(bad[:3])[:400])
                METRICS[f"{app}_console_errors"] = sum(1 for line in console if line.startswith("[error]") or line.startswith("[pageerror]"))

            if "photocraft" in only:
                page.goto(f"{url}/tools/artcraft?tab=photocraft")
                page.locator("main [role=status]", has_text="PhotoCraft loaded from").first.wait_for(timeout=120_000)
                wait_app(page, "photocraft")
                frame_el = page.locator("[data-craft-app=photocraft] iframe")
                frame_el.scroll_into_view_if_needed()
                box = frame_el.bounding_box()
                page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                with page.expect_file_chooser(timeout=15_000) as chooser:
                    page.keyboard.press("Control+o")
                chooser.value.set_files(str(work / "sample.png"))
                time.sleep(5)
                frame_el.screenshot(path=str(shots / "20-photocraft-opened.png"))
                page.mouse.click(box["x"] + 58, box["y"] + 16)  # File
                time.sleep(1)
                page.mouse.move(box["x"] + 95, box["y"] + 388)  # Export >
                time.sleep(1)
                page.mouse.move(box["x"] + 300, box["y"] + 388)
                page.mouse.move(box["x"] + 370, box["y"] + 388)  # Quick Export as PNG
                time.sleep(0.5)
                frame_el.screenshot(path=str(shots / "21-photocraft-export-menu.png"))
                with page.expect_download(timeout=30_000) as download:
                    page.mouse.click(box["x"] + 370, box["y"] + 388)
                out = work / f"exported-{download.value.suggested_filename}"
                download.value.save_as(str(out))
                from PIL import Image

                image = Image.open(out).convert("RGB")
                check("PhotoCraft: PNG opened via the file input and exported as a download with the same pixels",
                      image.size == (640, 400) and image.getpixel((320, 200)) == (250, 200, 40) and image.getpixel((100, 100)) == (200, 40, 60) and image.getpixel((600, 360)) == (30, 90, 160),
                      f"{out.name} {image.size} {image.getpixel((320, 200))}")

            if "pdfcraft" in only:
                page.goto(f"{url}/tools/artcraft?tab=pdfcraft")
                page.locator("main [role=status]", has_text="PdfCraft loaded from").first.wait_for(timeout=120_000)
                wait_app(page, "pdfcraft")
                time.sleep(3)
                frame_el = page.locator("[data-craft-app=pdfcraft] iframe")
                frame_el.scroll_into_view_if_needed()
                box = frame_el.bounding_box()
                page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] - 30)
                with page.expect_file_chooser(timeout=15_000) as chooser:
                    page.keyboard.press("Control+o")
                chooser.value.set_files(str(work / "sample.pdf"))
                time.sleep(5)
                frame_el.screenshot(path=str(shots / "30-pdfcraft-opened.png"))
                with page.expect_download(timeout=30_000) as download:
                    page.keyboard.press("Control+s")
                out = work / f"saved-{download.value.suggested_filename}"
                download.value.save_as(str(out))
                pages, text = pdf_facts(out)
                check("PdfCraft: PDF opened via the file input and saved as a download (2 pages, text kept)",
                      out.read_bytes().startswith(b"%PDF") and pages == 2 and "ArtCraft PDF page one" in text and "Second page here" in text, f"{out.name}, {pages} pages")

            # "Open in new tab" = the same app, top-level on the craft origin.
            page.goto(f"{url}/tools/artcraft?tab=designcraft")
            page.locator("main [role=status]", has_text="DesignCraft loaded from").first.wait_for(timeout=120_000)
            link = page.get_by_role("link", name="Open in new tab")
            check("Open in new tab: target=_blank, rel noopener noreferrer, the craft URL", link.get_attribute("target") == "_blank" and "noopener" in (link.get_attribute("rel") or "") and (link.get_attribute("href") or "") == f"{origin}/designcraft/", link.get_attribute("href") or "")
            with context.expect_page() as popup_info:
                link.click()
            popup = popup_info.value
            popup.wait_for_load_state()
            ready = {}
            for _ in range(120):
                ready = popup.evaluate(APP_READY_JS)
                if ready["ready"] or ready["failed"]:
                    break
                time.sleep(1)
            popup.screenshot(path=str(shots / "40-designcraft-new-tab.png"))
            check("DesignCraft starts top-level in its own tab", bool(ready.get("ready")), json.dumps(ready)[:200])
            popup.close()

            # Stop, then open a tab again: lazy start.
            status, body = api.call("POST", f"/api/services/{SERVICE}", {"action": "stop"})
            op = api.wait_op(body["op"], 120)
            check("stop op done", op["status"] == "done", op.get("error") or op["phase"])
            check("stopped: the craft origin no longer answers", head_fails(f"{origin}/healthz"))
            t2 = time.monotonic()
            page.goto(f"{url}/tools/artcraft?tab=filmcraft")
            page.locator("main [role=status]", has_text="FilmCraft loaded from").first.wait_for(timeout=180_000)
            state = wait_app(page, "filmcraft")
            METRICS["lazy_start_to_loaded_s"] = round(time.monotonic() - t2, 1)
            check("lazy start: opening a tab starts the stopped sidecar and the app loads", bool(state.get("ready")), f"{METRICS['lazy_start_to_loaded_s']} s")
            page.screenshot(path=str(shots / "50-lazy-start.png"))

            status, body = api.call("GET", f"/api/services/{SERVICE}?memory=1")
            METRICS["memory"] = (body["service"].get("memory") or {}).get("text")
            browser.close()

        if args.hold:
            input(f"Holding {url} (project {project}); press Enter to clean up… ")
    finally:
        status, body = api.call("POST", f"/api/services/{SERVICE}", {"action": "remove", "purge": True, **({"removeImage": True} if args.remove_image else {})})
        if status == 202:
            try:
                op = api.wait_op(body["op"], 300)
                check("remove + purge op done", op["status"] == "done", op.get("error") or op["phase"])
            except TimeoutError as err:
                check("remove + purge op done", False, str(err))
        else:
            check("remove + purge accepted", False, str(body)[:200])
        left_files = sorted(str(p.relative_to(Path(server.data_dir))) for p in (Path(server.data_dir) / "services" / SERVICE).rglob("*")) if (Path(server.data_dir) / "services" / SERVICE).exists() else []
        check("purge deleted the sidecar's apps, config and secrets", not left_files, " ".join(left_files[:10]))
        # Backstop when the API could not clean up: only this run's own project label is ever touched.
        for name in docker_lines("ps", "-a", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Names}}"):
            if name.startswith(prefix):
                subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        for kind in ("volume", "network"):
            for name in docker_lines(kind, "ls", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Name}}"):
                if name.startswith(prefix):
                    subprocess.run(["docker", kind, "rm", name], capture_output=True)
        left = docker_lines("ps", "-a", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Names}}")
        networks = docker_lines("network", "ls", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Name}}")
        check("no container or network of the e2e project left", not left and not networks, f"{left} {networks}")
        server.stop()

    failed = [name for name, ok, _ in RESULTS if not ok]
    print(f"\nmetrics: {json.dumps(METRICS)}")
    print(f"screenshots: {shots}")
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    if failed:
        print(f"{len(failed)} FAILED: {failed}")
        return 1
    return 0


def head_fails(url: str) -> bool:
    try:
        urllib.request.urlopen(url, timeout=5)
        return False
    except Exception:  # noqa: BLE001 - refused / reset / timeout all mean "not answering"
        return True


if __name__ == "__main__":
    sys.exit(main())
