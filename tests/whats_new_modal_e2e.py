"""The "What's new in Smart Knife <version>" window (src/components/shell/WhatsNewModal.tsx), real browser.

  python3 tests/whats_new_modal_e2e.py <app-url> <mock-url> <app-data-dir>

The data dir is needed to set the account's `seen` the way an older release left it (absent) or an older release
recorded it. Scenarios: a new account sees no window; an account from before 0.13.0 sees the current notes and the
legal edition's summary with links, once ("Got it" stores it); an account that saw 0.12.0 and edition 6 gets "See all
changes" -> /changelog; never on /privacy; Polish; the PUT is behind the Origin guard.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

BASE, MOCK, DATA = sys.argv[1].rstrip("/"), sys.argv[2].rstrip("/"), sys.argv[3]
ROOT = Path(__file__).resolve().parents[1]
DIALOG = "[data-whats-new] [role=dialog]"
failures: list[str] = []
PKG = json.loads((ROOT / "package.json").read_text())["version"]


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f"  -> {str(detail)[:500]}"))
    if not ok:
        failures.append(name)


def call(path: str, method: str = "GET", body: object | None = None, origin: str | None = None) -> tuple[int, object]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"content-type": "application/json", "Origin": origin or BASE})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as error:
        return error.code, None


def set_seen(value: dict | None) -> None:
    """Write the account's `seen` through the store itself (as an older release left it)."""
    script = """
const store = await import("./src/lib/accounts/store.ts");
const value = JSON.parse(process.env.SEEN);
store.mutateStore((s) => { for (const a of s.accounts) a.seen = value; });
"""
    env = {**os.environ, "KNIFE_DATA_DIR": DATA, "SEEN": json.dumps(value)}
    subprocess.run(["node", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=ExperimentalWarning", "--import", "./tests/ts-resolve.mjs",
                    "--input-type=module", "-e", script], cwd=ROOT, env=env, check=True)


def visit(page: Page, path: str) -> None:
    page.goto(BASE + path, wait_until="networkidle")
    page.wait_for_timeout(800)


status, state = call("/api/account/seen")
check("a new account starts at the current release and edition", status == 200 and state["seen"]["version"] == PKG and state["seen"]["legalEdition"] == state["current"]["legalEdition"], state)
edition = state["current"]["legalEdition"]

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()

    visit(page, "/tools/qr")
    check("a new account sees no window", page.locator(DIALOG).count() == 0)

    print("# an account from before 0.13.0 (no `seen`)")
    set_seen(None)
    visit(page, "/privacy")
    check("never over the privacy notice", page.locator(DIALOG).count() == 0)
    visit(page, "/tools/qr")
    page.locator(DIALOG).wait_for(timeout=10_000)
    text = page.locator(DIALOG).inner_text()
    check("titled with the version", f"What's new in Smart Knife {PKG}" in text, text[:200])
    check("plain notes: new and fixed", "new\n" in text.lower() and "fixed\n" in text.lower() and "knife_" not in text, text[:600])
    legal = page.locator("[data-whats-new-legal]")
    check("the current legal edition's summary with links", legal.count() == 1 and "Privacy and terms changes" in legal.inner_text()
          and legal.locator("a[href='/privacy']").count() == 1 and legal.locator("a[href='/terms']").count() == 1, legal.inner_text() if legal.count() else "")
    check("shell chrome: outside <main>", page.locator("main [data-whats-new]").count() == 0)
    page.get_by_role("button", name="Got it").click()
    page.locator(DIALOG).wait_for(state="detached", timeout=10_000)
    page.wait_for_timeout(500)
    status, state = call("/api/account/seen")
    check("Got it stores the current release and edition", state["seen"]["version"] == PKG and state["seen"]["legalEdition"] == edition, state)
    visit(page, "/tools/qr")
    check("shown once: not after a reload", page.locator(DIALOG).count() == 0)

    print("# saw 0.12.0 and edition 6: See all changes")
    set_seen({"version": "0.12.0", "legalEdition": 6, "at": "2026-10-28T00:00:00.000Z"})
    visit(page, "/tools/json-format")
    page.locator(DIALOG).wait_for(timeout=10_000)
    summaries = page.locator("[data-whats-new-legal] li").all_inner_texts()
    check("only the editions after the seen one", len(summaries) == edition - 6, summaries)
    page.get_by_role("button", name="See all changes").click()
    page.wait_for_url("**/changelog", timeout=15_000)
    page.wait_for_load_state("networkidle")
    body = page.locator("main").inner_text()
    check("/changelog lists the release, no window over it", PKG in body and "What's new in Smart Knife" in body and page.locator(DIALOG).count() == 0, body[:300])
    check("See all changes also records it", call("/api/account/seen")[1]["seen"]["version"] == PKG)

    print("# Polish")
    set_seen(None)
    ctx.add_cookies([{"name": "knife_lang", "value": "pl", "url": BASE}])
    visit(page, "/tools/qr")
    page.locator(DIALOG).wait_for(timeout=10_000)
    text = page.locator(DIALOG).inner_text()
    check("Polish window", "Co nowego w Smart Knife" in text and "Zmiany w prywatności i regulaminie" in text, text[:300])
    page.locator(DIALOG).get_by_role("button").last.click()
    browser.close()

status, _ = call("/api/account/seen", "PUT", {}, origin="http://evil.example")
check("a foreign Origin cannot mark it seen", status == 403, status)

print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'all checks passed'}")
sys.exit(1 if failures else 0)
