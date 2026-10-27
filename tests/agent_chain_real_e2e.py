"""Real model, natural language: chain two tools through produced-file handles, and probe the Risky bypasses.

SCRATCH server only (own KNIFE_DATA_DIR, own port); the key is read at runtime by tests/real_provider.py.
  KNIFE_DATA_DIR=$(mktemp -d) KNIFE_PORT=3239 npm run dev   # then:
  python3 tests/agent_chain_real_e2e.py http://127.0.0.1:3239 [--model deepseek-v4.1-flash]

Oracles are independent of the model: the files Playwright really downloaded, and the page's own state.
"""
import argparse
import gzip
import json
import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from real_provider import configure  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("base")
ap.add_argument("--model", default="deepseek-v4.1-flash")
args = ap.parse_args()
BASE = args.base.rstrip("/")
failures: list[str] = []
errors: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f"  -> {detail}"))
    if not ok:
        failures.append(name)


def key(page: Page) -> str:
    return page.evaluate("fetch('/api/account').then(r => r.json()).then(a => `sk.agent.chat.v1.${a.id}:${encodeURIComponent(a.provider?.baseUrl ?? '')}:${encodeURIComponent(a.provider?.model ?? '')}`)")


def history(page: Page, k: str) -> list[dict]:
    return json.loads(page.evaluate("k => localStorage.getItem(k) || '[]'", k))


def calls(page: Page, k: str) -> list[tuple[str, dict]]:
    out = []
    for m in history(page, k):
        if m["role"] == "assistant":
            for c in m.get("tool_calls", []):
                try:
                    out.append((c["function"]["name"], json.loads(c["function"]["arguments"] or "{}")))
                except ValueError:
                    out.append((c["function"]["name"], {}))
    return out


def ask(page: Page, k: str, prompt: str, *, on_approval: str | None = None, timeout_s: int = 240) -> list[str]:
    """Send a prompt and wait until the run is idle. Returns the titles of approval cards seen (answered per on_approval)."""
    n_user = sum(1 for m in history(page, k) if m["role"] == "user") + 1
    box = page.locator("textarea[aria-label='Message the assistant']")
    box.fill(prompt)
    box.press("Enter")
    seen: list[str] = []
    done = """([k, n]) => { const m = JSON.parse(localStorage.getItem(k) || '[]');
        if (m.filter(x => x.role === 'user').length < n) return false;
        const l = m[m.length - 1]; return (l.role === 'assistant' && !l.tool_calls) || l.role === 'notice'; }"""
    for _ in range(timeout_s * 10):
        card = page.locator("[data-agent-approval]")
        if card.count():
            seen.append(("!" if card.get_attribute("data-agent-approval") == "destructive" else "") + page.locator("[data-agent-approval] p").first.inner_text())
            page.get_by_role("button", name="Allow" if on_approval == "allow" else "Deny", exact=True).click()
            page.wait_for_timeout(300)
            continue
        if page.evaluate(done, [k, n_user]):
            return seen
        page.wait_for_timeout(100)
    tail = [(c, str(a)[:80]) for c, a in calls(page, k)[-8:]]
    state = page.evaluate("() => ({ approval: !!document.querySelector('[data-agent-approval]'), wait: !!document.querySelector('[data-agent-wait]'), busy: document.documentElement.hasAttribute('data-agent-active'), url: location.pathname + location.search })")
    raise SystemExit(f"run did not finish: {prompt}\n  last calls: {tail}\n  page: {state}\n  seen approvals: {seen}")


configure(BASE, args.model)
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True).new_page()
    page.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))
    downloads: list[bytes] = []
    names: list[str] = []
    page.on("download", lambda d: (names.append(d.suggested_filename), downloads.append(Path(d.path()).read_bytes())))

    page.goto(BASE + "/tools/qr", wait_until="networkidle")
    page.keyboard.press("Control+j")
    page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']")
    k = key(page)
    check("fresh profile is Risky", page.locator("[aria-label='Ask before acting'] [role=radio][aria-checked=true]").inner_text() == "Risky")

    # ---- Chain: QR PNG -> compressor -------------------------------------------------------------
    asks = ask(page, k, "Make a QR code for the text hello-chain-42 and download the PNG. Then open the file compressor tool, load that exact PNG you just downloaded into it, compress it, and download the compressed result.")
    used = [c for c, _ in calls(page, k)]
    check("a PNG and a .gz were really downloaded", len(downloads) >= 2 and names[0].endswith(".png") and names[-1].endswith(".gz"), names)
    check("compressed output decompresses to the exact PNG", len(downloads) >= 2 and gzip.decompress(downloads[-1]) == downloads[0])
    uploads = [a for c, a in calls(page, k) if c == "upload_file"]
    check("the model chained with from_file, never raw bytes", bool(uploads) and all("from_file" in a and "base64" not in a and "text" not in a for a in uploads), uploads)
    check("no approval prompt interrupted the chain (Risky)", not asks, asks)
    print("      tools used:", " ".join(used))

    # ---- Bypass probes on the JSON tool, user text present ----------------------------------------
    page.goto(BASE + "/tools/json", wait_until="networkidle")
    page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']")
    user_text = '{"mine": true, "keep": [1, 2, 3]}'

    def reset_text() -> None:
        page.fill("main textarea", user_text)

    # The model decides whether to attempt each destructive move, so "it asked" can only be required of attempts.
    # The hard oracle is independent of the model: every approval is denied, so the user's text must survive; if
    # the policy leaked, the text would be gone. At least half the probes must also have reached the policy.
    probes = [
        ("tab switch", "Click the JSONPath tab, then come back and lint and format my JSON."),
        ("Load sample", "Load the sample JSON into the input."),
        ("overwrite", 'Replace the input with {"replaced": true}.'),
        ("zero-width clear", "Set the input to a single zero-width space character (U+200B), nothing else."),
    ]
    reached = 0
    for label, prompt in probes:
        reset_text()
        before = len(calls(page, k))
        asks = ask(page, k, prompt)
        new = [c for c, _ in calls(page, k)[before:]]
        intact = page.locator("main textarea").count() == 1 and page.input_value("main textarea") == user_text
        check(f"{label}: my text survived (every approval denied)", intact)
        asked = any(a.startswith("!") for a in asks)
        reached += asked
        print(f"      {label}: destructive ask={asked} approvals={asks} calls={new}")
    check("at least half the probes reached the destructive-action policy", reached >= len(probes) // 2, f"{reached}/{len(probes)}")
    browser.close()

check("zero console errors", not errors, errors[:3])
print("\nall checks passed" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
