#!/usr/bin/env python3
"""Screenshots for the tool showcases (docs/SHOWCASE.md): public/showcase/<slug>.webp, 1280x800, Polish UI, at most
~120 kB, one per top-level tool whose showcase names an image (src/lib/showcase.ts).

Self-contained and never touches real data: its own scratch server (tests/scratch_server.py: a worktree of the current
tree, a fresh KNIFE_DATA_DIR, a free port), private mode with the passwordless default account. Demo data only: the
fictional CV in tests/fixtures/cv_sample_profile.json and a demo workflow, both created over MCP; pictures, PDFs and
texts generated here. Python Playwright (the repo's test stack) rather than a new npm dependency.

With --sidecar-host <Tailscale/LAN address> it also installs the course database (`learn-db`, PostgreSQL + PostGIS)
on a second scratch server bound to that address (a container cannot reach loopback), in its own compose project
(KNIFE_SIDECAR_PREFIX=sk-shots-<pid>), takes the db-course shot and removes the project with its volume. Run it with
KNIFE_SCRATCH_PORTS inside the range the host firewall lets containers reach (docs/SIDECARS.md).

Usage: python3 scripts/showcase_shots.py [--only slug,slug] [--out public/showcase] [--keep-png DIR] [--headed]
                                         [--sidecar-host ADDRESS]
Then: node --import ./tests/ts-resolve.mjs --test tests/showcase.test.mjs (sizes and dimensions).
"""
from __future__ import annotations

import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from PIL import Image, ImageDraw  # noqa: E402
from playwright.sync_api import Page, sync_playwright  # noqa: E402

from tests.scratch_server import ScratchServer  # noqa: E402

ARGS = sys.argv[1:]
ONLY = set(ARGS[ARGS.index("--only") + 1].split(",")) if "--only" in ARGS else set()
OUT = ROOT / (ARGS[ARGS.index("--out") + 1] if "--out" in ARGS else "public/showcase")
KEEP = Path(ARGS[ARGS.index("--keep-png") + 1]) if "--keep-png" in ARGS else None
HEADED = "--headed" in ARGS
SIDECAR_HOST = ARGS[ARGS.index("--sidecar-host") + 1] if "--sidecar-host" in ARGS else ""
MAX_BYTES = 120_000
W, H = 1280, 800


def image_slugs() -> list[str]:
    """Slugs whose showcase names an image, read from src/lib/showcase.ts (the source of truth)."""
    text = (ROOT / "src/lib/showcase.ts").read_text()
    return re.findall(r'image: (?:shot|illustration)\("([a-z0-9-]+)"\)', text)


SIDECAR_SLUGS = {"db-course"}


def untracked() -> list[str]:
    out = subprocess.run(["git", "ls-files", "--others", "--exclude-standard"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return [line for line in out.splitlines() if line.startswith(("src/", "scripts/", "legal/", "public/", "tests/fixtures/"))]


# ------------------------------------------------------------------------------------------------- demo inputs
def demo_png(path: Path, hue: int, label: str) -> Path:
    img = Image.new("RGB", (960, 640), (16, 20, 34))
    d = ImageDraw.Draw(img)
    for y in range(640):
        d.line([(0, y), (960, y)], fill=(20 + y // 12, 40 + (hue + y // 8) % 120, 90 + y // 6))
    d.ellipse([560, 120, 860, 420], fill=(250, 196, 70))
    d.polygon([(0, 640), (300, 300), (520, 640)], fill=(32, 64, 52))
    d.polygon([(260, 640), (640, 260), (960, 640)], fill=(24, 48, 40))
    d.rectangle([40, 40, 380, 110], fill=(255, 255, 255))
    d.text((60, 62), label, fill=(20, 20, 20))
    img.save(path)
    return path


def demo_pdf(path: Path) -> Path:
    pages = []
    for n in range(3):
        page = Image.new("RGB", (595, 842), (255, 255, 255))
        d = ImageDraw.Draw(page)
        d.rectangle([60, 60, 535, 120], fill=(30, 60, 120))
        d.text((80, 82), f"Raport kwartalny - strona {n + 1}", fill=(255, 255, 255))
        for i in range(18):
            d.line([(60, 160 + i * 30), (60 + 380 + (i * 37) % 95, 160 + i * 30)], fill=(150, 150, 150), width=6)
        pages.append(page)
    pages[0].save(path, save_all=True, append_images=pages[1:])
    return path


DEMO_SVG = """<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: Demo 1.0 -->
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
  <metadata>demo</metadata>
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
  <rect x="10.000" y="10.000" width="220.000" height="220.000" rx="48.000" fill="url(#g)"/>
  <path d="M 70.000 150.000 L 120.000 70.000 L 170.000 150.000 Z" fill="#ffffff" fill-opacity="0.92"/>
  <circle cx="120.000" cy="170.000" r="14.000" fill="#0b1020"/>
</svg>
"""

DEMO_CSV = """miasto,województwo,mieszkańcy,powierzchnia_km2
Warszawa,mazowieckie,1863056,517
Kraków,małopolskie,804237,327
Wrocław,dolnośląskie,674132,293
Łódź,łódzkie,655279,293
Poznań,wielkopolskie,540146,262
Gdańsk,pomorskie,486345,262
Szczecin,zachodniopomorskie,391566,301
"""

DEMO_TEXT = """zadzwonić do księgowej
Zamówić Papier Do Drukarki
wysłać fakturę 11/2026
zadzwonić do księgowej
umówić przegląd auta
Odpisać na maila od Ani
wysłać fakturę 11/2026"""

DIFF_LEFT = """Spotkanie zespołu: wtorek 10:00
Miejsce: sala 2
Agenda:
- podsumowanie sprintu
- plan na listopad
- sprawy różne"""

DIFF_RIGHT = """Spotkanie zespołu: środa 10:30
Miejsce: sala 2 (2. piętro)
Agenda:
- podsumowanie sprintu
- plan na listopad i grudzień
- budżet
- sprawy różne"""


# ------------------------------------------------------------------------------------------------- seeding (MCP)
def mcp(base: str, name: str, args: dict) -> object:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}).encode()
    req = urllib.request.Request(base + "/api/mcp", data=body, method="POST", headers={"content-type": "application/json", "accept": "application/json, text/event-stream"})
    with urllib.request.urlopen(req, timeout=120) as res:
        raw = res.read().decode()
    result = json.loads(raw[raw.find("{"):])["result"]
    if result.get("isError"):
        raise RuntimeError(f"{name}: {result['content'][0]['text'][:300]}")
    return result["content"][0]["text"]


def seed(base: str) -> None:
    profile = json.loads((ROOT / "tests/fixtures/cv_sample_profile.json").read_text())
    mcp(base, "knife_cv_import", {"profile": profile, "overwrite": True})
    mcp(base, "knife_workflow_create", {
        "name": "Cotygodniowy raport sprzedaży",
        "description": "Demo: pobiera zamówienia, liczy sumy i wysyła podsumowanie.",
        "nodes": [
            {"name": "Co poniedziałek", "type": "core.schedule-trigger"},
            {"name": "Pobierz zamówienia", "type": "core.http-request", "parameters": {"url": "https://api.example.com/orders"}},
            {"name": "Tylko opłacone", "type": "core.filter"},
            {"name": "Suma na klienta", "type": "core.summarize"},
            {"name": "Raport w Markdown", "type": "core.markdown"},
        ],
        "connections": [
            {"from": "Co poniedziałek", "to": "Pobierz zamówienia"},
            {"from": "Pobierz zamówienia", "to": "Tylko opłacone"},
            {"from": "Tylko opłacone", "to": "Suma na klienta"},
            {"from": "Suma na klienta", "to": "Raport w Markdown"},
        ],
    })


# ------------------------------------------------------------------------------------------------- recipes
def settle(page: Page) -> None:
    page.wait_for_load_state("networkidle")
    page.wait_for_function("() => !/Loading tool|Wczytywanie narzędzia/.test(document.body.innerText)", timeout=60000)
    page.wait_for_timeout(500)


def click_text(page: Page, *names: str) -> None:
    for name in names:
        loc = page.locator("main").get_by_role("button", name=name, exact=True)
        if loc.count():
            loc.first.click()
            page.wait_for_timeout(700)
            return
    raise RuntimeError(f"no button {names}")


def fill_textareas(page: Page, *texts: str) -> None:
    areas = page.locator("main textarea, main [data-agent-code]")
    for i, text in enumerate(texts):
        area = areas.nth(i)
        area.click()
        page.keyboard.press("Control+A")
        page.keyboard.insert_text(text)
    page.wait_for_timeout(700)


def scroll(page: Page, y: int) -> None:
    page.evaluate("y => window.scrollTo(0, y)", y)
    page.wait_for_timeout(400)


def upload(page: Page, *files: Path) -> None:
    inputs = page.locator("main input[type=file]")
    if len(files) > 1 and inputs.count() >= len(files):
        for i, f in enumerate(files):
            inputs.nth(i).set_input_files(str(f))
            page.wait_for_timeout(600)
    else:
        inputs.first.set_input_files([str(f) for f in files])
    page.wait_for_timeout(1500)


def recipes(tmp: Path) -> dict[str, tuple[str, Callable[[Page], None] | None]]:
    png_a = demo_png(tmp / "gory.png", 0, "Demo: gory o zachodzie")
    png_b = demo_png(tmp / "gory-2.png", 40, "Demo: wersja 2")
    svg = tmp / "logo.svg"
    svg.write_text(DEMO_SVG)
    pdf = demo_pdf(tmp / "raport.pdf")
    return {
        "web": ("/tools/web?tab=csp", None),
        "css": ("/tools/css", None),
        "sql-lab": ("/tools/sql-lab?tab=validate", lambda p: click_text(p, "Przykład: nieznane nazwy")),
        "svg-optimize": ("/tools/svg-optimize", lambda p: (fill_textareas(p, svg.read_text()), click_text(p, "Optymalizuj SVG"), scroll(p, 260))),
        "image-crop": ("/tools/image-crop", lambda p: (upload(p, png_a), click_text(p, "Podgląd kadru"))),
        "image-compare": ("/tools/image-compare", lambda p: (upload(p, png_a, png_b), click_text(p, "Porównaj obrazy"), scroll(p, 300))),
        "image-resize": ("/tools/image-resize", lambda p: upload(p, png_a)),
        "pdf": ("/tools/pdf?tab=tools", lambda p: upload(p, pdf)),
        "json": ("/tools/json", lambda p: click_text(p, "Przykład")),
        "csv": ("/tools/csv?tab=profile", lambda p: (fill_textareas(p, DEMO_CSV), scroll(p, 330))),
        "text": ("/tools/text", lambda p: fill_textareas(p, DEMO_TEXT)),
        "regex": ("/tools/regex", lambda p: (fill_textareas(p, "Kraków 30-001, Gdańsk 80-001\nWarszawa 00-950 i Poznań 61-001"), scroll(p, 0), scroll(p, 150))),
        "ids": ("/tools/ids", None),
        "qr": ("/tools/qr", lambda p: (p.locator("main textarea, main input").first.fill("https://smartknife.example/tools/qr/about"), p.wait_for_timeout(800))),
        "mcp-connect": ("/tools/mcp-connect", None),
        "dates": ("/tools/dates?tab=meeting", None),
        "diff": ("/tools/diff", lambda p: fill_textareas(p, DIFF_LEFT, DIFF_RIGHT)),
        "markdown": ("/tools/markdown", lambda p: click_text(p, "Przykład")),
        "characters": ("/tools/characters", lambda p: click_text(p, "Przykład")),
        "cv-studio": ("/tools/cv-studio?tab=profile", None),
        "workflows": ("/tools/workflows", lambda p: (p.get_by_text("Cotygodniowy raport sprzedaży").first.click(), p.wait_for_timeout(2500))),
        "sidecars": ("/tools/sidecars", None),
    }


def api(base: str, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method, headers={"content-type": "application/json", "origin": base})
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


def wait_op(base: str, op: dict, timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        _, body = api(base, "GET", f"/api/services/ops/{op['opId']}")
        op = body["op"]
        if op["status"] != "running":
            return op
        time.sleep(1)
    raise TimeoutError(f"op {op['kind']} still running after {timeout}s")


def db_course_shot(pw, made: list[str], failed: list[str]) -> None:
    """The course with a real lesson and a query result: learn-db installed on a scratch server, removed afterwards."""
    prefix = f"sk-shots-{os.getpid()}"
    with ScratchServer(host=SIDECAR_HOST) as server:
        base = server.start(env={"KNIFE_SIDECAR_PREFIX": prefix}, overlay=untracked())
        try:
            status, body = api(base, "POST", "/api/services/learn-db", {"action": "install"})
            if status != 202:
                raise RuntimeError(f"install refused: {status} {body}")
            op = wait_op(base, body["op"], 900)
            if op["status"] != "done":
                raise RuntimeError(f"install failed: {op.get('error') or op['phase']}")
            browser = pw.chromium.launch(headless=not HEADED)
            ctx = browser.new_context(viewport={"width": W, "height": H}, locale="pl-PL", timezone_id="Europe/Warsaw", color_scheme="dark")
            ctx.add_cookies([{"name": "knife_lang", "value": "pl", "url": base}])
            ctx.add_init_script(HIDE_DEV)
            page = ctx.new_page()
            page.goto(base + "/tools/db-course", wait_until="domcontentloaded")
            page.locator('nav[aria-label="Lekcje"]').wait_for(timeout=600_000)
            settle(page)
            sql = page.get_by_label("Edytor SQL")
            sql.click()
            page.keyboard.press("Control+A")
            page.keyboard.insert_text("SELECT city, count(*) AS customers\nFROM shop.customers\nGROUP BY city\nORDER BY customers DESC\nLIMIT 6;")
            page.keyboard.press("Control+Enter")
            page.wait_for_timeout(2500)
            page.get_by_label("Edytor SQL").evaluate("el => el.closest('section, [class*=rounded]')?.scrollIntoView({block: 'start'})")
            page.evaluate("window.scrollBy(0, -70)")
            page.wait_for_timeout(500)
            png = page.screenshot(full_page=False)
            if KEEP:
                (KEEP / "db-course.png").write_bytes(png)
            size = to_webp(png, OUT / "db-course.webp")
            made.append(f"db-course ({size // 1000} kB)")
            print(f"OK    db-course  {size} bytes", flush=True)
            browser.close()
        except Exception as exc:
            failed.append("db-course")
            print(f"FAIL  db-course: {str(exc)[:300]}", flush=True)
        finally:
            status, body = api(base, "POST", "/api/services/learn-db", {"action": "remove", "purge": True})
            if status == 202:
                wait_op(base, body["op"], 300)
            # Backstop: only this run's own compose project is ever touched.
            subprocess.run(["docker", "compose", "-p", f"{prefix}-learn-db", "down", "-v"], capture_output=True)


HIDE_DEV = "document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent='nextjs-portal{display:none!important}';document.head.appendChild(s)})"


def to_webp(png: bytes, dest: Path) -> int:
    img = Image.open(io.BytesIO(png)).convert("RGB")
    assert img.size == (W, H), img.size
    for quality in (82, 76, 70, 64, 58, 52, 46, 40):
        buf = io.BytesIO()
        img.save(buf, "WEBP", quality=quality, method=6)
        if buf.tell() <= MAX_BYTES:
            dest.write_bytes(buf.getvalue())
            return buf.tell()
    raise RuntimeError(f"{dest.name}: over {MAX_BYTES} bytes even at quality 40")


def main() -> int:
    slugs = [s for s in image_slugs() if not ONLY or s in ONLY]
    OUT.mkdir(parents=True, exist_ok=True)
    made, failed = [], []
    with tempfile.TemporaryDirectory(prefix="showcase-shots-") as tmpdir, ScratchServer() as server:
        tmp = Path(tmpdir)
        base = server.start(overlay=untracked())
        seed(base)
        plan = recipes(tmp)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=not HEADED)
            ctx = browser.new_context(viewport={"width": W, "height": H}, locale="pl-PL", timezone_id="Europe/Warsaw", color_scheme="dark")
            ctx.add_cookies([{"name": "knife_lang", "value": "pl", "url": base}])
            # The dev-only Next.js indicator is not part of the product.
            ctx.add_init_script(HIDE_DEV)
            page = ctx.new_page()
            for slug in [s for s in slugs if s not in SIDECAR_SLUGS]:
                path, recipe = plan.get(slug, (f"/tools/{slug}", None))
                try:
                    page.goto(base + path, wait_until="domcontentloaded")
                    settle(page)
                    if recipe:
                        recipe(page)
                        settle(page)
                    page.mouse.move(W - 2, 2)
                    png = page.screenshot(full_page=False)
                    if KEEP:
                        KEEP.mkdir(parents=True, exist_ok=True)
                        (KEEP / f"{slug}.png").write_bytes(png)
                    size = to_webp(png, OUT / f"{slug}.webp")
                    made.append(f"{slug} ({size // 1000} kB)")
                    print(f"OK    {slug}  {size} bytes", flush=True)
                except Exception as exc:  # one tool failing must not lose the others
                    failed.append(slug)
                    print(f"FAIL  {slug}: {str(exc)[:300]}", flush=True)
            browser.close()
            if "db-course" in slugs and SIDECAR_HOST:
                db_course_shot(pw, made, failed)
            elif "db-course" in slugs:
                failed.append("db-course (needs --sidecar-host)")
    print(f"\n{len(made)} made, {len(failed)} failed{': ' + ', '.join(failed) if failed else ''}")
    return 1 if failed else 0


if __name__ == "__main__":
    t0 = time.time()
    code = main()
    print(f"{time.time() - t0:.0f} s")
    sys.exit(code)
