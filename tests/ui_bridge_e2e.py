#!/usr/bin/env python3
"""Agents OUTSIDE the app steering it over MCP (POST /api/mcp), the way an OpenClaw / Claude / Cursor client would.

A real browser opens the app; the test then acts only through MCP and checks what the person would see:
knife_ui_state lists the open tab and where it is; a knife_cv_* edit shows up on the open page by itself (polling + toast);
knife_ui_show moves the visible tab (deep link to one CV version) and shows the agent's note; bad slugs/tabs are refused;
a hidden tab stops polling, so a show request then reports that nobody is listening. The app's network still goes idle.

Usage: python3 tests/ui_bridge_e2e.py <base_url>   (fresh KNIFE_DATA_DIR; no provider needed)
"""
import json
import sys
import time
import urllib.request

from playwright.sync_api import expect, sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3210").rstrip("/")
FAILS: list[str] = []


def check(cond, message, detail=""):
    print(("ok   " if cond else "FAIL ") + message + ("" if cond or not detail else f"  -> {str(detail)[:300]}"), flush=True)
    if not cond:
        FAILS.append(message)


def mcp(name, args=None):
    # No Origin header: MCP clients are not browsers (the route's host guard still applies).
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args or {}}}).encode()
    req = urllib.request.Request(BASE + "/api/mcp", data=body, method="POST", headers={"content-type": "application/json", "accept": "application/json, text/event-stream"})
    with urllib.request.urlopen(req, timeout=60) as res:
        raw = res.read().decode()
    result = json.loads(raw[raw.find("{"):])["result"]
    text = result["content"][0]["text"]
    try:
        return json.loads(text), result.get("isError", False)
    except ValueError:
        return text, result.get("isError", False)


def wait_for(fn, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        value = fn()
        if value:
            return value
        time.sleep(0.3)
    return fn()


PROFILE = {
    "contact": {"name": "Jan Testowy", "headline": {"pl": "Programista", "en": "Developer"}, "email": "jan@example.com"},
    "summary": {"pl": "Buduję usługi w Pythonie.", "en": "I build Python services."},
    "experience": [{"id": "acme", "org": "Acme", "role": {"pl": "Programista", "en": "Developer"}, "start": "2022-01", "bullets": [{"id": "b1", "text": {"pl": "Napisałem API.", "en": "Wrote an API."}}]}],
}

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    imported, err = mcp("knife_cv_import", {"profile": PROFILE})
    check(not err, "knife_cv_import over MCP", imported)

    page.goto(f"{BASE}/tools/cv-studio?tab=profile", wait_until="domcontentloaded")
    expect(page.locator("main")).to_contain_text("Jan Testowy", timeout=60000)

    state = wait_for(lambda: (lambda s: s if s[0]["tabs"] else None)(mcp("knife_ui_state")), 15)
    tabs = state[0]["tabs"] if state else []
    check(len(tabs) == 1 and tabs[0]["path"] == "/tools/cv-studio?tab=profile" and tabs[0]["visible"] and tabs[0]["connected"], "knife_ui_state: the open tab, its page, visible and connected", tabs)

    out, err = mcp("knife_cv_patch", {"ops": [{"op": "set", "path": "/contact/headline/pl", "value": "Inżynier AI (z MCP)"}]})
    check(not err and out["applied"] == 1, "knife_cv_patch over MCP", out)
    try:
        expect(page.locator("main")).to_contain_text("Inżynier AI (z MCP)", timeout=8000)
        check(True, "the open Profile tab shows the MCP edit by itself (no reload)")
    except AssertionError as exc:
        check(False, "the open Profile tab shows the MCP edit by itself (no reload)", exc)
    check(page.locator("[data-cv-toast]").count() > 0, "a change toast with Undo tells the person what changed")

    mcp("knife_cv_variant_create", {"id": "first", "name": "First version", "lang": "pl"})
    mcp("knife_cv_variant_create", {"id": "second", "name": "Second version", "lang": "en"})
    shown, err = mcp("knife_ui_show", {"slug": "cv-studio", "tab": "variants", "variant": "first", "note": "Zrobiłem wersję"})
    check(not err and shown.get("shown") is True and shown["path"] == "/tools/cv-studio?tab=variants&variant=first", "knife_ui_show reaches the tab", shown)
    try:
        page.wait_for_url("**/tools/cv-studio?tab=variants&variant=first", timeout=8000)
        expect(page.get_by_role("button", name="Open version First version", exact=True)).to_have_attribute("aria-pressed", "true", timeout=15000)
        check(True, "the tab moved to CV versions with the deep-linked (older) version selected")
    except Exception as exc:  # noqa: BLE001
        check(False, "the tab moved to CV versions with the deep-linked (older) version selected", exc)
    notice = page.locator("[data-ui-bridge-notice]")
    check(notice.count() == 1 and "Zrobiłem wersję" in notice.inner_text(), "the agent's note is shown to the person", notice.all_inner_texts())
    check(page.locator("main [data-ui-bridge-notice]").count() == 0, "the notice is outside <main> (never in a page snapshot)")

    bad, err = mcp("knife_ui_show", {"slug": "cv-studio", "tab": "nope"})
    check(err and "has no tab" in str(bad), "an unknown tab is refused with the valid ones", bad)
    bad, err = mcp("knife_ui_show", {"slug": "https://evil.example"})
    check(err and "unknown tool" in str(bad), "a URL / unknown slug is refused", bad)

    later = wait_for(lambda: mcp("knife_ui_state")[0]["tabs"][0]["path"].endswith("variant=first") or None, 25)
    check(bool(later), "presence follows the navigation (knife_ui_state reports the new page)")

    # the bridge must not keep the network busy (many suites and the assistant wait for "network idle")
    try:
        page.goto(f"{BASE}/tools/json", wait_until="networkidle", timeout=20000)
        check(True, "the app's network still goes idle with the bridge polling")
    except Exception as exc:  # noqa: BLE001
        check(False, "the app's network still goes idle with the bridge polling", exc)

    # hide the tab: it stops polling, so nobody can be steered
    page.evaluate("() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); }")
    hidden = wait_for(lambda: (lambda s: s if s.get("shown") is False else None)(mcp("knife_ui_show", {"slug": "json"})[0]), 12)
    check(bool(hidden) and "No app tab" in hidden.get("note", ""), "a hidden tab stops polling: show reports nobody listening", hidden)

    check(not errors, "no page errors", errors)
    browser.close()

print(f"\n{len(FAILS)} failed: {FAILS}" if FAILS else "\nall passed")
sys.exit(1 if FAILS else 0)
