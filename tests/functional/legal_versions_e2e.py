#!/usr/bin/env python3
"""Legal versions end to end on a scratch public-mode server, in Firefox: the pages name their edition, fingerprint,
publication day and the Smart Knife version; earlier editions of the defaults are readable; a sign-up's accepted
version shows in Account settings; a change of the instance's details is a new version, the old one stays readable
(page, download, GET /api/legal), the Terms page states the notice period for older accounts, and the account sees
that a newer version applies. docs/LEGAL.md is the contract.

Usage: python3 tests/functional/legal_versions_e2e.py [--headed]
"""
from __future__ import annotations

import json
import re
import secrets
import sys
import time
import traceback
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from playwright.sync_api import Page, expect, sync_playwright  # noqa: E402

from tests.functional.accounts_public_e2e import Api, Outbox  # noqa: E402
from tests.scratch_server import ScratchServer  # noqa: E402

HEADED = "--headed" in sys.argv
FAILS: list[str] = []
PASSES = 0


def check(name: str, ok: bool, detail: object = "") -> bool:
    global PASSES
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  -> ' + str(detail)[:600]}", flush=True)
    if ok:
        PASSES += 1
    else:
        FAILS.append(name)
    return ok


def go(page: Page, base: str, path: str) -> None:
    page.goto(base + path, wait_until="domcontentloaded")
    page.wait_for_load_state("load")


def footer(page: Page) -> str:
    return page.locator("footer[data-legal-version]").inner_text()


def history_files(data: Path) -> list[Path]:
    return sorted((data / "legal-history").glob("*.json"))


def run(server: ScratchServer, page: Page) -> None:
    base, data = server.url, server.data_dir
    today = time.strftime("%Y-%m-%d", time.gmtime())
    api = Api(base)
    versions = json.loads((ROOT / "legal" / "versions.json").read_text())
    edition = versions["editions"][0]["edition"]

    # --------------------------------------------------------------------------------- 1. the current version
    go(page, base, "/privacy?lang=en")
    v1 = page.locator("footer[data-legal-version]").get_attribute("data-legal-version")
    text = footer(page)
    check("privacy footer: version, edition, published today, effective date, Smart Knife version",
          f"Version {v1}" in text and f"edition {edition}" in text and f"published {today}" in text
          and f"effective from {today}" in text and re.search(r"Smart Knife \d+\.\d+\.\d+\.\d+", text), text)
    check("showing the page kept the version in the instance's history", len(history_files(data)) == 1, history_files(data))
    check("section 15 lists what each Smart Knife version added",
          page.get_by_role("heading", name=re.compile(r"15\. Versions of this notice")).is_visible()
          and page.get_by_role("cell", name=re.compile(r"^Workflows: automations")).is_visible())
    check("the Effective-from line in the text is filled with the publication day", f"Effective from: {today}." in page.locator("main").inner_text())
    check("the shipped edition names the Craft files and workflow credentials",
          "files you save from the Craft apps" in page.locator("main").inner_text() and "Workflow credentials" in page.locator("main").inner_text())
    go(page, base, "/privacy?lang=pl")
    check("Polish notice: section 15 and the edition line",
          page.get_by_role("heading", level=1).inner_text().startswith("Polityka prywatności")
          and f"wydanie {edition}" in footer(page) and f"Wydanie {edition}" in page.locator("main").inner_text())

    # --------------------------------------------------------------------------------- 2. earlier editions
    go(page, base, "/terms?lang=en")
    check("the footer offers the earlier editions of the default texts",
          page.locator("footer").get_by_role("link", name="edition 1").count() == 1, footer(page))
    page.locator("footer").get_by_role("link", name="edition 1").click()
    page.wait_for_url(re.compile(r"/terms\?lang=en&edition=1$"))
    main = page.locator("main").inner_text()
    shown = main.split("Go to the current version", 1)[-1]
    check("edition 1 is shown as an earlier version, without the new services",
          "This is an earlier version (edition 1, 2026-10-21)" in main and "Craft" not in shown and "workflow" not in shown.lower(), main[:400])
    check("an earlier edition's language link keeps the edition", page.get_by_role("link", name="Polski").get_attribute("href") == "/terms?lang=pl&edition=1")
    status = urllib.request.urlopen(base + "/api/legal?doc=terms&lang=en&edition=1", timeout=30)
    body = status.read().decode()
    check("the download of edition 1 is that edition's text", "Craft" not in body and "Terms of Service" in body and "edition-1" in status.headers["Content-Disposition"], status.headers["Content-Disposition"])

    # --------------------------------------------------------------------------------- 3. a sign-up records its version
    status, answer, _ = api.call("POST", "/api/account/register", {"username": "lena", "email": "lena@example.com", "password": "lena password 1"}, ip="198.51.100.40")
    mails = Outbox(data).wait("lena@example.com", 1)
    link = Outbox.link(mails[0][2], "/verify") if mails else None
    status, answer, _ = api.call("POST", "/api/account/verify", {"token": Outbox.token(link)}, ip="198.51.100.40")
    check("sign-up with the current version, verified", status == 200, (status, answer))
    status, _, cookie = api.login("lena", "lena password 1", "198.51.100.41")
    stored = json.loads((data / "accounts.json").read_text())
    lena = next(a for a in stored["accounts"] if a["id"] == "lena")
    check("the account stores the version the page showed", lena.get("termsVersion") == v1, lena.get("termsVersion"))
    name, value = cookie.split("=", 1)
    page.context.add_cookies([{"name": name, "value": value, "url": base}])
    go(page, base, "/account")
    accepted = page.locator("[data-terms-accepted]")
    expect(accepted).to_be_visible(timeout=15_000)
    check("Account settings: the accepted version, its edition and day, current",
          f"You accepted version {v1} (edition {edition}) on {today}, the current one." in accepted.inner_text(), accepted.inner_text())

    # --------------------------------------------------------------------------------- 4. new details = new version
    legal_dir = data / "legal"
    legal_dir.mkdir(exist_ok=True)
    example = json.loads((ROOT / "legal" / "legal.example.json").read_text())
    (legal_dir / "legal.json").write_text(json.dumps({**example, "operatorName": "Ewa Nowak", "effectiveDate": "2026-01-01"}))
    go(page, base, "/terms?lang=en")
    v2 = page.locator("footer[data-legal-version]").get_attribute("data-legal-version")
    check("new details: a new version; the operator's earlier effectiveDate yields to the publication day",
          v2 != v1 and f"effective from {today}" in footer(page) and "Ewa Nowak" in page.locator("main").inner_text(), (v1, v2, footer(page)))
    check("the Terms page states the notice period for accounts created earlier",
          page.get_by_text(re.compile(r"For Accounts created before this version was published, these Terms apply from \d{4}-\d{2}-\d{2} \(section 15\)")).is_visible())
    rows = page.locator("footer section ul").first.locator("li")
    check("Earlier versions: both versions, the old one with its period", rows.count() == 2 and v1 in rows.nth(1).inner_text() and f"{today} – {today}" in rows.nth(1).inner_text(),
          [rows.nth(i).inner_text() for i in range(rows.count())])
    page.locator("footer section").get_by_role("link", name=v1).click()
    page.wait_for_url(re.compile(rf"/terms\?lang=en&version={v1}$"))
    main = page.locator("main").inner_text()
    check("the old version is readable as it was (no operator name yet), marked as earlier",
          f"This is an earlier version (Version {v1}, {today})" in main and "Ewa Nowak" not in main and "[operatorName?]" in main, main[:300])
    with urllib.request.urlopen(base + "/api/legal", timeout=30) as resp:
        meta = json.loads(resp.read().decode())
    check("GET /api/legal: current version, edition, history of two",
          meta["version"] == v2 and meta["edition"] == edition and [h["version"] for h in meta["history"]] == [v1, v2], meta)
    with urllib.request.urlopen(base + f"/api/legal?doc=privacy&lang=pl&version={v1}", timeout=30) as resp:
        old = resp.read().decode()
    check("the download of the old version is its text", "Ewa Nowak" not in old and "Polityka prywatności" in old)
    go(page, base, "/account")
    accepted = page.locator("[data-terms-accepted]")
    check("Account settings: a newer version applies, with links to what changed",
          "A newer version applies now" in accepted.inner_text()
          and accepted.get_by_role("link", name="Terms").get_attribute("href") == "/terms#history"
          and accepted.get_by_role("link", name="Read it").get_attribute("href") == f"/terms?version={v1}", accepted.inner_text())
    check("still two versions kept (pages and account reads add none)", len(history_files(data)) == 2, history_files(data))


def main() -> int:
    env = {
        "KNIFE_AUTH_MODE": "public",
        "KNIFE_MAIL_TRANSPORT": "outbox",
        "KNIFE_SIDECAR_PREFIX": f"sk-legal-e2e-{secrets.token_hex(3)}",
        "KNIFE_POW_BITS": "8",
        "KNIFE_POW_MAX_BITS": "16",
    }
    with ScratchServer() as server:
        server.start(env=env)
        print(f"scratch server {server.url} data {server.data_dir}", flush=True)
        with sync_playwright() as pw:
            browser = pw.firefox.launch(headless=not HEADED)
            try:
                page = browser.new_page()
                errors: list[str] = []
                page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
                run(server, page)
                check("no console errors (hydration included)", not errors, errors[:5])
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                FAILS.append("crashed: " + traceback.format_exc().strip().splitlines()[-1])
                print(server.log_tail(3000))
            finally:
                browser.close()
    print(f"\n{PASSES} passed, {len(FAILS)} failed")
    if FAILS:
        print(f"{len(FAILS)} FAILED: {FAILS}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
