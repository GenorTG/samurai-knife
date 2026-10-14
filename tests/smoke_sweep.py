"""Browser smoke sweep for the tool registry and its suites.

Checks, against a running server:
  1. every listed slug hydrates at 1280px and 390px with no console errors,
     and never overflows horizontally at 390px (suites also keep their tab
     strip inside the viewport);
  2. every retired slug in SLUG_ALIASES redirects permanently (308) to its
     suite, lands on the right ?tab=, and the final response is 200;
  3. every suite tab renders via ?tab= at both viewports;
  4. suite tab keyboard navigation and the ?tab= fallback behave, without a
     full page reload; unknown slugs still return 404.

Usage: python3 tests/smoke_sweep.py [base_url]   (needs python `playwright` + chromium)
"""
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import BrowserContext, Page, sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3210").rstrip("/")
REGISTRY = Path(__file__).resolve().parent.parent / "src/lib/registry.ts"
KEYBOARD_SUITE = "json"


def parse_registry(text: str) -> tuple[list[str], dict[str, list[str]], dict[str, tuple[str, str]]]:
    """Return (listed slugs, suite slug -> tab ids, alias -> (suite slug, tab))."""
    listed: list[str] = []
    suites: dict[str, list[str]] = {}
    current = ""
    for line in text.split("export const SLUG_ALIASES")[0].splitlines():
        slug = re.match(r'^    slug:\s*"([^"]+)"', line)
        if slug:
            current = slug.group(1)
            listed.append(current)
            continue
        tab = re.match(r'^\s+\{ id: "([^"]+)", label:', line)
        if tab and current:
            suites.setdefault(current, []).append(tab.group(1))
    aliases = {
        m.group(1): (m.group(2), m.group(3))
        for m in re.finditer(
            r'^  "([^"]+)": \{ slug: "([^"]+)", tab: "([^"]+)" \}', text, flags=re.M
        )
    }
    return listed, suites, aliases


listed, suites, aliases = parse_registry(REGISTRY.read_text())
assert listed and aliases and suites, "registry parse failed"

OVERFLOW_JS = "document.documentElement.scrollWidth - document.documentElement.clientWidth"
failures: list[str] = []
loads = 0


def watch(page: Page, problems: list[str]) -> None:
    page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
    page.on("console", lambda m: m.type == "error" and problems.append(f"console: {m.text[:160]}"))


def check_page(page: Page, problems: list[str], mobile: bool) -> None:
    if page.locator("main h1, h1").count() == 0:
        problems.append("no h1")
    if page.locator("button, input, textarea, select, a[href]").count() < 2:
        problems.append("no interactive controls")
    if mobile:
        over = page.evaluate(OVERFLOW_JS)
        if over > 1:
            problems.append(f"horizontal overflow {over}px")
        strip = page.locator('[role="tablist"]')
        if strip.count():
            box = strip.first.bounding_box()
            if box and box["x"] + box["width"] > 391:
                problems.append(f"tab strip wider than viewport ({box['x'] + box['width']:.0f}px)")


def check_tab(page: Page, problems: list[str], tab: str) -> None:
    selected = page.locator(f'[role="tab"][data-tab-id="{tab}"][aria-selected="true"]')
    if selected.count() != 1:
        problems.append(f"tab {tab} not selected")
    panel = page.locator(f'[role="tabpanel"][data-tab-panel="{tab}"]')
    if panel.count() != 1:
        problems.append(f"tab {tab} has no panel")
        return
    try:  # lazy tab components show "Loading tool" until their chunk arrives
        page.wait_for_function(
            """(id) => {
                const el = document.querySelector(`[role="tabpanel"][data-tab-panel="${id}"]`);
                return !!el && !el.innerText.includes("Loading tool");
            }""",
            arg=tab,
            timeout=15000,
        )
    except Exception:  # noqa: BLE001
        pass  # reported below with the panel text
    text = panel.inner_text()
    if not text.strip():
        problems.append(f"tab {tab} panel empty")
    if "no component yet" in text or "Loading tool" in text:
        problems.append(f"tab {tab} did not render: {text[:60]!r}")


def visit(
    ctx: BrowserContext, path: str, label: str, tag: str, mobile: bool, tab: str | None = None
) -> None:
    global loads
    loads += 1
    page = ctx.new_page()
    problems: list[str] = []
    watch(page, problems)
    try:
        resp = page.goto(f"{BASE}{path}", wait_until="networkidle", timeout=60000)
        if not resp or resp.status != 200:
            problems.append(f"http {resp.status if resp else 'none'}")
        check_page(page, problems, mobile)
        if tab:
            check_tab(page, problems, tab)
    except Exception as exc:  # noqa: BLE001
        problems.append(f"exception: {str(exc)[:160]}")
    failures.extend(f"[{label}] {tag}: {p}" for p in problems)
    page.close()


def check_alias(ctx: BrowserContext, old: str, suite: str, tab: str) -> None:
    global loads
    loads += 1
    page = ctx.new_page()
    problems: list[str] = []
    watch(page, problems)
    try:
        resp = page.goto(f"{BASE}/tools/{old}", wait_until="networkidle", timeout=60000)
        final = urlparse(page.url)
        if not resp or resp.status != 200:
            problems.append(f"final http {resp.status if resp else 'none'}")
        hop = resp.request.redirected_from if resp else None
        if hop is None:
            problems.append("no redirect happened")
        else:
            hop_resp = hop.response()
            if hop_resp is None or hop_resp.status != 308:
                problems.append(f"redirect status {hop_resp.status if hop_resp else 'none'}, expected 308")
        if final.path != f"/tools/{suite}":
            problems.append(f"landed on {final.path}, expected /tools/{suite}")
        if parse_qs(final.query).get("tab") != [tab]:
            problems.append(f"landed on query {final.query!r}, expected tab={tab}")
        check_tab(page, problems, tab)
    except Exception as exc:  # noqa: BLE001
        problems.append(f"exception: {str(exc)[:160]}")
    failures.extend(f"[alias] {old}: {p}" for p in problems)
    page.close()


def check_keyboard(ctx: BrowserContext, suite: str, tab_ids: list[str]) -> None:
    page = ctx.new_page()
    problems: list[str] = []
    watch(page, problems)

    def wait_for_tab(tab: str) -> None:
        page.wait_for_function(f'location.search.includes("tab={tab}")', timeout=5000)

    try:
        page.goto(f"{BASE}/tools/{suite}", wait_until="networkidle", timeout=60000)
        page.evaluate("window.__sk_marker = 1")
        page.locator(f'[role="tab"][data-tab-id="{tab_ids[0]}"]').focus()
        page.keyboard.press("ArrowRight")
        wait_for_tab(tab_ids[1])
        page.wait_for_load_state("networkidle")
        check_tab(page, problems, tab_ids[1])
        page.keyboard.press("End")
        wait_for_tab(tab_ids[-1])
        page.keyboard.press("Home")
        wait_for_tab(tab_ids[0])
        page.keyboard.press("ArrowLeft")
        wait_for_tab(tab_ids[-1])
        if page.locator('[role="tab"][tabindex="0"]').count() != 1:
            problems.append("roving tabindex broken")
        page.locator(f'[role="tab"][data-tab-id="{tab_ids[2]}"]').click()
        wait_for_tab(tab_ids[2])
        page.go_back()
        wait_for_tab(tab_ids[-1])
        if page.evaluate("window.__sk_marker") != 1:
            problems.append("page reloaded on tab change")
        page.goto(f"{BASE}/tools/{suite}?tab=does-not-exist", wait_until="networkidle")
        check_tab(page, problems, tab_ids[0])
    except Exception as exc:  # noqa: BLE001
        problems.append(f"exception: {str(exc)[:160]}")
    failures.extend(f"[keyboard] {suite}: {p}" for p in problems)
    page.close()


with sync_playwright() as p:
    browser = p.chromium.launch()
    for width, label in ((1280, "desktop"), (390, "mobile")):
        ctx = browser.new_context(viewport={"width": width, "height": 900})
        mobile = label == "mobile"
        for slug in listed:
            visit(ctx, f"/tools/{slug}", label, slug, mobile)
        for suite, tab_ids in suites.items():
            for tab in tab_ids:
                visit(ctx, f"/tools/{suite}?tab={tab}", label, f"{suite}?tab={tab}", mobile, tab)
        ctx.close()

    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    for old, (suite, tab) in sorted(aliases.items()):
        check_alias(ctx, old, suite, tab)
    check_keyboard(ctx, KEYBOARD_SUITE, suites[KEYBOARD_SUITE])
    page = ctx.new_page()
    resp = page.goto(f"{BASE}/tools/definitely-not-a-tool", wait_until="domcontentloaded")
    if not resp or resp.status != 404:
        failures.append(f"[404] unknown slug returned {resp.status if resp else 'none'}")
    page.close()
    ctx.close()
    browser.close()

collisions = sorted(set(aliases) & set(listed))
if collisions:
    failures.append(f"[registry] alias collides with listed slug: {collisions}")

tabs_total = sum(len(t) for t in suites.values())
print(
    f"{len(listed)} listed tools ({len(suites)} suites, {tabs_total} tabs), "
    f"{len(aliases)} aliases, {loads} page loads"
)
print("\n".join(failures) if failures else "ALL PASS")
sys.exit(1 if failures else 0)
