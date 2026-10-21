"""ArtCraft apps end to end, against REAL docker and the real release zips: install the `craft` sidecar from the ArtCraft
page in Firefox (thirteen pinned zips downloaded, sha256-checked, unpacked; an unprivileged read-only nginx), then

- check the container hardening (read-only root, no capabilities, uid 101, no-new-privileges, pids cap) and the craft
  origin's headers (application/wasm, gzip twins, caching per app, CSP + frame-ancestors = the app, nosniff, no cookies,
  GET/HEAD only, unknown paths 404);
- open every one of the thirteen tabs in Firefox: the iframe carries exactly the app's sandbox and `allow`, the app starts (its canvas is
  sized and drawn, its loading/failure text is gone) and no console message mentions CSP, MIME types or the sandbox;
- PhotoCraft: open a generated PNG through the file input (Ctrl+O) and Quick Export it as PNG (a download whose pixels
  match); PdfCraft: open a generated PDF the same way and save it (Ctrl+S; the download keeps both pages and the text);
  WordCraft: open a generated .docx (File > Open > Browse…), type a paragraph, save (Ctrl+S; the downloaded .docx holds
  the old and the typed text); GridCraft: open a CSV (File > Open > Browse…), add a formula, File > Export > CSV (the
  download holds the rows and the computed value);
- the unpacked size per app and the container's memory after all thirteen apps were loaded (metrics line);
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


class FakeGithub:
    """GitHub's releases API + asset downloads on loopback (KNIFE_CRAFT_RELEASES_API / KNIFE_CRAFT_DOWNLOAD_BASE):
    `releases[app]` = list of (version, zip bytes); every other app lists nothing."""

    def __init__(self) -> None:
        import hashlib
        import http.server
        import socket
        import threading

        self.releases: dict[str, list[tuple[str, bytes]]] = {}
        self.calls: list[str] = []
        outer = self
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.base = f"http://127.0.0.1:{self.port}"

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args: object) -> None:
                pass

            def do_GET(self) -> None:  # noqa: N802
                outer.calls.append(self.path)
                m = re.match(r"^/repos/storytold/([a-z]+)/releases\?per_page=20$", self.path)
                if m:
                    app = m.group(1)
                    listing = [{
                        "tag_name": f"v{version}", "draft": False, "prerelease": False, "published_at": "2026-10-21T12:00:00Z",
                        "assets": [{"name": f"{app}-web-{version}.zip", "size": len(data), "digest": "sha256:" + hashlib.sha256(data).hexdigest(),
                                    "browser_download_url": f"{outer.base}/storytold/{app}/releases/download/v{version}/{app}-web-{version}.zip"}],
                    } for version, data in outer.releases.get(app, [])]
                    body = json.dumps(listing).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                m = re.match(r"^/storytold/([a-z]+)/releases/download/v([0-9.]+)/[a-z]+-web-[0-9.]+\.zip$", self.path)
                data = next((d for v, d in outer.releases.get(m.group(1), []) if v == m.group(2)), None) if m else None
                if data is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()


def repack(release_root: Path, app: str, version: str) -> bytes:
    """The unpacked release (no .gz twins) as `<app>-web-<version>.zip`: a "newer" upstream release with real content."""
    import zipfile

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{app}-web-{version}/", "")
        for path in sorted(release_root.rglob("*")):
            if path.is_file() and not path.name.endswith(".gz"):
                zf.write(path, f"{app}-web-{version}/{path.relative_to(release_root).as_posix()}")
    return buffer.getvalue()

RESULTS: list[tuple[str, bool, str]] = []
METRICS: dict[str, object] = {}
SERVICE = "craft"
APPS = ["photocraft", "vectorcraft", "filmcraft", "lightcraft", "effectcraft", "designcraft", "pdfcraft",
        "figcraft", "wordcraft", "soundcraft", "deckcraft", "cadcraft", "gridcraft"]
NAMES = {"photocraft": "PhotoCraft", "vectorcraft": "VectorCraft", "filmcraft": "FilmCraft", "lightcraft": "LightCraft", "effectcraft": "EffectCraft", "designcraft": "DesignCraft", "pdfcraft": "PdfCraft",
         "figcraft": "FigCraft", "wordcraft": "WordCraft", "soundcraft": "SoundCraft", "deckcraft": "DeckCraft", "cadcraft": "CADCraft", "gridcraft": "GridCraft"}
# Each README's "Sandboxed iframes need at least …" and its embedding example's `allow`.
SANDBOX = {app: "allow-scripts allow-same-origin allow-downloads allow-popups" for app in APPS}
SANDBOX["lightcraft"] += " allow-modals"
SANDBOX["figcraft"] = "allow-scripts allow-same-origin allow-popups"
SANDBOX["soundcraft"] = "allow-scripts allow-same-origin"
ALLOW = {app: "fullscreen; clipboard-read; clipboard-write" for app in APPS}
ALLOW["soundcraft"] = "fullscreen; autoplay; clipboard-read; clipboard-write"
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

    def raw(self, path: str) -> tuple[int, bytes, dict]:
        req = urllib.request.Request(self.base + path)
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return res.status, res.read(), {k.lower(): v for k, v in res.headers.items()}
        except urllib.error.HTTPError as err:
            return err.code, err.read(), {}

    def craft_files(self) -> list[dict]:
        _, body = self.call("GET", "/api/craft/files")
        return body.get("files", [])

    def wait_saved(self, app: str, suffix: str, after: str = "", timeout: float = 60) -> dict | None:
        """The newest Craft file of `app` ending in `suffix` saved after `after` (ISO), or None."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            hit = next((f for f in self.craft_files() if f["app"] == app and f["name"].lower().endswith(suffix) and f["updatedAt"] > after), None)
            if hit:
                return hit
            time.sleep(1)
        return None

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


def sample_docx(path: Path, paragraphs: list[str]) -> None:
    """A minimal WordprocessingML package (content types, the package relationship, one document part)."""
    import zipfile

    body = "".join(f'<w:p><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>' for text in paragraphs)
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        z.writestr("word/document.xml", f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>')


def docx_text(path: Path) -> str:
    import zipfile

    with zipfile.ZipFile(path) as z:
        return re.sub(r"<[^>]+>", " ", z.read("word/document.xml").decode())


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


def open_from_computer(page, app: str, path: Path, trigger) -> bool:
    """The app asks for a file (`trigger`): Smart Knife's chooser appears (no native picker inside the app), and its
    "From this computer…" button opens this page's own picker, which gets `path`."""
    trigger()
    drawer = page.get_by_role("dialog", name=f"Open in {NAMES[app]}")
    drawer.wait_for(timeout=15_000)
    with page.expect_file_chooser(timeout=15_000) as chooser:
        drawer.get_by_role("button", name="From this computer…").click()
    chooser.value.set_files(str(path))
    drawer.wait_for(state="hidden", timeout=15_000)
    return True


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
    sample_docx(work / "sample.docx", ["ArtCraft WordCraft opening line", "Second paragraph here"])
    (work / "sample.csv").write_text("name,qty,price\napple,3,1.5\npear,4,2.25\nplum,10,0.4\n")
    only = [app for app in args.only.split(",") if app in APPS]

    prefix = os.environ.get("KNIFE_E2E_SIDECAR_PREFIX") or f"sk-craft-e2e-{os.getpid()}"
    project = f"{prefix}-{SERVICE}"
    github = FakeGithub()
    server = ScratchServer(host=args.host)
    url = server.start(env={"KNIFE_SIDECAR_PREFIX": prefix, "KNIFE_CRAFT_RELEASES_API": github.base, "KNIFE_CRAFT_DOWNLOAD_BASE": github.base, "KNIFE_CRAFT_UPDATES": "off"}, overlay=OVERLAY)
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
            install = page.get_by_role("button", name="Install Craft apps")
            install.wait_for(timeout=60_000)
            check("Craft apps page shows the install card while not installed", install.is_visible())
            # Brand terms (docs/LEGAL.md): the suite's own name never carries the ArtCraft name.
            heading = page.locator("main h1").first.inner_text()
            check("suite title is neutral (no ArtCraft in our own name)", "ArtCraft" not in heading and "Craft apps" in heading, heading)
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
            service_dir = Path(server.data_dir) / "services" / SERVICE
            config_folders = sorted(p.name for p in (service_dir / "assets").iterdir())
            check("assets (root-approved bundle): just the generated config", len(config_folders) == 1 and config_folders[0].startswith("conf-"), " ".join(config_folders))
            releases = service_dir / "releases"
            folders = sorted(p.name for p in releases.iterdir())
            check("releases: one versioned folder per app, no leftovers", len(folders) == len(APPS) and not any(f.startswith(".") for f in folders), " ".join(folders))
            content = Path(server.data_dir) / "services" / f"{SERVICE}-content"
            served = {p.name: (p / ".knife-version").read_text().split()[0] for p in content.iterdir() if not p.name.startswith(".") and p.name != "knife-bridge"}
            check("content dir: Smart Knife's bridge page next to the apps", (content / "knife-bridge" / "bridge.js").is_file() and (content / "knife-bridge" / ".knife-version").read_text().startswith("bridge "))
            check("content dir: every app linked with its version marker", sorted(served) == sorted(APPS) and all(f.startswith(f"{a}-{v}-") for a, v in served.items() for f in folders if f.startswith(f"{a}-")), json.dumps(served)[:300])
            assets = releases  # where the unpacked files are, for the header checks below
            check("downloads removed after unpacking", not any((service_dir / "downloads").glob("*")) if (service_dir / "downloads").exists() else True)
            sizes = {f.split("-")[0]: sum(p.stat().st_size for p in (releases / f).rglob("*") if p.is_file()) for f in folders}
            METRICS["unpacked_mb"] = {app: round(size / 1e6, 1) for app, size in sizes.items()}
            METRICS["unpacked_total_mb"] = round(sum(sizes.values()) / 1e6, 1)

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
            check("only the config and the content are mounted, both read-only", sorted(mounts) == [("/srv/craft", False), ("/srv/craft-content", False)], str(mounts))

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
                allow = frame_el.get_attribute("allow")
                check(f"{app}: iframe sandbox and allow are exactly the README's", sandbox == SANDBOX[app] and allow == ALLOW[app], f"{sandbox} | {allow}")
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
                credit = page.locator(f"[data-craft-app={app}] [data-craft-credit]").inner_text()
                check(f"{app}: credit line names the ArtCraft team, the licence and no endorsement", "by the ArtCraft team and contributors" in credit and "MIT OR Apache-2.0" in credit and "Not affiliated with or endorsed" in credit, credit[:200])
                if app in ("photocraft", "soundcraft"):
                    page.locator(f"[data-craft-app={app}]").get_by_role("button", name="licences & notices").click()
                    drawer = page.get_by_role("dialog", name=f"{NAMES[app]}: licences & notices")
                    drawer.locator("summary", has_text="LICENSE-MIT").wait_for(timeout=60_000)
                    names = drawer.locator("summary").all_inner_texts()
                    drawer.locator("summary", has_text="NOTICE").first.click()
                    notice = drawer.locator("details[open] pre").first.inner_text()
                    page.screenshot(path=str(shots / f"16-{app}-notices.png"))
                    check(f"{app}: notices show both licences, the repository NOTICE and its third-party files", any("LICENSE-MIT" in n for n in names) and any("LICENSE-APACHE" in n for n in names) and any(n.startswith("NOTICE") for n in names) and len(names) >= 4 and "ArtCraft" in notice, " | ".join(names)[:300])
                    drawer.get_by_role("button", name=f"Close {NAMES[app]}: licences & notices").click()
                full = page.locator(f"[data-craft-app={app}]").get_by_role("button", name="Full screen")
                if app in ("photocraft", "lightcraft"):
                    # Full screen: the iframe itself becomes the fullscreen element and fills the viewport; leaving it restores the tab.
                    full.click()
                    page.wait_for_function("() => document.fullscreenElement?.tagName === 'IFRAME'", timeout=10_000)
                    fs = page.evaluate("() => { const r = document.fullscreenElement.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight, title: document.fullscreenElement.title }; }")
                    shot = page.screenshot(path=str(shots / f"15-{app}-fullscreen.png"))
                    check(f"{app}: Full screen puts the app's iframe over the whole screen", fs["w"] >= fs["vw"] - 2 and fs["h"] >= fs["vh"] - 2 and NAMES[app] in fs["title"] and drawn(shot) > 40, json.dumps(fs))
                    page.evaluate("() => document.exitFullscreen()")
                    page.wait_for_function("() => document.fullscreenElement === null", timeout=10_000)
                    try:  # the page may be busy: Playwright's Firefox runs the cross-origin app in the same process (no Fission)
                        page.wait_for_function("() => [...document.querySelectorAll('[data-craft-app=%s] button[aria-pressed]')].some((b) => b.getAttribute('aria-pressed') === 'false')" % app, timeout=10_000)
                    except Exception:
                        pass
                    after = page.evaluate("""() => { const box = document.querySelector('[data-craft-app=%s]'); const b = [...box.querySelectorAll('button')].map((x) => [x.textContent, x.getAttribute('aria-pressed')]); return { buttons: b, fs: String(document.fullscreenElement), active: document.activeElement?.tagName }; }""" % app)
                    check(f"{app}: leaving full screen restores the tab (button back to 'Full screen')", full.is_visible() and full.get_attribute("aria-pressed") == "false", json.dumps(after))
                else:
                    check(f"{app}: Full screen button offered", full.is_visible())

            if len(only) == len(APPS):
                _, body = api.call("GET", f"/api/services/{SERVICE}?memory=1")
                METRICS["memory_after_all_apps"] = (body["service"].get("memory") or {}).get("text")

            if "photocraft" in only:
                page.goto(f"{url}/tools/artcraft?tab=photocraft")
                page.locator("main [role=status]", has_text="PhotoCraft loaded from").first.wait_for(timeout=120_000)
                wait_app(page, "photocraft")
                frame_el = page.locator("[data-craft-app=photocraft] iframe")
                frame_el.scroll_into_view_if_needed()
                box = frame_el.bounding_box()
                page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                check("PhotoCraft: Ctrl+O opens Smart Knife's chooser, the file comes from this computer through it",
                      open_from_computer(page, "photocraft", work / "sample.png", lambda: page.keyboard.press("Control+o")))
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
                before = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 2))
                downloads: list[object] = []
                page.on("download", lambda d: downloads.append(d))
                page.mouse.click(box["x"] + 370, box["y"] + 388)
                page.locator("[data-craft-saved]", has_text="Saved").wait_for(timeout=30_000)
                saved = api.wait_saved("photocraft", ".png", before)
                from PIL import Image

                def pixels_ok(data: bytes) -> bool:
                    image = Image.open(io.BytesIO(data)).convert("RGB")
                    return image.size == (640, 400) and image.getpixel((320, 200)) == (250, 200, 40) and image.getpixel((100, 100)) == (200, 40, 60) and image.getpixel((600, 360)) == (30, 90, 160)

                status, data, headers = api.raw(f"/api/craft/files/{saved['id']}") if saved else (0, b"", {})
                check("PhotoCraft: Quick Export saves to the account (no download), the stored PNG has the same pixels",
                      bool(saved) and status == 200 and pixels_ok(data) and not downloads, f"{saved and saved['name']} {status} downloads={len(downloads)}")
                check("Craft file download: octet-stream attachment, nosniff, sandbox CSP (never rendered on the app origin)",
                      headers.get("content-type") == "application/octet-stream" and headers.get("content-disposition", "").startswith("attachment") and headers.get("x-content-type-options") == "nosniff" and "sandbox" in headers.get("content-security-policy", ""), json.dumps(headers)[:300])
                with page.expect_download(timeout=30_000) as download:
                    page.locator("[data-craft-saved] a", has_text="Download").click()
                out = work / f"downloaded-{download.value.suggested_filename}"
                download.value.save_as(str(out))
                check("Download (separate from Save) puts the same file on this computer", saved is not None and out.name.endswith(saved["name"]) and out.read_bytes() == data, out.name)
                page.screenshot(path=str(shots / "22-photocraft-saved.png"))

                # Another device: a fresh browser (no shared storage), the same account. Open lists the saved PNG.
                other = browser.new_context(viewport={"width": 1600, "height": 1300}, accept_downloads=True)
                page2 = other.new_page()
                page2.goto(f"{url}/tools/artcraft?tab=photocraft")
                page2.locator("main [role=status]", has_text="PhotoCraft loaded from").first.wait_for(timeout=120_000)
                wait_app(page2, "photocraft")
                frame2 = page2.locator("[data-craft-app=photocraft] iframe")
                box2 = frame2.bounding_box()
                page2.mouse.click(box2["x"] + box2["width"] / 2, box2["y"] + box2["height"] / 2)
                page2.keyboard.press("Control+o")
                drawer = page2.get_by_role("dialog", name="Open in PhotoCraft")
                drawer.wait_for(timeout=15_000)
                row = drawer.locator(f"[data-craft-pick='{saved['name']}']") if saved else drawer.locator("li").first
                row.wait_for(timeout=15_000)
                page2.screenshot(path=str(shots / "23-other-device-chooser.png"))
                row.get_by_role("button", name="Open").click()
                drawer.wait_for(state="hidden", timeout=15_000)
                time.sleep(5)
                frame2.screenshot(path=str(shots / "24-other-device-opened.png"))
                again = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 1))
                box2 = frame2.bounding_box()
                page2.mouse.click(box2["x"] + 58, box2["y"] + 16)  # File
                time.sleep(1)
                page2.mouse.move(box2["x"] + 95, box2["y"] + 388)
                time.sleep(1)
                page2.mouse.move(box2["x"] + 300, box2["y"] + 388)
                page2.mouse.move(box2["x"] + 370, box2["y"] + 388)
                time.sleep(0.5)
                page2.mouse.click(box2["x"] + 370, box2["y"] + 388)
                resaved = api.wait_saved("photocraft", ".png", again)
                status, data2, _ = api.raw(f"/api/craft/files/{resaved['id']}") if resaved else (0, b"", {})
                check("another browser opens the saved PNG from the account in PhotoCraft (re-exported: same pixels, same file replaced)",
                      bool(resaved) and resaved["id"] == saved["id"] and pixels_ok(data2), f"{resaved and resaved['updatedAt']}")
                other.close()

            if "pdfcraft" in only:
                page.goto(f"{url}/tools/artcraft?tab=pdfcraft")
                page.locator("main [role=status]", has_text="PdfCraft loaded from").first.wait_for(timeout=120_000)
                wait_app(page, "pdfcraft")
                time.sleep(3)
                frame_el = page.locator("[data-craft-app=pdfcraft] iframe")
                frame_el.scroll_into_view_if_needed()
                box = frame_el.bounding_box()
                page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] - 30)
                open_from_computer(page, "pdfcraft", work / "sample.pdf", lambda: page.keyboard.press("Control+o"))
                time.sleep(5)
                frame_el.screenshot(path=str(shots / "30-pdfcraft-opened.png"))
                before = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 2))
                page.keyboard.press("Control+s")
                saved = api.wait_saved("pdfcraft", ".pdf", before)
                out = work / "saved-pdfcraft.pdf"
                out.write_bytes(api.raw(f"/api/craft/files/{saved['id']}")[1] if saved else b"")
                pages, text = pdf_facts(out) if saved else (0, "")
                check("PdfCraft: PDF opened through Smart Knife's chooser and saved to the account (2 pages, text kept)",
                      out.read_bytes().startswith(b"%PDF") and pages == 2 and "ArtCraft PDF page one" in text and "Second page here" in text, f"{saved and saved['name']}, {pages} pages")

            # WordCraft and GridCraft draw their own UI (egui): clicks are offsets from the frame's top-left, where their
            # File views and Browse… buttons sit at any frame size.
            if "wordcraft" in only:
                page.goto(f"{url}/tools/artcraft?tab=wordcraft")
                page.locator("main [role=status]", has_text="WordCraft loaded from").first.wait_for(timeout=120_000)
                wait_app(page, "wordcraft")
                time.sleep(2)
                frame_el = page.locator("[data-craft-app=wordcraft] iframe")
                frame_el.scroll_into_view_if_needed()
                box = frame_el.bounding_box()
                page.mouse.click(box["x"] + 70, box["y"] + 165)  # Open (start screen)
                time.sleep(1.5)
                open_from_computer(page, "wordcraft", work / "sample.docx", lambda: page.mouse.click(box["x"] + 279, box["y"] + 92))  # Browse…
                time.sleep(4)
                frame_el.screenshot(path=str(shots / "60-wordcraft-opened.png"))
                page.mouse.click(box["x"] + box["width"] / 2, box["y"] + 330)  # in the page, near the text
                page.keyboard.press("Control+End")
                page.keyboard.press("Enter")
                page.keyboard.type("Typed in Smart Knife 42", delay=30)
                time.sleep(1)
                frame_el.screenshot(path=str(shots / "61-wordcraft-typed.png"))
                before = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 2))
                page.keyboard.press("Control+s")
                saved = api.wait_saved("wordcraft", ".docx", before)
                out = work / "saved-wordcraft.docx"
                out.write_bytes(api.raw(f"/api/craft/files/{saved['id']}")[1] if saved else b"")
                text = docx_text(out) if saved else ""
                check("WordCraft: .docx opened through the chooser, a paragraph typed, saved to the account (old and new text)",
                      "ArtCraft WordCraft opening line" in text and "Second paragraph here" in text and "Typed in Smart Knife 42" in text, f"{saved and saved['name']}: {' '.join(text.split())[:120]!r}")

            if "gridcraft" in only:
                page.goto(f"{url}/tools/artcraft?tab=gridcraft")
                page.locator("main [role=status]", has_text="GridCraft loaded from").first.wait_for(timeout=120_000)
                wait_app(page, "gridcraft")
                time.sleep(2)
                frame_el = page.locator("[data-craft-app=gridcraft] iframe")
                frame_el.scroll_into_view_if_needed()
                box = frame_el.bounding_box()
                page.mouse.click(box["x"] + 40, box["y"] + 53)  # File
                time.sleep(1.5)
                page.mouse.click(box["x"] + 67, box["y"] + 191)  # Open
                time.sleep(1.5)
                open_from_computer(page, "gridcraft", work / "sample.csv", lambda: page.mouse.click(box["x"] + 288, box["y"] + 162))  # Browse…
                time.sleep(3)
                page.mouse.click(box["x"] + 207, box["y"] + 240)  # D2
                page.keyboard.type("=B2*C2", delay=30)
                page.keyboard.press("Enter")
                time.sleep(1)
                frame_el.screenshot(path=str(shots / "70-gridcraft-opened.png"))
                page.mouse.click(box["x"] + 40, box["y"] + 53)  # File
                time.sleep(1.5)
                page.mouse.click(box["x"] + 70, box["y"] + 398)  # Export
                time.sleep(1.5)
                frame_el.screenshot(path=str(shots / "71-gridcraft-export.png"))
                before = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 2))
                page.mouse.click(box["x"] + 362, box["y"] + 246)  # CSV (Comma delimited)
                saved = api.wait_saved("gridcraft", ".csv", before)
                rows = (api.raw(f"/api/craft/files/{saved['id']}")[1] if saved else b"").decode(errors="replace").splitlines()
                check("GridCraft: CSV opened through the chooser, a formula added, exported to the account (rows kept, value computed)",
                      len(rows) == 4 and rows[0].startswith("name,qty,price") and rows[1] == "apple,3,1.5,4.5" and rows[3].startswith("plum,10,0.4"), f"{saved and saved['name']}: {rows}")

            if "photocraft" in only:
                # A browser shared by two accounts: the bridge clears the craft origin's storage before the app loads
                # when another account used it last (here: a foreign tag and a leftover key planted in that storage).
                page.goto(f"{url}/tools/artcraft?tab=photocraft")
                page.locator("main [role=status]", has_text="PhotoCraft loaded from").first.wait_for(timeout=120_000)
                bridge = next(f for f in page.frames if "/knife-bridge/" in f.url)
                own_tag = bridge.evaluate("() => localStorage.getItem('knife:account')")
                bridge.evaluate("() => { localStorage.setItem('knife:account', 'f'.repeat(32)); localStorage.setItem('probe:other-account', 'their work'); }")
                page.reload()
                page.locator("main [role=status]", has_text="PhotoCraft loaded from").first.wait_for(timeout=120_000)
                bridge = next(f for f in page.frames if "/knife-bridge/" in f.url)
                left = bridge.evaluate("() => [localStorage.getItem('probe:other-account'), localStorage.getItem('knife:account')]")
                cleared_note = page.get_by_text("Another account used the Craft apps in this browser").is_visible()
                check("shared browser: another account's craft-origin storage is cleared before the app loads, the tag becomes ours",
                      left[0] is None and left[1] == own_tag and bool(own_tag) and cleared_note, json.dumps(left))
                page.reload()
                page.locator("main [role=status]", has_text="PhotoCraft loaded from").first.wait_for(timeout=120_000)
                check("the same account again: nothing cleared", not page.get_by_text("Another account used the Craft apps in this browser").is_visible())
                # My files: everything saved, with Download and Delete.
                page.locator("[data-craft-app=photocraft]").get_by_role("button", name="My files").click()
                files_drawer = page.get_by_role("dialog", name="Craft files")
                files_drawer.locator("[data-craft-file]").first.wait_for(timeout=15_000)
                listed = files_drawer.locator("[data-craft-file]").count()
                page.screenshot(path=str(shots / "25-my-files.png"))
                check("My files lists what the apps saved, each with Download and Delete", listed == len(api.craft_files()) and listed >= 1 and files_drawer.get_by_role("link", name="Download").count() == listed, f"{listed} listed")
                files_drawer.get_by_role("button", name="Close Craft files").click()

            if "gridcraft" in only:
                # Automatic updates: a "0.9.1" GridCraft (the real 0.9.0 files re-packed) from the fake GitHub, applied
                # from the admin drawer: content switched, nginx.conf/compose untouched, the same container keeps
                # serving (no recreate, and with the root helper no sync: the bundle hash covers neither).
                releases = server.data_dir / "services" / SERVICE / "releases"
                pinned = next(releases.glob("gridcraft-*"))
                github.releases["gridcraft"] = [("0.9.1", repack(pinned / "gridcraft", "gridcraft", "0.9.1"))]
                state_file = server.data_dir / "services" / SERVICE / "state.json"
                compose_before = (server.data_dir / "services" / SERVICE / "compose.yaml").read_text()
                assets_before = sorted(p.name for p in (server.data_dir / "services" / SERVICE / "assets").iterdir())
                hash_before = json.loads(state_file.read_text()).get("composeHash")
                container_before = subprocess.run(["docker", "compose", "-p", project, "ps", "-q"], capture_output=True, text=True).stdout.strip()
                page.goto(f"{url}/tools/artcraft?tab=gridcraft")
                page.locator("main [role=status]", has_text="GridCraft loaded from").first.wait_for(timeout=120_000)
                page.locator("[data-craft-app=gridcraft]").get_by_role("button", name="Updates").click()
                drawer = page.get_by_role("dialog", name="Craft apps updates")
                drawer.get_by_role("button", name="Check now").click()
                row = drawer.locator("[data-craft-update=gridcraft]")
                row.get_by_text("0.9.1 available").wait_for(timeout=60_000)
                check("updates: the check finds the newer release (one listing per app, nothing else downloaded)",
                      sum(1 for c in github.calls if c.startswith("/repos/")) == len(APPS) and not any("/download/" in c for c in github.calls), f"{len(github.calls)} calls")
                page.screenshot(path=str(shots / "50-updates-available.png"))
                row.get_by_role("button", name="Update to 0.9.1").click()
                row.get_by_role("button", name="Roll back to 0.9.0").wait_for(timeout=120_000)
                served = (server.data_dir / "services" / f"{SERVICE}-content" / "gridcraft" / ".knife-version").read_text().split()[0]
                container_after = subprocess.run(["docker", "compose", "-p", project, "ps", "-q"], capture_output=True, text=True).stdout.strip()
                check("update applied from the drawer: the content dir serves 0.9.1", served == "0.9.1", served)
                assets_after = sorted(p.name for p in (server.data_dir / "services" / SERVICE / "assets").iterdir())
                check("an app update changes neither compose.yaml, its hash nor the bundle's asset folders (no recreate, no helper sync)",
                      (server.data_dir / "services" / SERVICE / "compose.yaml").read_text() == compose_before and json.loads(state_file.read_text()).get("composeHash") == hash_before and assets_after == assets_before,
                      f"assets {assets_before} -> {assets_after}")
                check("the same container keeps serving across the update", container_before and container_after == container_before, f"{container_before} -> {container_after}")
                drawer.get_by_role("button", name="Close Craft apps updates").click()
                page.reload()
                page.locator("main [role=status]", has_text="GridCraft loaded from").first.wait_for(timeout=120_000)
                state = wait_app(page, "gridcraft")
                title = page.locator("[data-craft-app=gridcraft] h2, [data-craft-app=gridcraft] h3").first.inner_text()
                page.screenshot(path=str(shots / "51-gridcraft-updated.png"))
                check("GridCraft 0.9.1 starts after the update and the tab names the new version", bool(state.get("ready")) and "0.9.1" in title, f"{title!r} {json.dumps(state)[:120]}")
                page.locator("[data-craft-app=gridcraft]").get_by_role("button", name="Updates").click()
                row = page.get_by_role("dialog", name="Craft apps updates").locator("[data-craft-update=gridcraft]")
                row.get_by_role("button", name="Roll back to 0.9.0").click()
                row.get_by_text("held").wait_for(timeout=60_000)
                served = (server.data_dir / "services" / f"{SERVICE}-content" / "gridcraft" / ".knife-version").read_text().split()[0]
                check("roll back: 0.9.0 served again and the app is held (no automatic re-update)", served == "0.9.0" and row.get_by_role("button", name="Release hold").is_visible(), served)
                status, body = api.call("POST", "/api/craft/updates", {"action": "check", "apply": True})
                for _ in range(60):
                    status, view = api.call("GET", "/api/craft/updates")
                    if not view.get("running"):
                        break
                    time.sleep(1)
                grid = next(a for a in view["apps"] if a["id"] == "gridcraft")
                check("a held app stays on its version through 'check and update all'", grid["active"] == "0.9.0" and grid["available"] == "0.9.1" and grid["hold"], json.dumps(grid)[:200])
                page.get_by_role("button", name="Close Craft apps updates").click()

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
        left_files = [str(p.relative_to(Path(server.data_dir))) for folder in (SERVICE, f"{SERVICE}-content") for p in (Path(server.data_dir) / "services" / folder).rglob("*")] if (Path(server.data_dir) / "services").exists() else []
        left_dirs = [folder for folder in (SERVICE, f"{SERVICE}-content") if (Path(server.data_dir) / "services" / folder).exists()]
        # The status polls of the purge op may recreate the (empty) service dir; no file and no content dir may be left.
        check("purge deleted the sidecar's releases, content, config and secrets", not left_files and f"{SERVICE}-content" not in left_dirs, " ".join((left_dirs + left_files)[:10]))
        github.close()
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
