#!/usr/bin/env python3
"""Attack probe against a PRODUCTION build in public mode (the deployment shape), replaying the 2026-10-17 audit's
attacks end to end over HTTP. Run it against a server YOU started from a build with its own fresh data dir (never the
live one), the way tests/prod_smoke.py documents:

  npm run build
  KNIFE_AUTH_MODE=public KNIFE_DATA_DIR=$(mktemp -d) KNIFE_HOST=127.0.0.1 KNIFE_PORT=<port> KNIFE_MAIL_TRANSPORT=outbox \
    KNIFE_PUBLIC_URL=http://127.0.0.1:<port> KNIFE_TRUSTED_PROXIES=127.0.0.1/32 KNIFE_EMAIL_DNS=off npm run start
  KNIFE_DATA_DIR=<same> python3 tests/security_probe.py http://127.0.0.1:<port>

Covers: guests reach no tool, account or API (pages redirect to /login, APIs answer 401/403); the Origin guard; the open
redirect shapes (`/\\t/evil.com`) on /login and the GitHub start route; cross-account isolation over MCP (CV offers,
office documents, UI bridge, Craft files kept by craft_file_save and read over MCP); the JSON Schema ReDoS and a crafted XLSX are stopped while the server keeps answering;
login brute force is limited; security headers; path tricks on document ids. Exit 1 on any failure.
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.functional.accounts_public_e2e import Api, Outbox  # noqa: E402

BASE = sys.argv[1].rstrip("/")
DATA = Path(os.environ.get("KNIFE_DATA_DIR", ""))
FAILS: list[str] = []
PASSES = 0


def check(name: str, ok: bool, detail: object = "") -> bool:
    global PASSES
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  -> ' + str(detail)[:500]}", flush=True)
    if ok:
        PASSES += 1
    else:
        FAILS.append(name)
    return ok


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: ANN002, ANN003
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def raw(method: str, path: str, body: bytes | None = None, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], str]:
    req = urllib.request.Request(BASE + path, data=body, method=method, headers=headers or {})
    try:
        with OPENER.open(req, timeout=60) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read().decode(errors="replace")
    except urllib.error.HTTPError as err:
        return err.code, {k.lower(): v for k, v in err.headers.items()}, err.read().decode(errors="replace")


def basic(user: str, key: str) -> dict[str, str]:
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{key}".encode()).decode()}


def mcp(api: Api, name: str, args: dict, headers: dict[str, str], ip: str) -> tuple[bool, str, float]:
    started = time.monotonic()
    status, body, _ = api.call("POST", "/api/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}},
                               ip=ip, headers={"Accept": "application/json, text/event-stream", **headers})
    took = time.monotonic() - started
    if isinstance(body, str):
        data = [line[6:] for line in body.split("\n") if line.startswith("data: ")]
        body = json.loads(data[0]) if data else body
    if status != 200 or not isinstance(body, dict):
        return False, f"HTTP {status}: {body}", took
    if "error" in body:
        return False, json.dumps(body["error"]), took
    result = body.get("result", {})
    return not result.get("isError", False), "".join(p.get("text", "") for p in result.get("content", [])), took


def register(api: Api, box: Outbox, name: str, ip: str) -> str:
    api.call("POST", "/api/account/register", {"username": name, "email": f"{name}@example.org", "password": f"{name} password 1"}, ip=ip)
    mails = box.wait(f"{name}@example.org", 1)
    token = Outbox.token(Outbox.link(mails[0][2], "/verify")) if mails else ""
    api.call("POST", "/api/account/verify", {"token": token}, ip=ip)
    status, _, cookie = api.login(name, f"{name} password 1", ip)
    check(f"{name}: registered, verified, logged in", status == 200 and bool(cookie), status)
    return cookie or ""


def mcp_key(api: Api, cookie: str, ip: str) -> str:
    status, body, _ = api.call("POST", "/api/account/mcp-keys", {"action": "create", "name": "probe"}, cookie=cookie, ip=ip)
    return body.get("key", "") if status == 201 and isinstance(body, dict) else ""


def xlsx_bomb(rows: int = 20_000) -> bytes:
    """The audit's crafted sheet: every cell claims column ZZZ (a 7 KB file that used to build a 365 MB string)."""
    sheet = '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    sheet += "".join(f'<row r="{i}"><c r="ZZZ{i}" t="inlineStr"><is><t>x</t></is></c></row>' for i in range(1, rows + 1))
    sheet += '<row r="1"><c r="XFDZZZZ1" t="inlineStr"><is><t>y</t></is></c></row></sheetData></worksheet>'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                   '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr("xl/workbook.xml", '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr("xl/worksheets/sheet1.xml", sheet)
    return buf.getvalue()


def responsive_during(action, label: str) -> None:  # noqa: ANN001
    """Runs `action` in a thread while timing GET /api/system/version every 100 ms: the event loop must keep answering."""
    worst = [0.0]
    done = threading.Event()
    result: list[object] = []

    def run() -> None:
        result.append(action())
        done.set()

    threading.Thread(target=run, daemon=True).start()
    while not done.wait(0.1):
        t = time.monotonic()
        raw("GET", "/api/system/version")
        worst[0] = max(worst[0], time.monotonic() - t)
    check(f"{label}: the server kept answering (worst /api/system/version {worst[0]*1000:.0f} ms)", worst[0] < 1.0, worst[0])
    return result[0]


def main() -> int:
    api = Api(BASE)
    box = Outbox(DATA)

    # --------------------------------------------------------------------------------------------- guests
    for path in ("/tools/json", "/tools/cv-studio", "/tools/pdf?tab=tools", "/account", "/account/admin"):
        status, hdrs, _ = raw("GET", path)
        check(f"guest GET {path} -> redirect to /login?next=", status in (302, 303, 307, 308) and "/login?next=" in hdrs.get("location", ""), (status, hdrs.get("location")))
    status, _, html = raw("GET", "/")
    check("guest home is the welcome page, no tool list", status == 200 and "in one sharp place" in html and "data-launcher-search" not in html)
    for method, path, body in (
        ("GET", "/api/account", None), ("GET", "/api/cv", None), ("GET", "/api/office/docs", None), ("GET", "/api/workspace?tool=json", None),
        ("GET", "/api/system/queue", None), ("GET", "/api/admin/users", None), ("GET", "/api/admin/security", None), ("GET", "/api/agent/tools", None),
        ("POST", "/api/agent/tool", {"name": "knife_cv_get", "input": {}}), ("POST", "/api/agent/chat", {"messages": []}),
        ("POST", "/api/sql", {"action": "format", "sql": "select 1"}), ("POST", "/api/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
        ("GET", "/api/ui/poll?client=AAAAAAAAAAAAAAAA", None), ("GET", "/api/learn", None),
        ("POST", "/api/ui/call", {"clientId": "AAAAAAAAAAAAAAAA", "callId": "00000000-0000-4000-8000-000000000000", "status": "done", "ok": True, "content": "x"}),
        ("GET", "/api/craft/files", None),
        ("GET", "/api/workflows", None), ("GET", "/api/workflows/credentials", None), ("GET", "/api/workflows/oauth/start?credential=abcdefabcdef", None),
        ("POST", "/api/workflows", {"action": "create", "name": "x"}),
    ):
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json", "Origin": BASE, "Accept": "application/json, text/event-stream"} if data else {}
        status, _, text = raw(method, path, data, headers)
        check(f"guest {method} {path} -> 401/403/404 (never data)", status in (401, 403, 404, 405), (status, text[:200]))

    # --------------------------------------------------------------------------------------------- origin + redirects
    status, _, _ = raw("POST", "/api/account/login", json.dumps({"id": "x", "password": "y"}).encode(),
                       {"Content-Type": "application/json", "Origin": "https://evil.example"})
    check("cross-origin POST is refused by the Origin guard", status == 403, status)
    status, _, html = raw("GET", "/login?next=%2F%09%2Fevil.example")
    # Next's router payload echoes the request's query string; what matters is the form's `next`, which must be dropped.
    import re
    leaked = re.findall(r'next\\?"\s*:\s*\\?"[^"\\]*evil', html) + re.findall(r'href="[^"]*evil', html)
    check("open redirect /\\t/evil on /login is dropped server-side (the form gets no next)", status == 200 and not leaked, leaked[:3])
    for rt in ("%2F%09%2Fevil.example", "%2F%5Cevil.example", "%2F%2Fevil.example", "https%3A%2F%2Fevil.example"):
        status, hdrs, _ = raw("GET", f"/api/github/start?purpose=login&returnTo={rt}")
        check(f"GitHub start never redirects off-site (returnTo={rt})", "evil.example" not in hdrs.get("location", ""), (status, hdrs.get("location")))

    # --------------------------------------------------------------------------------------------- headers
    status, hdrs, _ = raw("GET", "/login")
    check("security headers: CSP with frame-ancestors, nosniff, X-Frame-Options",
          "frame-ancestors" in hdrs.get("content-security-policy", "") and hdrs.get("x-content-type-options") == "nosniff" and bool(hdrs.get("x-frame-options")))
    check("no X-Powered-By", "x-powered-by" not in hdrs)

    # --------------------------------------------------------------------------------------------- two accounts
    alice = register(api, box, "alice", "198.51.100.10")
    bob = register(api, box, "bob", "198.51.100.20")
    ka, kb = mcp_key(api, alice, "198.51.100.10"), mcp_key(api, bob, "198.51.100.20")
    check("MCP keys created for both", bool(ka) and bool(kb))
    ha, hb = basic("alice", ka), basic("bob", kb)
    status, _, _ = raw("POST", "/api/mcp", json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).encode(),
                       {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", **basic("bob", ka)})
    check("alice's MCP key with bob's username -> refused", status == 401, status)

    ok, text, _ = mcp(api, "knife_cv_job_save", {"title": "Secret role at Acme", "company": "AcmeAliceOnly", "text": "alice private offer"}, ha, "198.51.100.10")
    check("alice saves a job offer", ok, text[:200])
    ok, text, _ = mcp(api, "knife_cv_job_list", {}, hb, "198.51.100.20")
    check("bob's job list never shows alice's offer", ok and "AcmeAliceOnly" not in text, text[:200])
    ok, text, _ = mcp(api, "knife_doc_create", {"format": "docx", "name": "alice-private", "paragraphs": ["alice secret paragraph"]}, ha, "198.51.100.10")
    doc_id = ""
    try:
        doc_id = json.loads(text).get("id", "") if ok else ""
    except ValueError:
        import re
        m = re.search(r'"?id"?\s*[:=]\s*"?([a-f0-9]{8,40})', text)
        doc_id = m.group(1) if m else ""
    check("alice creates a document", ok and bool(doc_id), text[:200])
    if doc_id:
        ok, text, _ = mcp(api, "knife_doc_read", {"id": doc_id}, hb, "198.51.100.20")
        check("bob cannot read alice's document by id", (not ok) and "alice secret paragraph" not in text, text[:200])
        ok, text, _ = mcp(api, "knife_doc_read", {"id": doc_id}, ha, "198.51.100.10")
        check("alice reads her own document", ok and "alice secret paragraph" in text, text[:200])
    for evil in ("../accounts", "..%2f..%2faccounts.json", "%2e%2e"):
        status, _, text = raw("GET", f"/api/office/docs/{evil}", None, {"Cookie": bob})
        # Next normalises dot segments with a same-site 308; anything else must be a plain refusal.
        same_site = status == 308
        check(f"document id path trick {evil!r} -> no data", (status in (400, 404) or same_site) and "passwordHash" not in text, (status, text[:120]))

    # The Python lane runs under the public-mode parser sandbox (bubblewrap): a real job must still work.
    ok, text, took = mcp(api, "knife_sql_format", {"sql": "select a,b from t where x=1", "dialect": "postgres"}, ha, "198.51.100.10")
    check(f"Python lane works under the public-mode sandbox (knife_sql_format, {took:.1f} s)", ok and "SELECT" in text.upper(), text[:200])

    # --------------------------------------------------------------------------------------------- knife_ui_call
    # alice's tab reports a live tool and polls; bob's agent never reaches it, bob cannot answer alice's call
    tab_a = "aliceTab00000001"
    api.call("POST", "/api/ui/presence", {"clientId": tab_a, "path": "/tools/office", "title": "x", "visible": True, "active": True, "tools": ["doc_live_read"]}, cookie=alice, ip="198.51.100.10")
    api.call("GET", f"/api/ui/poll?client={tab_a}", cookie=alice, ip="198.51.100.10")
    ok, text, _ = mcp(api, "knife_ui_call", {"tool": "doc_live_read"}, hb, "198.51.100.20")
    check("bob's agent sees no tab of alice's (knife_ui_call -> no_tab)", ok and '"no_tab"' in text, text[:200])
    waited: list[tuple[bool, str, float]] = []
    caller = threading.Thread(target=lambda: waited.append(mcp(api, "knife_ui_call", {"tool": "doc_live_read", "timeoutSeconds": 15}, ha, "198.51.100.10")))
    caller.start()
    call_id = ""
    for _ in range(40):
        status, body, _ = api.call("GET", f"/api/ui/poll?client={tab_a}", cookie=alice, ip="198.51.100.10")
        call_id = next((e["callId"] for e in (body.get("events", []) if isinstance(body, dict) else []) if e.get("kind") == "call"), "")
        if call_id:
            break
        time.sleep(0.25)
    check("alice's tab gets alice's call in its poll", bool(call_id))
    answer = {"clientId": tab_a, "callId": call_id or "00000000-0000-4000-8000-000000000000", "status": "done", "ok": True, "content": "{\"text\":\"forged by bob\"}"}
    status, body, _ = api.call("POST", "/api/ui/call", answer, cookie=bob, ip="198.51.100.20")
    check("bob cannot answer alice's call (accepted, ignored)", status == 200 and isinstance(body, dict) and body.get("taken") is False, (status, body))
    status, body, _ = api.call("POST", "/api/ui/call", {**answer, "content": "{\"text\":\"alice answer\"}"}, cookie=alice, ip="198.51.100.10")
    check("alice's tab answers its own call", status == 200 and isinstance(body, dict) and body.get("taken") is True, (status, body))
    caller.join(30)
    ok, text, _ = waited[0] if waited else (False, "no answer", 0)
    check("alice's agent gets her tab's answer, enveloped, never bob's", ok and "alice answer" in text and "forged by bob" not in text and "UNTRUSTED_CONTENT" in text, text[:300])
    status, _, _ = raw("POST", "/api/ui/call", json.dumps(answer).encode(), {"Content-Type": "application/json", "Origin": "https://evil.example", "Cookie": alice})
    check("a cross-origin call answer is refused by the Origin guard", status == 403, status)

    # --------------------------------------------------------------------------------------------- Craft files (craft_file_save + MCP reads)
    # What a tab's craft_file_save posts: alice's own session, never overwriting unless asked; bob's agent reads none of it.
    save = {"action": "save", "app": "vectorcraft", "name": "alice-craft.txt", "mime": "text/plain", "data": base64.b64encode(b"alice craft secret").decode(), "replace": False}
    status, body, _ = api.call("POST", "/api/craft/files", save, cookie=alice, ip="198.51.100.10")
    craft_id = body.get("file", {}).get("id", "") if isinstance(body, dict) else ""
    check("alice keeps a file in her Craft files (replace:false, new)", status == 201 and bool(craft_id), (status, body))
    status, body, _ = api.call("POST", "/api/craft/files", {**save, "data": base64.b64encode(b"overwritten").decode()}, cookie=alice, ip="198.51.100.10")
    check("replace:false never overwrites (409 file_exists)", status == 409 and isinstance(body, dict) and body.get("code") == "file_exists", (status, body))
    status, _, _ = raw("POST", "/api/craft/files", json.dumps(save).encode(), {"Content-Type": "application/json", "Origin": "https://evil.example", "Cookie": alice})
    check("a cross-origin Craft file save is refused by the Origin guard", status == 403, status)
    status, _, _ = raw("POST", "/api/craft/files", json.dumps(save).encode(), {"Content-Type": "application/json", "Origin": BASE})
    check("a guest cannot save a Craft file", status in (401, 403), status)
    ok, text, _ = mcp(api, "knife_craft_files", {}, hb, "198.51.100.20")
    check("bob's knife_craft_files never lists alice's file", ok and "alice-craft" not in text and '"total":0' in text.replace(" ", ""), text[:200])
    if craft_id:
        ok, text, _ = mcp(api, "knife_craft_file_read", {"id": craft_id}, hb, "198.51.100.20")
        check("bob cannot read alice's Craft file by id", (not ok) and "alice craft secret" not in text and "Unknown file" in text, text[:200])
        ok, text, _ = mcp(api, "knife_craft_file_read", {"id": craft_id}, ha, "198.51.100.10")
        check("alice reads her own Craft file, enveloped, unchanged by the refused overwrite", ok and "alice craft secret" in text and "overwritten" not in text and "UNTRUSTED_CONTENT" in text, text[:300])
    ok, text, _ = mcp(api, "knife_craft_file_read", {"id": "../../accounts"}, ha, "198.51.100.10")
    check("a path as a Craft file id is refused", not ok and "accounts" not in text.replace("../../accounts", ""), text[:200])

    # --------------------------------------------------------------------------------------------- workflows
    status, hdrs, text = raw("POST", "/api/hooks/" + "A" * 24 + "/x", b"{}", {"Content-Type": "application/json"})
    check("guest webhook call with an unknown token -> 404, sandboxed answer", status == 404 and hdrs.get("content-security-policy", "").startswith("sandbox"), (status, text[:120]))

    def node(name: str, kind: str, parameters: dict, **extra: object) -> dict:
        return {"id": name.replace(" ", ""), "type": f"core.{kind}", "name": name, "position": [0, 0], "parameters": parameters, **extra}

    def link(a: str, b: str) -> dict:
        return {"from": {"node": a, "output": 0}, "to": {"node": b, "input": 0}}

    status, body, _ = api.call("POST", "/api/workflows", {"action": "create", "name": "alice hook", "nodes": [
        node("Hook", "webhook", {"httpMethod": "POST", "path": "page", "responseMode": "responseNode"}),
        node("Reply", "respond-to-webhook", {"respondWith": "text", "responseText": "<script>alert(document.cookie)</script>", "headers": [{"name": "Content-Type", "value": "text/html"}, {"name": "Set-Cookie", "value": "sk=1"}]}),
    ], "connections": [link("Hook", "Reply")]}, cookie=alice, ip="198.51.100.10")
    wf = body.get("workflow", {}) if isinstance(body, dict) else {}
    check("alice creates a workflow", status == 201 and bool(wf.get("id")), (status, str(body)[:200]))
    if wf.get("id"):
        status, body, _ = api.call("PUT", f"/api/workflows/{wf['id']}", {"version": wf["version"], "active": True}, cookie=alice, ip="198.51.100.10")
        check("alice activates it", status == 200, (status, str(body)[:200]))
        status, hdrs, text = raw("POST", f"/api/hooks/{wf['hookToken']}/page", b"{}", {"Content-Type": "application/json", "Cookie": alice})
        check("a non-admin's webhook page is served as text/plain under CSP sandbox, no Set-Cookie",
              status == 200 and hdrs.get("content-type", "").startswith("text/plain") and hdrs.get("content-security-policy", "").startswith("sandbox") and "set-cookie" not in hdrs, (status, hdrs))
        for method, path, payload in (("GET", f"/api/workflows/{wf['id']}", None), ("PUT", f"/api/workflows/{wf['id']}", {"version": 2, "name": "pwned"}), ("POST", f"/api/workflows/{wf['id']}/run", {"wait": True}), ("DELETE", f"/api/workflows/{wf['id']}", None)):
            status, body, _ = api.call(method, path, payload, cookie=bob, ip="198.51.100.20")
            check(f"bob {method} alice's workflow -> 404", status == 404, (status, str(body)[:160]))
        status, body, _ = api.call("GET", "/api/workflows", cookie=bob, ip="198.51.100.20")
        check("bob's workflow list never shows alice's", status == 200 and "alice hook" not in json.dumps(body), str(body)[:200])
    status, body, _ = api.call("POST", "/api/workflows", {"action": "create", "name": "alice probes", "nodes": [
        node("Start", "manual-trigger", {}),
        node("Code", "code", {"jsCode": "return [{ host: [typeof process, typeof require, typeof fetch, typeof WebAssembly].join() }]"}),
        node("Local", "http-request", {"url": BASE + "/api/account"}),
    ], "connections": [link("Start", "Code"), link("Code", "Local")]}, cookie=alice, ip="198.51.100.10")
    probe_wf = body.get("workflow", {}) if isinstance(body, dict) else {}
    if probe_wf.get("id"):
        status, body, _ = api.call("POST", f"/api/workflows/{probe_wf['id']}/run", {"wait": True}, cookie=alice, ip="198.51.100.10")
        result = body if isinstance(body, dict) else {}
        check("a workflow's HTTP node cannot reach the app's own loopback address", status == 200 and result.get("status") == "error" and result.get("error", {}).get("node") == "Local" and "public address" in json.dumps(result.get("error")), str(body)[:300])
        status, body, _ = api.call("GET", f"/api/workflows/{probe_wf['id']}/runs", cookie=alice, ip="198.51.100.10")
        run_id = (body.get("runs") or [{}])[0].get("id", "") if isinstance(body, dict) else ""
        status, body, _ = api.call("GET", f"/api/workflows/{probe_wf['id']}/runs/{run_id}", cookie=alice, ip="198.51.100.10")
        host = (((body.get("run") or {}).get("runData") or {}).get("Code") or [{}])[0].get("outputs", [[{}]])[0][0].get("json", {}).get("host") if isinstance(body, dict) else None
        check("user code sees no process, require, fetch or WebAssembly", host == "undefined,undefined,undefined,undefined", host)

    # --------------------------------------------------------------------------------------------- CPU attacks
    def redos() -> tuple[bool, str, float]:
        return mcp(api, "knife_validate_json_schema", {"schema": json.dumps({"type": "string", "pattern": "^(a+)+$"}), "value": json.dumps("a" * 40 + "!")}, ha, "198.51.100.10")
    ok, text, took = responsive_during(redos, "JSON Schema ReDoS")
    check(f"JSON Schema ReDoS is stopped by the isolate timeout ({took:.1f} s: {text[:80]})", 1.0 < took < 6 and not ok and "Invalid arguments" not in text, (took, text[:200]))
    ok, text, _ = mcp(api, "knife_validate_json_schema", {"schema": json.dumps({"type": "string", "pattern": "^a+$"}), "value": json.dumps("aaa")}, ha, "198.51.100.10")
    check("an ordinary schema still validates after the attack (the pool recovered)", ok, text[:200])

    bomb = base64.b64encode(xlsx_bomb()).decode()
    status, body, _ = api.call("POST", "/api/office/docs", {"action": "upload", "name": "bomb.xlsx", "data": bomb}, cookie=alice, ip="198.51.100.10")
    bomb_id = ""
    if isinstance(body, dict):
        bomb_id = body.get("id") or (body.get("doc") or {}).get("id") or ""
    check("crafted XLSX upload accepted as a file (or refused cleanly)", status in (200, 201, 400, 413, 415, 422), (status, str(body)[:200]))
    if bomb_id:
        res = responsive_during(lambda: mcp(api, "knife_doc_read", {"id": bomb_id, "maxChars": 200000}, ha, "198.51.100.10"), "crafted XLSX read")
        ok, text, took = res
        check(f"crafted XLSX read is fast and bounded ({took:.2f} s, {len(text)} chars)", took < 5 and len(text) < 400_000, (took, len(text)))

    # --------------------------------------------------------------------------------------------- brute force
    statuses = []
    for i in range(80):
        status, _, _ = api.call("POST", "/api/account/login", {"id": "alice", "password": f"wrong {i}"}, ip="203.0.113.77")
        statuses.append(status)
        if status == 429:
            break
    check(f"login brute force from one address hits 429 (after {len(statuses)} tries)", 429 in statuses, statuses[-5:])
    # Rotating addresses inside one /64 (IPv6) must share the limits, not get fresh buckets each.
    statuses = []
    for i in range(80):
        status, _, _ = api.call("POST", "/api/account/login", {"id": "bob", "password": f"wrong {i}"}, ip=f"2001:db8:77:1::{i + 1:x}")
        statuses.append(status)
        if status == 429:
            break
    check(f"rotating IPv6 addresses in one /64 share the login limit (429 after {len(statuses)} tries)", 429 in statuses, statuses[-5:])
    status, _, cookie = api.login("alice", "alice password 1", "198.51.100.10")
    check("alice can still log in from her own address during the attack", status == 200 and bool(cookie), status)

    print(f"\n{PASSES} passed, {len(FAILS)} failed" + (": " + ", ".join(FAILS) if FAILS else ""))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
