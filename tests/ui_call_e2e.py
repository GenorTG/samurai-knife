"""An agent OUTSIDE the app runs the open page's live tools in the user's tab over MCP (`knife_ui_call`), against REAL
docker and the real Euro-Office editor: install the office sidecar, open a python-docx document, the plugin connects;
then only MCP calls (POST /api/mcp, no browser Origin, like an OpenClaw / Claude / Cursor client):

- knife_ui_state lists the tab with its liveTools and live line; list_tools returns the definitions;
- a read runs without asking (default trust mode Risky) and comes back inside the untrusted-content envelope;
- in Standard an edit shows the approval card in the tab (outside <main>, names the agent and the tool): Deny -> declined
  and the document is unchanged; Allow -> done and the text is in the editor;
- a destructive call is asked as destructive; an unanswered card -> timeout (picked up) and the card goes away;
- a tool the page does not offer (craft_*) and a non-live tool are refused without touching the tab;
- no visible tab (the page closed) -> no_tab; no page errors.

Isolation: own scratch worktree server on the Tailscale address (a container cannot reach the host loopback), own
KNIFE_DATA_DIR, port and compose project (KNIFE_SIDECAR_PREFIX=sk-call-<pid>); removes the sidecar at the end.

    KNIFE_SCRATCH_PORTS=3400-3499 python3 tests/ui_call_e2e.py --host <tailscale-or-LAN-ip> [--hold]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from office_e2e import Api, container_names  # noqa: E402
from office_live_e2e import MAKE_DOCX, live, open_doc, py_docx  # noqa: E402
from scratch_server import ROOT, ScratchServer  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []
SHOTS = ROOT / ".tmp" / "ui-call-e2e"
CARD = "[data-ui-call-approval]"


def check(name: str, ok: bool, detail: object = "") -> bool:
    text = detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False)[:600]
    RESULTS.append((name, ok, text))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{f' — {text}' if text and not ok else ''}", flush=True)
    return ok


def mcp(base: str, name: str, args: dict | None = None, timeout: float = 150) -> tuple[object, bool]:
    # No Origin header: MCP clients are not browsers (the route's host guard still applies).
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args or {}}}).encode()
    req = urllib.request.Request(base + "/api/mcp", data=body, method="POST", headers={"content-type": "application/json", "accept": "application/json, text/event-stream"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read().decode()
    result = json.loads(raw[raw.find("{"):])["result"]
    text = result["content"][0]["text"]
    try:
        return json.loads(text), result.get("isError", False)
    except ValueError:
        return text, result.get("isError", False)


class Background:
    """An MCP call that waits (for the user's answer in the tab) while the test drives the browser."""

    def __init__(self, base: str, name: str, args: dict) -> None:
        self.value: tuple[object, bool] | None = None
        self.error: Exception | None = None
        self.thread = threading.Thread(target=self._run, args=(base, name, args), daemon=True)
        self.thread.start()

    def _run(self, base: str, name: str, args: dict) -> None:
        try:
            self.value = mcp(base, name, args)
        except Exception as exc:  # noqa: BLE001 - reported by the check
            self.error = exc

    def result(self, timeout: float = 150) -> dict:
        self.thread.join(timeout)
        if self.error or not self.value:
            return {"error": str(self.error or "no answer")}
        out, err = self.value
        return out if isinstance(out, dict) and not err else {"error": out}


def doc_text(page) -> str:
    r = live(page, "get_structure")
    return "\n".join(i["text"] for i in r.get("data", {}).get("items", []))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("KNIFE_E2E_HOST") or os.environ.get("KNIFE_HOST"))
    parser.add_argument("--hold", action="store_true", help="before cleanup, keep everything up until Enter")
    args = parser.parse_args()

    SHOTS.mkdir(parents=True, exist_ok=True)
    prefix = f"sk-call-{os.getpid()}"
    project = f"{prefix}-office"
    server = ScratchServer(host=args.host)
    url = server.start(env={"KNIFE_SIDECAR_PREFIX": prefix}, overlay=["src", "sidecars"])
    api = Api(url)
    print(f"scratch server {url}, data dir {server.data_dir}, compose project {project}", flush=True)
    try:
        status, body = api.call("POST", "/api/services/office", {"action": "install"})
        op = api.wait_op(body["op"], timeout=3600)
        if not check("office sidecar installed", op["status"] == "done", op.get("error") or op["phase"]):
            return 1
        made = py_docx(MAKE_DOCX)
        status, body = api.call("POST", "/api/office/docs", {"action": "upload", "name": "Agent report.docx", "data": made["b64"]})
        check("document uploaded", status == 201, str(status))
        doc = body["doc"]

        # ------------------------------------------------------------------ nothing open yet
        out, err = mcp(url, "knife_ui_call", {"tool": "doc_live_read", "args": {"what": "text"}})
        check("no tab open: no_tab, nothing waits", not err and out["called"] is False and out["reason"] == "no_tab", out)
        out, err = mcp(url, "knife_ui_call", {"tool": "click", "args": {"id": "x"}})
        check("a non-live tool is refused (error, never sent to a tab)", err and "not a live tool" in str(out), out)

        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1500, "height": 1000})
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)[:200]))

            ready, state = open_doc(page, url, doc["id"])
            check("the document opens and the plugin connects", ready.startswith("Editor ready") and "connected (word" in state, f"{ready} | {state}")

            # -------------------------------------------------------------- discovery
            deadline = time.time() + 20
            tab = {}
            while time.time() < deadline:
                st, _ = mcp(url, "knife_ui_state")
                tab = next((t for t in st["tabs"] if "doc_live_read" in t.get("liveTools", [])), {})
                if tab:
                    break
                time.sleep(0.5)
            check("knife_ui_state: the tab lists its liveTools and live line", bool(tab) and tab["visible"] and tab["connected"] and "CONNECTED" in tab.get("live", "") and "doc_live_insert_text" in tab["liveTools"], tab or st)
            out, err = mcp(url, "knife_ui_call", {"tool": "list_tools"})
            listed = out.get("result", "") if isinstance(out, dict) else ""
            check("list_tools: definitions of the page's live tools, enveloped", not err and out["ok"] and '"doc_live_insert_text"' in listed and "<<<UNTRUSTED_CONTENT" in listed and '"craft_' not in listed, out)

            # -------------------------------------------------------------- read: no question in Risky (the default)
            out, err = mcp(url, "knife_ui_call", {"tool": "doc_live_read", "args": {"what": "text"}})
            result = out.get("result", "") if isinstance(out, dict) else ""
            check("a read runs without asking and returns the live text inside the untrusted envelope", not err and out["called"] and out["ok"] and "Quarterly report" in result and result.startswith("<<<UNTRUSTED_CONTENT"), out)
            check("no approval card for a read", page.locator(CARD).count() == 0)

            # -------------------------------------------------------------- refusals that never reach the tab
            out, _ = mcp(url, "knife_ui_call", {"tool": "craft_inspect"})
            check("a tool the page does not offer: not_offered with what it does offer", out["called"] is False and out["reason"] == "not_offered" and "doc_live_read" in out.get("liveTools", []), out)

            # -------------------------------------------------------------- Standard: an edit is asked
            page.evaluate("localStorage.setItem('sk.agent.mode.v1', 'standard')")
            ready, state = open_doc(page, url, doc["id"])
            check("reopened in Standard", "connected (word" in state, state)
            time.sleep(2)  # presence re-reports the live tools once the plugin connected

            call = Background(url, "knife_ui_call", {"tool": "doc_live_insert_text", "args": {"text": "Denied line from MCP."}})
            page.locator(CARD).wait_for(timeout=20_000)
            card_text = page.locator(CARD).inner_text()
            check("Standard: the edit shows an approval card naming the agent, the tool and the document", "MCP agent" in card_text and "doc_live_insert_text" in card_text and "Agent report" in card_text, card_text)
            check("the card is outside <main> (never in a page snapshot)", page.locator(f"main {CARD}").count() == 0)
            shown = page.locator(f"{CARD} [data-ui-call-args]")
            check("the card shows the call's arguments (what would be typed)", shown.count() == 1 and "Denied line from MCP." in shown.inner_text(), shown.count())
            page.screenshot(path=str(SHOTS / "approval-card.png"))
            page.locator(CARD).get_by_role("button", name="Deny", exact=True).click()
            out = call.result()
            check("Deny -> declined, the agent is told not to retry", out.get("reason") == "declined" and "Do not retry" in out.get("note", ""), out)
            check("declined: the document is unchanged", "Denied line from MCP." not in doc_text(page))

            call = Background(url, "knife_ui_call", {"tool": "doc_live_insert_text", "args": {"text": "Allowed line from MCP."}})
            page.locator(CARD).wait_for(timeout=20_000)
            page.locator(CARD).get_by_role("button", name="Allow", exact=True).click()
            out = call.result()
            check("Allow -> done ok", out.get("called") is True and out.get("ok") is True, out)
            check("the allowed text is in the open document", "Allowed line from MCP." in doc_text(page))
            check("the card is gone after answering", page.locator(CARD).count() == 0)

            # -------------------------------------------------------------- destructive: asked as such
            idx = doc_text(page).split("\n").index("Obsolete paragraph to delete.")
            call = Background(url, "knife_ui_call", {"tool": "doc_live_delete", "args": {"from": idx, "to": idx}})
            page.locator(CARD).wait_for(timeout=20_000)
            kind = page.locator(CARD).get_attribute("data-ui-call-approval")
            check("a delete is asked as destructive", kind == "destructive", kind)
            page.locator(CARD).get_by_role("button", name="Deny", exact=True).click()
            out = call.result()
            check("destructive denied: paragraph still there", out.get("reason") == "declined" and "Obsolete paragraph to delete." in doc_text(page), out)

            # -------------------------------------------------------------- unanswered: timeout, card dropped
            started = time.time()
            out, _ = mcp(url, "knife_ui_call", {"tool": "doc_live_insert_text", "args": {"text": "Never answered."}, "timeoutSeconds": 5})
            took = time.time() - started
            check("an unanswered card -> timeout (picked up) after ~5 s", out.get("reason") == "timeout" and "approval" in out.get("note", "") and 4 <= took <= 12, f"{out} in {took:.1f}s")
            page.wait_for_timeout(1500)
            check("the expired card is gone and nothing was typed", page.locator(CARD).count() == 0 and "Never answered." not in doc_text(page))

            check("no page errors", not errors, errors)
            page.close()
            time.sleep(6.5)  # the closed tab stops polling: no longer listening
            out, _ = mcp(url, "knife_ui_call", {"tool": "doc_live_read"})
            check("the tab closed: no_tab", out.get("called") is False and out.get("reason") == "no_tab", out)
            browser.close()
    finally:
        if args.hold:
            input(f"--hold: server {url}, data {server.data_dir}; press Enter to clean up ")
        _, body = api.call("POST", "/api/services/office", {"action": "remove", "purge": True})
        if isinstance(body, dict) and "op" in body:
            op = api.wait_op(body["op"], timeout=300)
            check("remove (purge) op done", op["status"] == "done", op.get("error", ""))
        check("no container of the e2e project left", not container_names(project), container_names(project))
        server.stop()
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed; screenshots in {SHOTS}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
