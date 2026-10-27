#!/usr/bin/env python3
"""Interface languages end to end (docs/I18N.md): the top-bar switch flips the whole app between English and Polish,
the choice survives a reload (cookie) and is saved on the account, a Polish browser gets Polish on its first visit,
the account page offers both, Polish pages hydrate without mismatches, and Polish letters render with the app font.

Self-contained: its own scratch server (tests/scratch_server.py: worktree of the current tree, fresh KNIFE_DATA_DIR,
free loopback port), private mode with the passwordless default account. Never touches the live :3210 server.

Usage: python3 tests/functional/i18n_e2e.py [--shots DIR] [--headed]
"""
from __future__ import annotations

import json
import subprocess
import urllib.error
import urllib.request
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from playwright.sync_api import Page, sync_playwright  # noqa: E402

from tests.scratch_server import ScratchServer  # noqa: E402

SHOTS = sys.argv[sys.argv.index("--shots") + 1] if "--shots" in sys.argv else ""
HEADED = "--headed" in sys.argv
FAILS: list[str] = []
PASSES = 0


def check(name: str, ok: bool, detail: object = "") -> bool:
    global PASSES
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  -> ' + str(detail)[:400]}", flush=True)
    if ok:
        PASSES += 1
    else:
        FAILS.append(name)
    return ok


def untracked() -> list[str]:
    out = subprocess.run(["git", "ls-files", "--others", "--exclude-standard"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return [line for line in out.splitlines() if line.startswith(("src/", "scripts/", "legal/", "public/"))]


def settle(page: Page) -> None:
    page.wait_for_load_state("networkidle")
    page.wait_for_function("() => !/Loading tool|Wczytywanie narzędzia/.test(document.body.innerText)", timeout=30000)


def shot(page: Page, name: str) -> None:
    if SHOTS:
        Path(SHOTS).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=f"{SHOTS}/{name}.png", full_page=False)


def main() -> int:
    server = ScratchServer()
    base = server.start(overlay=untracked())
    data_dir = server.data_dir
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not HEADED)
        errors: list[str] = []

        # 1. An English browser starts in English; the switch flips to Polish and back.
        ctx = browser.new_context(locale="en-US")
        page = ctx.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base + "/", wait_until="networkidle")
        check("english browser gets lang=en", page.evaluate("document.documentElement.lang") == "en")
        switch = page.locator("[data-language-switcher]")
        check("switcher names the current language", switch.first.get_attribute("data-language-switcher") == "en" and "English" in switch.first.inner_text(), switch.first.inner_text())
        check("switcher is visible in the top bar", switch.first.is_visible())
        switch.first.click()
        menu = page.get_by_role("menu", name="Interface language")
        check("switcher opens a language menu", menu.is_visible())
        check("menu lists every language in its own name", menu.get_by_role("menuitemradio").all_inner_texts() and ["English", "Polski"] == [x.split("\n")[0].strip() for x in menu.get_by_role("menuitemradio").all_inner_texts()], menu.inner_text())
        page.keyboard.press("Escape")
        check("Escape closes the menu", menu.count() == 0)
        switch.first.click()
        page.get_by_role("menuitemradio", name="Polski").click()
        page.wait_for_function("() => document.querySelector('[data-language-switcher]')?.dataset.languageSwitcher === 'pl'", timeout=20000)
        settle(page)
        check("html lang becomes pl", page.evaluate("document.documentElement.lang") == "pl")
        body = page.locator("body").inner_text()
        check("launcher is Polish", "JSON i konfiguracja" in body and "Laboratorium SQL" in body, body[:300])
        cookies = {c["name"]: c["value"] for c in ctx.cookies()}
        check("cookie knife_lang=pl", cookies.get("knife_lang") == "pl", cookies)
        shot(page, "home-pl")
        for width in (1024, 390):
            page.set_viewport_size({"width": width, "height": 800})
            for path in ("/", "/tools/qr"):
                page.goto(base + path, wait_until="networkidle")
                check(f"switcher visible on {path} at {width}px", page.locator("[data-language-switcher]").first.is_visible())
        page.set_viewport_size({"width": 1280, "height": 800})

        # 2. The choice survives a reload and is saved on the account.
        page.reload(wait_until="networkidle")
        check("reload stays Polish", page.evaluate("document.documentElement.lang") == "pl")
        accounts = json.loads((Path(data_dir) / "accounts.json").read_text()) if (Path(data_dir) / "accounts.json").exists() else {}
        langs = [a.get("language") for a in accounts.get("accounts", [])]
        check("account language saved", "pl" in langs, langs)

        # 3. Polish pages hydrate cleanly (tool pages, suites, the course, the account page).
        for path in ["/tools/json?tab=lint", "/tools/cv-studio?tab=jobs", "/tools/dates?tab=epoch", "/tools/db-course?tab=sql", "/tools/workflows", "/account", "/terms"]:
            errors.clear()
            page.goto(base + path, wait_until="networkidle")
            settle(page)
            bad = [e for e in errors if "ydrat" in e or "did not match" in e or "Minified React error" in e]
            check(f"{path} hydrates in Polish", not bad, bad)
            check(f"{path} renders lang=pl", page.evaluate("document.documentElement.lang") == "pl")

        # 4. Polish letters use the app font (Geist latin-ext), not a fallback.
        page.goto(base + "/tools/text?tab=kit", wait_until="networkidle")
        settle(page)
        families = page.evaluate("async () => { await document.fonts.ready; return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family); }")
        check("latin-ext font face loaded for Polish text", any("ext" in f.lower() for f in families), families)

        # 5. The account page offers both languages; English comes back from there.
        page.goto(base + "/account", wait_until="networkidle")
        group = page.get_by_role("radiogroup", name="Język interfejsu")
        check("account page has the language choice", group.count() == 1)
        group.get_by_role("radio", name="English").click()
        try:
            page.wait_for_function("() => document.documentElement.lang === 'en' && document.body.innerText.includes('Interface language')", timeout=20000)
            switched = True
        except Exception:
            switched = False
        check("account page switched back to English", switched, page.locator("main").inner_text()[:300])
        ctx.close()

        # 6. A Polish browser gets Polish on its first visit (no cookie, Accept-Language: pl).
        ctx = browser.new_context(locale="pl-PL")
        page = ctx.new_page()
        accounts_before = (Path(data_dir) / "accounts.json").read_text()
        # The default account chose English in step 5: the account's choice wins over the browser.
        page.goto(base + "/", wait_until="networkidle")
        check("account language wins over Accept-Language", page.evaluate("document.documentElement.lang") == "en")
        ctx.close()
        accounts = json.loads(accounts_before)
        for account in accounts.get("accounts", []):
            account["language"] = None
        (Path(data_dir) / "accounts.json").write_text(json.dumps(accounts))
        ctx = browser.new_context(locale="pl-PL")
        page = ctx.new_page()
        page.goto(base + "/", wait_until="networkidle")
        check("polish browser without a choice gets Polish", page.evaluate("document.documentElement.lang") == "pl")
        ctx.close()

        browser.close()

    # 7. The API refuses an unknown language.

    req = urllib.request.Request(base + "/api/locale", data=json.dumps({"locale": "de"}).encode(), headers={"content-type": "application/json", "origin": base}, method="POST")
    try:
        urllib.request.urlopen(req)
        code = 200
    except urllib.error.HTTPError as error:
        code = error.code
    check("unknown locale refused", code in (400, 422), code)

    server.stop()
    print(f"\n{PASSES} passed, {len(FAILS)} failed" + (f": {FAILS}" if FAILS else ""))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
