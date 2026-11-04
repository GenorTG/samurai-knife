#!/usr/bin/env python3
"""Tool showcases end to end (docs/SHOWCASE.md), in Chromium and Firefox:

- a launcher card and a home feature card open the tool's showcase (/tools/<slug>/about, Polish, picture, SEO title),
  "Otwórz narzędzie" opens the tool (with the card's tab), every tool page links back with "O tym narzędziu";
- "Nie pokazuj ponownie" skips one tool's showcase from then on, "Otwieraj narzędzia od razu" skips all, both survive a
  reload (local storage) and can be undone;
- a retired slug's showcase redirects to its suite's; the server render hydrates without errors;
- public mode, signed out: the showcase renders in the welcome frame with the sign-in hint, the tool page still
  redirects to /login?next=.

Self-contained: its own scratch servers (tests/scratch_server.py), fresh data dirs; never the live :3210 server.
With --shots DIR it saves the evidence screenshots (home, launcher, three showcases; Chromium + Firefox; 1440 and 390 px).

Usage: python3 tests/functional/showcase_e2e.py [--shots DIR] [--headed]
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from playwright.sync_api import Browser, Page, sync_playwright  # noqa: E402

from tests.scratch_server import ScratchServer  # noqa: E402

SHOTS = Path(sys.argv[sys.argv.index("--shots") + 1]) if "--shots" in sys.argv else None
HEADED = "--headed" in sys.argv
FAILS: list[str] = []
PASSES = 0
SHOWN = ("cv-studio", "pdf", "db-course")


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
    page.wait_for_function("() => !/Loading tool|Wczytywanie narzędzia/.test(document.body.innerText)", timeout=60000)


def hydrated(page: Page) -> None:
    # React props on a <main> control = hydrated (AGENTS.md: wait for hydration, not a fixed delay).
    page.wait_for_function("() => [...document.querySelectorAll('main button, main input')].some((el) => Object.keys(el).some((k) => k.startsWith('__reactProps')))", timeout=60000)


def shot(page: Page, name: str) -> None:
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=False)


def flow(base: str, browser: Browser, engine: str) -> None:
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="pl-PL", timezone_id="Europe/Warsaw")
    ctx.add_cookies([{"name": "knife_lang", "value": "pl", "url": base}])
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "hydrat" in m.text.lower() else None)

    page.goto(base + "/", wait_until="networkidle")
    hydrated(page)
    shot(page, f"{engine}-1440-home")
    # The home feature card for the CV builder's Website tab -> its showcase with the tab carried along.
    card = page.locator("main a[href^='/tools/cv-studio/about']").filter(has_text="Studio stron internetowych")
    check(f"[{engine}] home feature card links to the showcase with its tab", card.count() == 1 and card.get_attribute("href") == "/tools/cv-studio/about?tab=website", card.count())
    page.locator("#all-tools").scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    shot(page, f"{engine}-1440-launcher")

    # Launcher card -> showcase.
    page.locator("[data-launcher-search]").fill("json")
    page.locator("main article button").filter(has_text="JSON i konfiguracja").first.click()
    page.wait_for_url("**/tools/json/about", timeout=30000)
    settle(page)
    check(f"[{engine}] launcher card opens /tools/json/about", page.url.endswith("/tools/json/about"), page.url)
    check(f"[{engine}] showcase is Polish with sections and a Polish title", page.evaluate("document.documentElement.lang") == "pl"
          and page.get_by_role("heading", name="Co możesz zrobić").count() == 1 and page.get_by_role("heading", name="Gdzie działa").count() == 1
          and "czym jest i co robi" in page.title(), page.title())
    img = page.locator("main figure img")
    check(f"[{engine}] showcase picture loads", img.count() == 1 and page.evaluate("(img) => img.complete && img.naturalWidth === 1280", img.element_handle()))
    check(f"[{engine}] description meta is the purpose", "JSON" in (page.locator('meta[name="description"]').get_attribute("content") or ""))
    page.get_by_role("link", name="Otwórz narzędzie").click()
    page.wait_for_url("**/tools/json", timeout=30000)
    settle(page)
    about = page.locator("main [data-showcase-link]")
    check(f"[{engine}] tool page links back with 'O tym narzędziu'", about.count() == 1 and about.inner_text().strip() == "O tym narzędziu", about.count())

    # Showcase with a tab: the Open button keeps it.
    page.goto(base + "/tools/cv-studio/about?tab=website", wait_until="networkidle")
    check(f"[{engine}] Open keeps the tab", page.get_by_role("link", name="Otwórz narzędzie").get_attribute("href") == "/tools/cv-studio?tab=website")

    # Skip one tool.
    page.goto(base + "/tools/json/about", wait_until="networkidle")
    hydrated(page)
    page.get_by_label("Nie pokazuj ponownie tej strony dla tego narzędzia").check()
    page.goto(base + "/", wait_until="networkidle")
    hydrated(page)
    page.locator("[data-launcher-search]").fill("json")
    page.locator("main article button").filter(has_text="JSON i konfiguracja").first.click()
    page.wait_for_url("**/tools/json", timeout=30000)
    check(f"[{engine}] a skipped tool opens straight away", page.url.endswith("/tools/json"), page.url)
    page.goto(base + "/", wait_until="networkidle")
    hydrated(page)
    page.locator("[data-launcher-search]").fill("regex")
    page.locator("main article button").filter(has_text="Laboratorium regex").first.click()
    page.wait_for_url("**/tools/regex/about", timeout=30000)
    check(f"[{engine}] other tools still open their showcase", page.url.endswith("/tools/regex/about"), page.url)

    # Open everything straight away, survives a reload, then undo.
    hydrated(page)
    page.get_by_label("Otwieraj narzędzia od razu (pomijaj te strony)").check()
    page.goto(base + "/", wait_until="networkidle")
    hydrated(page)
    page.wait_for_function("() => document.querySelector(\"main a[href='/tools/pdf']\")", timeout=15000)
    check(f"[{engine}] 'open straight away' turns home cards into tool links", page.locator("main a[href='/tools/pdf']").count() >= 1)
    page.reload(wait_until="networkidle")
    hydrated(page)
    page.locator("[data-launcher-search]").fill("qr")
    page.locator("main article button").filter(has_text="Kody QR").first.click()
    page.wait_for_url("**/tools/qr", timeout=30000)
    check(f"[{engine}] the choice survives a reload", page.url.endswith("/tools/qr"), page.url)
    page.goto(base + "/tools/qr/about", wait_until="networkidle")
    hydrated(page)
    page.get_by_label("Otwieraj narzędzia od razu (pomijaj te strony)").uncheck()
    page.get_by_label("Nie pokazuj ponownie tej strony dla tego narzędzia").uncheck()
    stored = page.evaluate("localStorage.getItem('samurai-knife:showcase:v1')")
    check(f"[{engine}] the choice is stored only in local storage, and can be undone", stored is not None and '"direct":false' in stored, stored)

    # Retired slug -> the suite's showcase.
    page.goto(base + "/tools/cron/about", wait_until="networkidle")
    check(f"[{engine}] retired slug redirects to the suite's showcase", "/tools/dates/about" in page.url, page.url)

    for slug in SHOWN:
        page.goto(base + f"/tools/{slug}/about", wait_until="networkidle")
        hydrated(page)
        shot(page, f"{engine}-1440-showcase-{slug}")
    check(f"[{engine}] no page or hydration errors", not errors, errors[:3])
    ctx.close()

    # Phone width: the same pages fit 390 px.
    phone = browser.new_context(viewport={"width": 390, "height": 844}, locale="pl-PL", timezone_id="Europe/Warsaw", **({"is_mobile": True, "has_touch": True} if engine == "chromium" else {}))
    phone.add_cookies([{"name": "knife_lang", "value": "pl", "url": base}])
    page = phone.new_page()
    for name, path in (("home", "/"), ("launcher", "/"), *((f"showcase-{s}", f"/tools/{s}/about") for s in SHOWN)):
        page.goto(base + path, wait_until="networkidle")
        if name == "launcher":
            page.locator("#all-tools").scroll_into_view_if_needed()
            page.wait_for_timeout(300)
        overflow = page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        check(f"[{engine}] 390 px {name}: no horizontal overflow", overflow <= 1, overflow)
        shot(page, f"{engine}-390-{name}")
    phone.close()


def guest(base: str, browser: Browser) -> None:
    ctx = browser.new_context(locale="pl-PL")
    page = ctx.new_page()
    res = page.goto(base + "/tools/pdf/about", wait_until="networkidle")
    check("[public] signed-out visitor sees the showcase", res is not None and res.status == 200 and page.locator("main[data-showcase='pdf']").count() == 1, res and res.status)
    check("[public] it says the button leads to sign-in", page.get_by_text("Do korzystania potrzebujesz konta").count() == 1)
    check("[public] no assistant widget or tool list for guests", page.locator("[data-launcher-search]").count() == 0)
    page.get_by_role("link", name="Otwórz narzędzie").click()
    page.wait_for_url("**/login?next=*", timeout=30000)
    check("[public] the tool itself still needs a session", "/login?next=" in page.url, page.url)
    ctx.close()


def main() -> int:
    with ScratchServer() as server:
        base = server.start(overlay=untracked())
        with sync_playwright() as pw:
            for engine in ("chromium", "firefox"):
                browser = getattr(pw, engine).launch(headless=not HEADED)
                try:
                    flow(base, browser, engine)
                finally:
                    browser.close()
            server.restart(env={"KNIFE_AUTH_MODE": "public", "KNIFE_MAIL_TRANSPORT": "outbox"})
            browser = pw.chromium.launch(headless=not HEADED)
            try:
                guest(server.url, browser)
            finally:
                browser.close()
    print(f"\n{PASSES} passed, {len(FAILS)} failed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
