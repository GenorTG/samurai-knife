"""Token telemetry end to end (real browser, scripted mock provider that reports deterministic usage).

  node tests/mock_provider.mjs 3299
  KNIFE_DATA_DIR=$(mktemp -d) KNIFE_PORT=3238 npm run dev
  python3 tests/agent_usage_e2e.py http://127.0.0.1:3238 http://127.0.0.1:3299

Oracles: the per-turn footers the browser keeps in the chat store vs the server-side ledger delta from
GET /api/account/usage (two independent paths for the same numbers), the estimated-usage flag when the provider
reports nothing, the stream_options fallback, and the Settings usage table vs the API.
"""
import json
import sys
import urllib.request

from playwright.sync_api import Page, sync_playwright

BASE, MOCK = sys.argv[1].rstrip("/"), sys.argv[2].rstrip("/")
failures: list[str] = []
errors: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f"  -> {detail}"))
    if not ok:
        failures.append(name)


def put_provider() -> None:
    body = {"baseUrl": f"{MOCK}/v1", "model": "mock-model", "apiKey": "mock-key"}
    req = urllib.request.Request(BASE + "/api/account/provider", data=json.dumps(body).encode(), method="PUT",
                                 headers={"content-type": "application/json", "Origin": BASE})
    urllib.request.urlopen(req, timeout=30).read()


def key(page: Page) -> str:
    return page.evaluate("fetch('/api/account').then(r => r.json()).then(a => `sk.agent.chat.v1.${a.id}:${encodeURIComponent(a.provider?.baseUrl ?? '')}:${encodeURIComponent(a.provider?.model ?? '')}`)")


def history(page: Page, k: str) -> list[dict]:
    return json.loads(page.evaluate("k => localStorage.getItem(k) || '[]'", k))


def ledger(page: Page) -> dict:
    return page.evaluate("fetch('/api/account/usage').then(r => r.json())")


def run(page: Page, k: str, text: str) -> dict | None:
    """Send a prompt, wait for the run to end; return the usage footer (notice) of that turn, if any."""
    n_user = sum(1 for m in history(page, k) if m["role"] == "user") + 1
    box = page.locator("textarea[aria-label='Message the assistant']")
    box.fill(text)
    box.press("Enter")
    page.wait_for_function(
        """([k, n]) => { const m = JSON.parse(localStorage.getItem(k) || '[]');
           if (m.filter(x => x.role === 'user').length < n) return false;
           const l = m[m.length - 1]; return l.role === 'notice' && l.level === 'usage' || (l.role === 'assistant' && !l.tool_calls && false); }""",
        arg=[k, n_user], timeout=30_000)
    ms = history(page, k)
    return next((m for m in reversed(ms) if m["role"] == "notice" and m.get("level") == "usage"), None)


put_provider()
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
    page.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))
    page.goto(BASE + "/tools/json", wait_until="networkidle")
    page.keyboard.press("Control+j")
    page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']")
    k = key(page)
    before = ledger(page)
    # Deltas, not absolutes: other suites may already have used this data dir.
    base = before["total"]

    # 1) one plain round
    foot1 = run(page, k, "hello usage")
    u1 = (foot1 or {}).get("usage") or {}
    check("a footer notice with usage was stored", bool(foot1) and u1.get("rounds") == 1 and u1.get("promptTokens", 0) > 0 and u1.get("completionTokens", 0) > 0, foot1)
    check("provider-reported cache share arrives (mock caches 40%)", u1.get("promptTokens") and 0.35 <= u1["cachedTokens"] / u1["promptTokens"] <= 0.45, u1)
    check("not flagged as estimated", not u1.get("estimated"), u1)
    check("footer is rendered under the answer", page.locator("[data-agent-usage]").count() == 1 and "1 round" in page.locator("[data-agent-usage]").first.inner_text(), page.locator("[data-agent-usage]").all_inner_texts())
    check("header shows the conversation token total", "tokens" in page.locator("[role=dialog][aria-label='Toolbox assistant'] header p").first.inner_text(), page.locator("header p").all_inner_texts())

    # 2) two rounds (tool call, then answer)
    foot2 = run(page, k, "CALL:page_snapshot:{}")
    u2 = (foot2 or {}).get("usage") or {}
    check("a tool round makes two model rounds in one footer", u2.get("rounds") == 2, u2)

    # 3) ledger == sum of the footers (independent paths)
    after = ledger(page)
    want_in = u1["promptTokens"] + u2["promptTokens"]
    want_out = u1["completionTokens"] + u2["completionTokens"]
    delta = lambda f: after["total"][f] - base[f]  # noqa: E731
    check("ledger requests == rounds seen by the browser", delta("requests") == 3, delta("requests"))
    check("ledger prompt tokens == sum of browser footers", delta("promptTokens") == want_in, (delta("promptTokens"), want_in))
    check("ledger completion tokens == sum of browser footers", delta("completionTokens") == want_out, (delta("completionTokens"), want_out))
    check("ledger cached tokens recorded", delta("cachedTokens") > 0, after["total"])
    check("ledger today bucket never exceeds total", after["today"]["requests"] <= after["total"]["requests"], after["today"])
    check("per-model rows exist", any(m["model"] == "mock-model" for m in after["models"]), after["models"])

    # 4) provider reports nothing -> estimated and flagged
    foot3 = run(page, k, "NOUSAGE please")
    u3 = (foot3 or {}).get("usage") or {}
    check("missing usage is estimated and flagged", u3.get("estimated") is True and u3.get("promptTokens", 0) > 0, u3)
    check("estimated footer shows a tilde", "~" in (foot3 or {}).get("content", ""), (foot3 or {}).get("content"))

    # 5) provider rejects stream_options -> transparent retry, run still works (usage then estimated)
    foot4 = run(page, k, "REJECT_STREAM_OPTIONS please")
    check("the run survives a provider that rejects stream_options", bool(foot4) and (foot4.get("usage") or {}).get("rounds") == 1, foot4)
    last = [m for m in history(page, k) if m["role"] == "assistant" and not m.get("tool_calls")][-1]
    check("and the answer arrived", "REJECT_STREAM_OPTIONS" in (last.get("content") or ""), last)

    # 6) settings table matches the API
    page.get_by_role("button", name="Settings").click()
    page.locator("summary", has_text="Token usage").click()
    page.wait_for_selector("section[aria-label='Token usage'] table")
    api = ledger(page)
    cells = page.locator("section[aria-label='Token usage'] tbody tr").first.inner_text().split()
    check("settings table shows today's round count from the ledger", str(api["today"]["requests"]) in cells, (cells, api["today"]))
    check("settings explains estimates and privacy", "never stored" in page.locator("section[aria-label='Token usage']").inner_text())
    browser.close()

check("zero console errors", not errors, errors[:3])
print("\nall checks passed" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
