#!/usr/bin/env python3
"""Signup regression: typed and eventless password-manager values, native validation and consent.
Self-contained scratch public server with outbox mail; no live accounts or mail are touched.
Usage: python3 tests/functional/signup_autofill_e2e.py [--browser chromium|firefox]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from playwright.sync_api import expect, sync_playwright  # noqa: E402
from tests.scratch_server import ScratchServer  # noqa: E402
from tests.functional.accounts_public_e2e import Outbox  # noqa: E402

PASSWORD = "Generated-aB39-xY87-Safe!"
SUCCESS = "If the details can be used, a message is on its way to that address."
ENV = {"KNIFE_AUTH_MODE": "public", "KNIFE_MAIL_TRANSPORT": "outbox",
       "KNIFE_POW_BITS": "8", "KNIFE_POW_MAX_BITS": "16"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", choices=("chromium", "firefox"), default="chromium")
    args = parser.parse_args()
    with ScratchServer() as server, sync_playwright() as pw:
        server.start(env=ENV)
        browser = getattr(pw, args.browser).launch()
        try:
            page = browser.new_page()
            submissions = []
            page.on("request", lambda request: submissions.append(request) if request.url.endswith("/api/account/register") else None)
            for index, mode in enumerate(("silent", "typed", "mixed", "corrected")):
                page.goto(server.url + "/register")
                fields = page.locator('form[aria-label="Create account"] input')
                expect(fields).to_have_count(4)
                button = page.get_by_role("button", name="Create account", exact=True)
                values = [f"autofill{index}", f"autofill{index}@example.com", PASSWORD, PASSWORD]
                if mode == "typed":
                    for field, value in zip(fields.all(), values):
                        field.fill(value)
                else:
                    if mode in ("mixed", "corrected"):
                        fields.nth(0).fill(values[0])
                        fields.nth(1).fill(values[1])
                        fields.nth(2).fill("old password value")
                        fields.nth(3).fill("different old value")
                    # Deliberately emit NO input/change events: reproduces password-manager/restore
                    # values diverging from React state. Normal typing above uses real browser events.
                    fields.evaluate_all("(fields, values) => fields.forEach((field, i) => { field.value = values[i]; })", values)
                expect(button).to_be_disabled()  # consent is still mandatory
                page.get_by_role("checkbox").check()  # parent rerender must preserve silent autofill
                assert fields.evaluate_all("(fields) => fields.map(field => field.value)") == values
                expect(button).to_be_enabled(timeout=2000)
                before = len(submissions)
                if mode == "corrected":
                    fields.nth(3).fill("does not match password")
                    button.click()
                    expect(page.get_by_text("The passwords do not match.", exact=True)).to_be_visible()
                    assert len(submissions) == before
                    fields.nth(3).evaluate("(field, value) => { field.value = value; }", PASSWORD)
                if mode == "silent":
                    # Native required/email validation must still block without sending a request.
                    fields.nth(3).fill("")
                    button.click()
                    assert fields.nth(3).evaluate("(field) => field.validity.valueMissing")
                    fields.nth(3).fill(PASSWORD)
                    fields.nth(1).fill("not-an-email")
                    button.click()
                    assert fields.nth(1).evaluate("(field) => field.validity.typeMismatch")
                    fields.nth(1).fill(values[1])
                    fields.nth(2).fill("short")
                    button.click()
                    assert fields.nth(2).evaluate("(field) => field.validity.tooShort")
                    fields.nth(2).fill(PASSWORD)
                assert len(submissions) == before
                with page.expect_response(lambda response: response.url.endswith("/api/account/register")) as pending:
                    button.click()
                response = pending.value
                assert response.status == 202, response.text()
                expect(page.get_by_text(SUCCESS, exact=False)).to_be_visible(timeout=20000)
                # The actual server must have accepted the values, not merely returned a generic message.
                store = json.loads((server.data_dir / "accounts.json").read_text())
                accounts = store["accounts"]
                account = next(account for account in accounts if account["id"] == values[0])
                assert account["email"] == values[1], account
                assert account["status"] == "pending", account
                assert account["termsVersion"]
                mails = Outbox(server.data_dir).wait(values[1], 1)
                assert mails, "confirmation mail was not delivered to scratch outbox"
                link = Outbox.link(mails[0][2], "/verify")
                assert link
                page.goto(link)
                page.get_by_role("button", name="Confirm my email").click()
                expect(page.get_by_text(f"Your email is confirmed, {values[0]}", exact=False)).to_be_visible()
                page.goto(server.url + "/login")
                page.locator('input[autocomplete="username"]').fill(values[0])
                page.locator('input[autocomplete="current-password"]').fill(PASSWORD)
                page.get_by_role("button", name="Log in", exact=True).click()
                page.wait_for_url(server.url + "/", timeout=20000)
                assert page.request.get(server.url + "/api/account").status == 200
                page.context.clear_cookies()
                print(f"PASS {args.browser}: {mode} signup + consent/validation + stored account", flush=True)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
