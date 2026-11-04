#!/usr/bin/env python3
"""The first ten minutes of a new user, in a real browser (docs/TOOLSETS.md): guest page and tool set pages (public, names
what they replace, trademark line), sign-up -> verify -> login -> `/` opens the welcome wizard once, each step, Skip, what
is pinned; a deep link is not interrupted; the CV wizard from nothing to a downloadable CV without any AI model, with a
draft that survives a reload; an uploaded CV's text filling in the questions. Self-contained: a public-mode scratch server
with outbox mail. Run: python3 tests/functional/welcome_wizard_e2e.py [--shots DIR]"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from playwright.sync_api import Page, expect, sync_playwright  # noqa: E402
from scratch_server import ScratchServer  # noqa: E402

FAILED: list[str] = []
PASSED = 0
SHOTS: Path | None = None


def check(name: str, ok: bool, detail: object = "") -> None:
    global PASSED
    if ok:
        PASSED += 1
        print(f"  ok  {name}")
    else:
        FAILED.append(name)
        print(f"FAIL  {name} {detail}")


def shot(page: Page, name: str) -> None:
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=True)


def go(page: Page, path: str) -> None:
    page.goto(path, wait_until="networkidle")


def latest_link(data: Path, path: str) -> str:
    mails = sorted((data / "mail-outbox").glob("*.eml"))
    text = mails[-1].read_bytes().decode("utf8", "replace").replace("=\r\n", "").replace("=\n", "").replace("=3D", "=")
    return re.search(r"https?://[^\s\"<>]*" + path + r"[^\s\"<>]*", text).group(0)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--shots")
    args = parser.parse_args()
    global SHOTS
    SHOTS = Path(args.shots) if args.shots else None
    with ScratchServer() as server, sync_playwright() as pw:
        server.start({"KNIFE_AUTH_MODE": "public", "KNIFE_MAIL_TRANSPORT": "outbox", "KNIFE_TRUSTED_PROXIES": "127.0.0.1/32,::1/128"})
        base, data = server.url, server.data_dir
        assert data
        browser = pw.chromium.launch()
        errors: list[str] = []

        def context(locale: str = "en", width: int = 1280, height: int = 900):
            ctx = browser.new_context(base_url=base, viewport={"width": width, "height": height}, extra_http_headers={"X-Forwarded-For": "198.51.100.31"})
            ctx.add_cookies([{"name": "knife_lang", "value": locale, "url": base}])
            page = ctx.new_page()
            page.on("console", lambda m: errors.append(f"{page.url}: {m.text[:300]}") if m.type == "error" and "Failed to load resource" not in m.text else None)
            page.on("pageerror", lambda e: errors.append(f"{page.url}: {e}"))
            return ctx, page

        # ------------------------------------------------------------------------------------ guest
        ctx, page = context()
        go(page, "/")
        expect(page.get_by_role("heading", level=1)).to_contain_text("Stop paying for", timeout=30_000)
        body = page.locator("main").inner_text()
        check("guest page names Microsoft and Adobe and what replaces them", all(x in body for x in ["Microsoft Word", "Euro-Office", "Adobe Photoshop", "PhotoCraft", "CV builder"]))
        check("guest page carries the trademark line", "trademarks of their owners" in body)
        check("guest page has no developer jargon", not re.search(r"self-hosted|sidecar|endpoint|deterministic", body, re.I))
        shot(page, "guest")
        for set_id, expected in [("office", "Stop paying for Microsoft 365"), ("creative", "Stop paying for Adobe"), ("career", "A professional CV")]:
            go(page, f"/sets/{set_id}")
            expect(page.get_by_role("heading", level=1)).to_contain_text(expected)
            check(f"/sets/{set_id} is public, with the trademark line where it names products", set_id == "career" or "trademarks of their owners" in page.locator("main").inner_text())
            shot(page, f"set-{set_id}")
        check("an unknown set is a 404", ctx.request.get(base + "/sets/nope").status == 404)
        r = ctx.request.get(base + "/tools/office", max_redirects=0)
        check("the tools a set links to still need an account", r.status in (302, 303, 307, 308) and "/login" in r.headers.get("location", ""), r.status)
        ctx2, phone = context(width=390, height=800)
        go(phone, "/")
        check("guest page fits a phone (no sideways scroll)", phone.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))
        shot(phone, "guest-phone")
        ctx2.close()

        # -------------------------------------------------------------------------------- sign up
        go(page, "/register")
        page.locator("input[autocomplete=username]").fill("newbie")
        page.locator("input[type=email]").fill("newbie@example.com")
        page.locator("input[autocomplete=new-password]").nth(0).fill("newbie password 1")
        page.locator("input[autocomplete=new-password]").nth(1).fill("newbie password 1")
        page.get_by_role("checkbox").check()
        page.get_by_role("button", name="Create account").click()
        page.wait_for_timeout(1500)
        for _ in range(40):
            if list((data / "mail-outbox").glob("*.eml")):
                break
            page.wait_for_timeout(250)
        go(page, latest_link(data, "/verify"))
        page.get_by_role("button", name="Confirm my email").click()
        page.wait_for_timeout(1500)
        account = next(a for a in json.loads((data / "accounts.json").read_text())["accounts"] if a["id"] == "newbie")
        check("a website sign-up is marked for the welcome wizard", account.get("needsWelcome") is True, account.get("needsWelcome"))
        go(page, "/login")
        if "/login" in page.url:
            page.locator("input[autocomplete=username]").fill("newbie")
            page.locator("input[type=password]").fill("newbie password 1")
            page.get_by_role("button", name="Log in").click()
            page.wait_for_url(lambda u: "/login" not in u, timeout=20_000)
        # A deep link is never interrupted.
        go(page, "/tools/qr")
        check("a link to a tool is not interrupted by the wizard", "/tools/qr" in page.url, page.url)

        # ------------------------------------------------------------------------------ the wizard
        go(page, "/")
        page.wait_for_url(re.compile(r"/welcome$"), timeout=20_000)
        check("the home page opens the wizard for a new account", True)
        expect(page.get_by_role("heading", level=1)).to_contain_text("Welcome to Smart Knife")
        shot(page, "welcome-1")
        page.locator("[data-welcome-language=en]").click()
        expect(page.get_by_role("heading", level=1)).to_contain_text("What did you come here for?")
        focused = page.evaluate("document.activeElement?.tagName")
        check("each step moves keyboard focus to its question", focused == "H1", focused)
        page.locator("[data-welcome-set=office]").click()
        page.locator("[data-welcome-set=career]").click()
        check("a choice shows as pressed", page.locator("[data-welcome-set=office]").get_attribute("aria-pressed") == "true")
        shot(page, "welcome-2")
        page.get_by_role("button", name="Back").click()
        expect(page.get_by_role("heading", level=1)).to_contain_text("Welcome to Smart Knife")
        page.locator("[data-welcome-language=en]").click()
        check("Back keeps the choices", page.locator("[data-welcome-set=office]").get_attribute("aria-pressed") == "true")
        page.get_by_role("button", name="Next", exact=True).click()
        expect(page.get_by_role("heading", level=1)).to_contain_text("Four things")
        shot(page, "welcome-3")
        page.get_by_role("button", name="Next", exact=True).click()
        expect(page.get_by_role("heading", level=1)).to_contain_text("All set")
        check("the last step offers what was picked", page.get_by_role("link", name="Open Euro-Office").is_visible() and page.get_by_role("link", name="Create my CV").is_visible())
        shot(page, "welcome-4")
        favorites = page.evaluate("JSON.parse(localStorage.getItem('samurai-knife:tool-preferences:v1')||'{}').favorites")
        check("the picks are pinned to Favorites", set(favorites or []) >= {"office", "cv-studio"}, favorites)
        page.wait_for_timeout(500)
        go(page, "/")
        check("after finishing, home stays home", page.url.rstrip("/") == base.rstrip("/"), page.url)
        expect(page.get_by_role("heading", level=1)).to_contain_text("What do you want to do today?")
        check("home leads with big tasks and tool sets", page.locator("[data-top-tasks] a").count() == 6 and page.locator("[data-set-card]").count() >= 7)
        check("an ordinary user's home does not list the administrators' page", "Server add-ons" not in page.locator("main").inner_text())
        shot(page, "home")

        # ---------------------------------------------------------------------- CV wizard, no AI at all
        go(page, "/tools/cv-studio")
        expect(page.locator("[data-cv-start-here]")).to_be_visible(timeout=30_000)
        shot(page, "cv-start")
        page.locator("[data-cv-start=scratch]").click()
        next_button = page.locator("[data-cv-wizard-next]")
        check("Next waits for the name, the one required answer", next_button.is_disabled())
        shot(page, "cv-1")
        page.locator("[data-cv-wizard]").get_by_role("button", name="English", exact=True).click()
        page.get_by_label("Your first and last name").fill("Anna Nowak")
        page.get_by_label("Email address").fill("anna@example.com")
        page.get_by_label("City").fill("Gdansk")
        page.wait_for_timeout(1500)
        page.reload(wait_until="networkidle")
        page.locator("[data-cv-start=scratch]").click()
        expect(page.get_by_text("We kept what you wrote last time.")).to_be_visible(timeout=10_000)
        check("a reload keeps the draft", page.get_by_label("Your first and last name").input_value() == "Anna Nowak")
        next_button.click()
        page.get_by_role("button", name="Accountant").click()
        check("an example fills in the job title", page.get_by_label("Job title").input_value() == "Accountant")
        next_button.click()
        job = page.locator("[data-cv-wizard-job='0']")
        job.get_by_label("Company or employer").fill("Acme")
        job.get_by_label("Your position").fill("Bookkeeper")
        job.get_by_label("Started").fill("marzec")
        expect(job.get_by_text("We can't read this date")).to_be_visible()
        check("an unreadable date is explained on the spot", True)
        job.get_by_label("Started").fill("03.2020")
        job.get_by_label("I still work here").check()
        check("'I still work here' hides the end date", job.get_by_label("Finished").count() == 0)
        job.get_by_label("What did you do there?").fill("Kept the books\nFiled VAT returns")
        page.get_by_role("button", name="Add another job").click()
        check("another job can be added", page.locator("[data-cv-wizard-job]").count() == 2)
        page.get_by_role("button", name="Remove this job").nth(1).click()
        shot(page, "cv-3")
        next_button.click()
        page.get_by_label("School or university").fill("University of Gdansk")
        next_button.click()
        page.get_by_label("Your skills").fill("Excel, SAP")
        page.get_by_role("button", name="Add a language").click()
        page.get_by_label("Language", exact=True).fill("Polish")
        page.get_by_label("Level").select_option("Native")
        next_button.click()
        page.get_by_role("button", name="Write it for me from my answers").click()
        summary = page.get_by_label("A few words about you").input_value()
        check("the suggested text comes only from the answers", summary == "Accountant. Most recently Bookkeeper at Acme. My strengths: Excel, SAP.", summary)
        next_button.click()
        review = page.locator("[data-cv-wizard=review]").inner_text()
        check("the last step shows everything back", all(x in review for x in ["Anna Nowak", "Bookkeeper, Acme", "University of Gdansk", "Excel, SAP"]), review[:300])
        shot(page, "cv-review")
        page.locator("[data-cv-wizard-create]").click()
        expect(page.locator("[data-cv-wizard-done]")).to_be_visible(timeout=20_000)
        shot(page, "cv-done")
        page.wait_for_timeout(500)
        check("the draft is gone once the CV exists", ctx.request.get(base + "/api/workspace?tool=cv-wizard").json() == {})
        page.locator("[data-cv-wizard-see]").click()
        page.wait_for_url(re.compile(r"tab=variants"), timeout=20_000)
        expect(page.get_by_text("Anna Nowak").first).to_be_visible(timeout=20_000)
        check("the CV shows up, ready to download", page.get_by_role("button", name=re.compile("PDF")).first.is_visible())
        shot(page, "cv-preview")
        cv = ctx.request.get(base + "/api/cv").json()
        profile = cv.get("profile", cv)
        check("the profile holds the answers", profile["experience"][0]["org"] == "Acme" and profile["experience"][0]["end"] is None and profile["contact"]["name"] == "Anna Nowak", str(profile)[:300])

        # --------------------------------------------------------------- bring in a CV, also without AI
        ctx3 = browser.new_context(base_url=base, viewport={"width": 1280, "height": 900}, extra_http_headers={"X-Forwarded-For": "198.51.100.32"}, storage_state=ctx.storage_state())
        upload = ctx3.new_page()
        project = ctx3.request.post(base + "/api/cv/projects", data={"action": "create", "name": "Second"}, headers={"Origin": base})
        if project.ok:
            go(upload, "/tools/cv-studio")
            upload.locator("[data-cv-start=upload]").click()
            upload.get_by_label("CV text").fill("Jan Kowalski\njan@example.com\n+48 600 100 200\nDoswiadczenie: Acme")
            upload.locator("[data-cv-fill-wizard]").click()
            check("the questions start filled in from the pasted CV", upload.get_by_label("Your first and last name").input_value() == "Jan Kowalski" and upload.get_by_label("Email address").input_value() == "jan@example.com")
            check("the CV text stays next to the questions", upload.get_by_text("Doswiadczenie: Acme").is_visible())
            shot(upload, "cv-from-file")
        else:
            check("a second CV project could be created for the upload path", False, project.status)
        ctx3.close()

        # -------------------------------------------------------------------------------- Polish
        ctx4, pl = context("pl")
        go(pl, "/")
        expect(pl.get_by_role("heading", level=1)).to_contain_text("Przestań płacić za")
        go(pl, "/sets/creative")
        check("Polish set page", "Zamiast" in pl.locator("main").inner_text() and "zamiast" not in pl.get_by_role("heading", level=1).inner_text())
        shot(pl, "set-creative-pl")
        ctx4.close()
        check("no console errors", not errors, errors[:5])
        browser.close()
    print(f"\n{PASSED} passed, {len(FAILED)} failed")
    for name in FAILED:
        print("  FAILED:", name)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
