"""On-demand tool groups (real browser, scripted mock provider): the database tools are not re-sent on every round
of unrelated turns, are preloaded on their lab pages, and `load_tools` brings them in.

  node tests/mock_provider.mjs 3299
  KNIFE_DATA_DIR=$(mktemp -d) KNIFE_PORT=3239 npm run dev
  python3 tests/agent_toolgroups_e2e.py http://127.0.0.1:3239 http://127.0.0.1:3299

Oracles: the tool list in the request body the mock provider really received (GET /__last), and the mock's
deterministic usage (prompt tokens = request chars / 4) as the size measurement.
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


def last_tools() -> list[str]:
    body = json.loads(urllib.request.urlopen(MOCK + "/__last", timeout=10).read())
    request = body.get("body", body)
    return [t["function"]["name"] for t in request.get("tools", [])]


def last_system() -> str:
    body = json.loads(urllib.request.urlopen(MOCK + "/__last", timeout=10).read())
    messages = body.get("body", body).get("messages", [])
    return next((m["content"] for m in messages if m.get("role") == "system" and isinstance(m.get("content"), str)), "")


def history(page: Page, k: str) -> list[dict]:
    return json.loads(page.evaluate("k => localStorage.getItem(k) || '[]'", k))


def run(page: Page, k: str, text: str) -> dict:
    """Send a prompt, wait for the footer of that turn, return it."""
    n = sum(1 for m in history(page, k) if m["role"] == "user") + 1
    box = page.locator("textarea[aria-label='Message the assistant']")
    box.fill(text)
    box.press("Enter")
    page.wait_for_function(
        """([k, n]) => { const m = JSON.parse(localStorage.getItem(k) || '[]');
           if (m.filter(x => x.role === 'user').length < n) return false;
           const l = m[m.length - 1]; return l.role === 'notice' && l.level === 'usage'; }""",
        arg=[k, n], timeout=30_000)
    return history(page, k)[-1]


def tool_results(page: Page, k: str, name: str) -> list[dict]:
    ms = history(page, k)
    ids = {c["id"] for m in ms if m["role"] == "assistant" for c in m.get("tool_calls", []) if c["function"]["name"] == name}
    out = []
    for m in ms:
        if m["role"] == "tool" and m["tool_call_id"] in ids:
            try:
                out.append(json.loads(m["content"]))
            except ValueError:
                pass
    return out


def open_panel(page: Page, url: str) -> str:
    page.goto(BASE + url, wait_until="networkidle")
    page.keyboard.press("Control+j")
    page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']")
    return page.evaluate("fetch('/api/account').then(r => r.json()).then(a => `sk.agent.chat.v1.${a.id}:${encodeURIComponent(a.provider?.baseUrl ?? '')}:${encodeURIComponent(a.provider?.model ?? '')}`)")


put_provider()
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    page.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))

    # 1) ordinary page: no database tools, load_tools offered
    k = open_panel(page, "/tools/json")
    foot_json = run(page, k, "hello")
    tools_json = last_tools()
    check("ordinary page: no knife_sql_/mongo/chroma/redis tools in the request", not any(t.startswith(("knife_sql_", "knife_mongo_", "knife_chroma_", "knife_redis_")) for t in tools_json), [t for t in tools_json if t.startswith("knife_")])
    check("ordinary page: load_tools and the core knife tools are present", "load_tools" in tools_json and "knife_hash" in tools_json and "list_tools" in tools_json, tools_json)
    p_json = foot_json["usage"]["promptTokens"]
    system = last_system()
    # Coverage triage 2026-10-10: the rule used to read "never reveal, request, or type secrets", so the model refused to put the
    # password the user typed into the connection URL they asked for, and swapped a token for a placeholder.
    check("system prompt: a value the user wrote in their own message may be used and repeated, not replaced by a placeholder",
          "theirs to use" in system and "do not swap it for a placeholder or refuse" in system, system[-500:])
    check("system prompt: still never asks the user for secrets and never touches password fields",
          "never ask the user for API keys, passwords or tokens" in system and "never touch password fields" in system, system[-500:])

    # 2) the SQL lab preloads its group; the size difference is the saving
    k2 = open_panel(page, "/tools/sql-lab?tab=format")
    page.locator("button[aria-label='Clear conversation']").click()
    foot_sql = run(page, k2, "hello")
    tools_sql = last_tools()
    check("sql-lab: sql tools preloaded", "knife_sql_compile" in tools_sql and "knife_sql_check" in tools_sql, tools_sql)
    check("sql-lab: nosql tools still not sent", not any(t.startswith(("knife_mongo_", "knife_chroma_", "knife_redis_")) for t in tools_sql), tools_sql)
    p_sql = foot_sql["usage"]["promptTokens"]
    check("the preloaded request is much larger (>= 2000 prompt tokens) than the ordinary one", p_sql - p_json >= 2000, (p_json, p_sql))

    # 3) load_tools on an ordinary page, then the tool really runs, and the group stays loaded next turn
    k = open_panel(page, "/tools/json")
    page.locator("button[aria-label='Clear conversation']").click()
    run(page, k, 'CALL:load_tools:{"group":"sql"}')
    loaded = tool_results(page, k, "load_tools")
    check("load_tools reports the group's tools", bool(loaded) and loaded[-1].get("ok") is True and "knife_sql_compile" in loaded[-1].get("tools", []), loaded)
    check("after load_tools the next round sends the sql tools", "knife_sql_compile" in last_tools(), last_tools())
    run(page, k, 'CALL:knife_sql_validate:{"sql":"SELECT 1","dialect":"sqlite"}')
    res = tool_results(page, k, "knife_sql_validate")
    check("a loaded database tool actually runs (real engine)", bool(res), "no result")
    run(page, k, "hello again")
    check("the group stays loaded on the following turn", "knife_sql_compile" in last_tools(), last_tools())
    check("and nosql stays out", "knife_mongo_compile" not in last_tools(), last_tools())

    # 4) bad group
    run(page, k, 'CALL:load_tools:{"group":"nope"}')
    bad = tool_results(page, k, "load_tools")[-1]
    check("an unknown group is a clear error", bad.get("ok") is False and "Unknown group" in bad.get("error", ""), bad)
    browser.close()

check("zero console errors", not errors, errors[:3])
print("\nall checks passed" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
