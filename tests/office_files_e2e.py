"""Office file browser end to end in PUBLIC mode with two user accounts and an admin, against a scratch server bound to a
Tailscale/LAN address (the Euro-Office container must reach the app) and REAL docker for the editor part.

  1. accounts: the owner (admin) via the CLI, alice and bob (role user) via the CLI, 1 GiB quota each set by the admin API
  2. isolation: every office route and every knife_doc_* tool (agent tool route and MCP) with bob's session on alice's
     documents, folders, versions and trash answers like a missing object, and bob's listings never show alice's
  3. quota: alice near 1 GiB is refused (507, readable message, in the API and in the browser), the admin is not; emptying
     the trash frees the space
  4. the file browser without the sidecar, in Chromium AND Firefox: folders (create, open, rename, move), upload into a
     folder, rename, move, duplicate, search, sort, trash + Undo, trash view restore / delete forever, download, the
     editor's clean "not installed" state
  5. the sidecar (admin installs it): open in the editor, type, Ctrl+S = a new version, versions panel lists the previous
     one, preview it, restore it (content checked in the downloaded file), close; Firefox opens the editor too
  6. cleanup: sidecar purged (no container or volume of the test project left), scratch server and data dir removed

    python3 tests/office_files_e2e.py --host <tailscale-or-LAN-ip> [--skip-docker] [--shots DIR] [--keep]

Isolation: own scratch worktree (tests/scratch_server.py), own KNIFE_DATA_DIR and port (KNIFE_SCRATCH_PORTS limits the
range), own compose project (KNIFE_SIDECAR_PREFIX, default knife-test-office). Never touches the live app or other containers.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scratch_server import ROOT, ScratchServer  # noqa: E402

from playwright.sync_api import Browser, Page, expect, sync_playwright  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []
ADMIN_PW = "owner password 123"
PW = {"alice": "alice password 1", "bob": "bob password 22"}
GIB = 1024 ** 3
SHOTS = Path("/tmp/knife-office-shots")


def check(name: str, ok: bool, detail: object = "") -> bool:
    RESULTS.append((name, ok, str(detail)[:400]))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{f' — {str(detail)[:400]}' if detail not in ('', None) and not ok else ''}", flush=True)
    return ok


class Api:
    def __init__(self, base: str, cookie: str | None = None) -> None:
        self.base = base
        self.cookie = cookie

    def call(self, method: str, path: str, body: object | None = None, headers: dict[str, str] | None = None, timeout: float = 120) -> tuple[int, object]:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Origin", self.base)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        if self.cookie:
            req.add_header("Cookie", self.cookie)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                raw = res.read()
                ctype = res.headers.get("content-type", "")
                return res.status, parse(raw, ctype)
        except urllib.error.HTTPError as err:
            raw = err.read()
            return err.code, parse(raw, err.headers.get("content-type", ""))

    def login(self, ident: str, password: str) -> str:
        req = urllib.request.Request(self.base + "/api/account/login", data=json.dumps({"id": ident, "password": password}).encode(), method="POST")
        req.add_header("Origin", self.base)
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=30) as res:
            for line in res.headers.get_all("Set-Cookie") or []:
                if line.startswith("knife_session="):
                    return line.split(";")[0]
        raise RuntimeError(f"no session cookie for {ident}")

    def wait_op(self, op: dict, timeout: float) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            _, body = self.call("GET", f"/api/services/ops/{op['opId']}")
            op = body["op"]
            if op["status"] != "running":
                return op
            time.sleep(1)
        raise TimeoutError(f"op {op['kind']} still running")

    def mcp(self, name: str, args: dict) -> dict:
        _, body = self.call("POST", "/api/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}},
                            headers={"Accept": "application/json, text/event-stream"})
        return body if isinstance(body, dict) else {}


def parse(raw: bytes, ctype: str) -> object:
    if "json" in ctype:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw
    if "event-stream" in ctype:
        for line in raw.decode().splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:].strip())
    return raw


def docx_bytes(text: str) -> bytes:
    """A minimal valid docx (python-docx is not needed): the parts Word and the Document Server require."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        z.writestr("word/document.xml", f'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>')
    return buf.getvalue()


def docx_text(raw: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        xml = z.read("word/document.xml").decode()
    return "".join(re.findall(r"<w:t(?:\s[^>]*)?>([^<]*)</w:t>", xml))


def b64(raw: bytes) -> str:
    import base64
    return base64.b64encode(raw).decode()


def cli(server: ScratchServer, *args: str, stdin: str = "") -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "KNIFE_DATA_DIR": str(server.data_dir), "KNIFE_AUTH_MODE": "public"}
    return subprocess.run(["node", str(ROOT / "scripts" / "accounts.mjs"), *args], input=stdin, capture_output=True, text=True, env=env, cwd=ROOT)


def shot(page: Page, name: str) -> None:
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=True)


def new_page(browser: Browser, base: str, cookie: str) -> Page:
    ctx = browser.new_context(base_url=base, viewport={"width": 1400, "height": 950}, accept_downloads=True)
    name, value = cookie.split("=", 1)
    ctx.add_cookies([{"name": name, "value": value, "url": base}])
    page = ctx.new_page()
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    page.errors = errors  # type: ignore[attr-defined]
    return page


def library_ready(page: Page) -> None:
    page.goto("/tools/office", wait_until="networkidle")
    page.get_by_role("heading", name="Your documents").wait_for(timeout=60_000)
    page.wait_for_function("() => !document.querySelector('[data-agent-region=\"office-library-status\"]')?.textContent?.includes('Loading')", timeout=30_000)


def notice(page: Page, pattern: str, timeout: int = 20_000) -> bool:
    try:
        expect(page.get_by_text(re.compile(pattern)).first).to_be_visible(timeout=timeout)
        return True
    except AssertionError:
        return False


# ------------------------------------------------------------------------------------------------------- 2. isolation
def isolation(base: str, alice: Api, bob: Api) -> None:
    _, body = alice.call("POST", "/api/office/folders", {"name": "Alice private"})
    folder = body["folder"]
    _, body = alice.call("POST", "/api/office/docs", {"action": "upload", "name": "Alice secret.docx", "data": b64(docx_bytes("alice only")), "folderId": folder["id"]})
    doc = body["doc"]
    _, body = alice.call("POST", "/api/office/docs", {"action": "create", "format": "xlsx", "name": "Alice trashed"})
    trashed = body["doc"]
    alice.call("POST", f"/api/office/docs/{trashed['id']}", {"action": "trash"})
    _, body = alice.call("POST", "/api/office/folders", {"name": "Alice trashed folder"})
    tfolder = body["folder"]
    alice.call("POST", f"/api/office/folders/{tfolder['id']}", {"action": "trash"})
    aid, fid = doc["id"], folder["id"]

    probes: list[tuple[str, str, object | None]] = [
        ("GET", f"/api/office/docs/{aid}", None),
        ("GET", f"/api/office/docs/{aid}?download=1", None),
        ("GET", f"/api/office/docs/{aid}/versions/1", None),
        ("GET", f"/api/office/docs/{aid}/versions/1?download=1", None),
        ("GET", f"/api/office/docs/{aid}/editor", None),
        ("POST", f"/api/office/docs/{aid}", {"action": "rename", "name": "pwned"}),
        ("POST", f"/api/office/docs/{aid}", {"action": "move", "folderId": None}),
        ("POST", f"/api/office/docs/{aid}", {"action": "duplicate"}),
        ("POST", f"/api/office/docs/{aid}", {"action": "trash"}),
        ("POST", f"/api/office/docs/{trashed['id']}", {"action": "restore"}),
        ("POST", f"/api/office/docs/{aid}", {"action": "restore_version", "version": 1}),
        ("POST", f"/api/office/docs/{aid}", {"action": "prune_versions", "keep": 0}),
        ("POST", f"/api/office/docs/{aid}", {"action": "forcesave"}),
        ("DELETE", f"/api/office/docs/{aid}", None),
        ("DELETE", f"/api/office/docs/{trashed['id']}?permanent=1", None),
        ("POST", "/api/office/docs", {"action": "create", "format": "docx", "name": "x", "folderId": fid}),
        ("POST", "/api/office/folders", {"name": "x", "parentId": fid}),
        ("POST", f"/api/office/folders/{fid}", {"action": "rename", "name": "pwned"}),
        ("POST", f"/api/office/folders/{fid}", {"action": "move", "parentId": None}),
        ("POST", f"/api/office/folders/{fid}", {"action": "trash"}),
        ("POST", f"/api/office/folders/{tfolder['id']}", {"action": "restore"}),
        ("DELETE", f"/api/office/folders/{tfolder['id']}", None),
    ]
    bad = []
    for method, path, body in probes:
        status, answer = bob.call(method, path, body)
        if status != 404:
            bad.append(f"{method} {path} -> {status} {str(answer)[:120]}")
    check(f"bob gets 404 on all {len(probes)} office routes for alice's document/folder/trash", not bad, "; ".join(bad))
    _, body = bob.call("POST", "/api/office/trash", {"action": "empty"})
    check("bob's empty-trash touches only bob's trash", isinstance(body, dict) and body.get("docs") == 0, body)
    _, lib = bob.call("GET", "/api/office/docs")
    ids = json.dumps(lib)
    check("bob's library lists none of alice's documents, folders or trash", all(x not in ids for x in (aid, fid, trashed["id"], tfolder["id"])), "")
    _, lib = alice.call("GET", "/api/office/docs")
    check("alice's data is intact after bob's attempts",
          any(d["id"] == aid and d["name"] == "Alice secret.docx" and d["folderId"] == fid for d in lib["docs"])
          and any(f["id"] == fid and f["name"] == "Alice private" for f in lib["folders"])
          and [d["id"] for d in lib["trash"]["docs"]] == [trashed["id"]] and [f["id"] for f in lib["trash"]["folders"]] == [tfolder["id"]], "")
    status, raw = alice.call("GET", f"/api/office/docs/{aid}?download=1")
    check("alice downloads her file unchanged", status == 200 and docx_text(raw) == "alice only", status)

    tool_calls = [
        ("knife_doc_read", {"id": aid}),
        ("knife_doc_versions", {"id": aid}),
        ("knife_doc_restore_version", {"id": aid, "version": 1}),
        ("knife_doc_move", {"id": aid, "folderId": None}),
        ("knife_doc_create", {"format": "docx", "name": "x", "folderId": fid}),
        ("knife_doc_folder_create", {"name": "x", "parentId": fid}),
    ]
    leaks = []
    for name, args in tool_calls:
        status, body = bob.call("POST", "/api/agent/tool", {"name": name, "args": args})
        if status == 200 and isinstance(body, dict) and not body.get("isError") and "unknown" not in json.dumps(body):
            leaks.append(f"agent {name}: {str(body)[:120]}")
        res = bob.mcp(name, args).get("result", {})
        if not res.get("isError"):
            leaks.append(f"mcp {name}: {str(res)[:120]}")
    check(f"bob's knife_doc_* calls on alice's ids fail (agent tool route + MCP, {len(tool_calls) * 2} calls)", not leaks, "; ".join(leaks))
    status, body = bob.call("POST", "/api/agent/tool", {"name": "knife_doc_list", "args": {}})
    mcp_list = json.dumps(bob.mcp("knife_doc_list", {}))
    check("bob's knife_doc_list (agent + MCP) shows none of alice's", status == 200 and aid not in json.dumps(body) and fid not in json.dumps(body) and aid not in mcp_list, "")
    alice_list = json.dumps(alice.mcp("knife_doc_list", {}))
    check("alice's knife_doc_list over MCP shows her document with its folder path", aid in alice_list and "Alice private" in alice_list, alice_list[:200])


# --------------------------------------------------------------------------------------------------------- 3. quota
def quota(server: ScratchServer, base: str, admin: Api, carol: Api, browser: Browser, carol_cookie: str) -> None:
    status, body = carol.call("GET", "/api/account/storage")
    check("a user's storage: 1 GiB quota", status == 200 and body.get("quotaBytes") == GIB, body)
    status, body = admin.call("GET", "/api/account/storage")
    check("the admin's storage: unlimited", status == 200 and body.get("quotaBytes") is None, body)
    # Fill carol to 1 GiB - 1 MB with one sparse document (no disk used), written before her usage is first counted.
    assert server.data_dir is not None
    _, body = carol.call("POST", "/api/office/docs", {"action": "create", "format": "docx", "name": "Archive"})
    big = body["doc"]
    path = server.data_dir / "docs" / "carol" / big["id"] / "current.docx"
    with open(path, "r+b") as fh:
        fh.truncate(GIB - 1024 * 1024)
    # Written behind the server's back: the server trusts its count for KNIFE_STORAGE_RECOUNT_SEC (1 s here), then walks again.
    time.sleep(1.5)
    status, body = carol.call("GET", "/api/account/storage")
    used = body.get("usedBytes", 0)
    check("carol is near her quota (sparse 1 GiB - 1 MB file counted)", used > GIB - 2 * 1024 * 1024, used)
    payload = b64(docx_bytes("x" * 10) + b"\0" * (3 * 1024 * 1024))
    status, body = carol.call("POST", "/api/office/docs", {"action": "upload", "name": "Too big.docx", "data": payload})
    check("upload over the quota -> 507 storage_quota_exceeded with a readable message",
          status == 507 and isinstance(body, dict) and body.get("code") == "storage_quota_exceeded" and "Not enough storage" in body.get("error", "") and "1.0 GB" in body.get("error", ""), (status, body))
    status, body = admin.call("POST", "/api/office/docs", {"action": "upload", "name": "Admin big.docx", "data": payload})
    check("the admin uploads the same file (unlimited)", status == 201, (status, str(body)[:200]))
    status, body = carol.call("POST", "/api/cv/photo", {"dataUrl": "data:image/jpeg;base64," + b64(b"\xff\xd8\xff\xe0" + b"\0" * (1400 * 1024))})
    check("CV photo over the quota -> 507", status == 507, (status, body))
    status, body = carol.call("POST", "/api/office/docs", {"action": "create", "format": "docx", "name": "small"})
    check("a small blank document still fits", status == 201, status)

    page = new_page(browser, base, carol_cookie)
    library_ready(page)
    meter = page.locator("[data-agent-region=storage-meter]").first.inner_text()
    check("the file browser shows used / 1.0 GB", "of 1.0 GB used" in meter, meter)
    with tempfile.TemporaryDirectory(prefix="knife-office-upload-") as tmp:
        file = Path(tmp) / "Big upload.docx"
        file.write_bytes(docx_bytes("big") + b"\0" * (3 * 1024 * 1024))
        page.locator("input[type=file]").set_input_files(str(file))
        check("the browser refuses the upload with a clear message before sending", notice(page, r"Big upload\.docx .* does not fit: .* of your storage is free"), "")
    shot(page, "05-quota-refused")
    page.goto("/account", wait_until="networkidle")
    page.get_by_text("Your storage").first.wait_for(timeout=20_000)
    text = page.locator("[data-agent-region=storage-meter]").first.inner_text()
    check("/account shows the storage meter", "of 1.0 GB used" in text, text)
    shot(page, "06-account-storage")
    page.context.close()
    # Trash + empty frees the space.
    carol.call("POST", f"/api/office/docs/{big['id']}", {"action": "trash"})
    status, _ = carol.call("POST", "/api/office/docs", {"action": "upload", "name": "Too big.docx", "data": payload})
    check("a trashed file still counts", status == 507, status)
    carol.call("POST", "/api/office/trash", {"action": "empty"})
    status, _ = carol.call("POST", "/api/office/docs", {"action": "upload", "name": "Too big.docx", "data": payload})
    check("after emptying the trash the upload fits", status == 201, status)


# ------------------------------------------------------------------------------------------------ 4. file browser UI
def browser_walk(browser: Browser, base: str, cookie: str, label: str, installed: bool) -> None:
    page = new_page(browser, base, cookie)
    library_ready(page)
    tag = f"[{label}]"
    page.get_by_role("button", name="New folder").click()
    page.get_by_label("Folder name").fill(f"Projects {label}")
    page.get_by_role("button", name="Create folder").click()
    check(f"{tag} create a folder", notice(page, f"Created folder Projects {label}"))
    page.get_by_role("button", name=f"Open folder Projects {label}").click()
    expect(page.get_by_text("This folder is empty")).to_be_visible(timeout=10_000)
    page.get_by_role("button", name="New folder").click()
    page.get_by_label("Folder name").fill("Drafts")
    page.keyboard.press("Enter")
    check(f"{tag} subfolder with Enter (keyboard)", notice(page, "Created folder Drafts in Projects"))
    with tempfile.TemporaryDirectory(prefix="knife-office-upload-") as tmp:
        one, two = Path(tmp) / "Report.docx", Path(tmp) / "Notes.docx"
        one.write_bytes(docx_bytes("report body"))
        two.write_bytes(docx_bytes("notes body"))
        page.locator("input[type=file]").set_input_files([str(one), str(two)])
        check(f"{tag} upload two files into the open folder", notice(page, f"Uploaded Report.docx, Notes.docx into Projects {label}"))
    expect(page.get_by_role("button", name="Open Report.docx")).to_be_visible()
    shot(page, f"01-browser-folder-{label}")

    # Rename + move + duplicate through the Actions row.
    page.get_by_role("button", name="More actions for Notes.docx").click()
    page.get_by_label("New name for Notes.docx").fill("Meeting notes")
    page.get_by_role("button", name="Rename", exact=True).click()
    check(f"{tag} rename", notice(page, "Renamed to Meeting notes.docx"))
    page.get_by_role("button", name="More actions for Meeting notes.docx").click()
    page.get_by_role("combobox", name="Destination for Meeting notes.docx").select_option(label=f"Projects {label} / Drafts")
    page.get_by_role("button", name="Move", exact=True).click()
    check(f"{tag} move into a subfolder", notice(page, f"Moved Meeting notes.docx to Projects {label} / Drafts"))
    page.get_by_role("button", name="More actions for Report.docx").click()
    shot(page, f"02-actions-row-{label}")
    page.get_by_role("button", name="Duplicate Report.docx").click()
    check(f"{tag} duplicate", notice(page, r"Made Report \(copy\)\.docx"))

    # Search across folders, sort by name.
    page.get_by_role("searchbox", name="Search documents").fill("meeting")
    expect(page.get_by_role("button", name="Open Meeting notes.docx")).to_be_visible(timeout=10_000)
    check(f"{tag} search finds a file in another folder (with its folder path)", page.get_by_role("cell", name=f"Projects {label} / Drafts").count() >= 1)
    shot(page, f"03-search-{label}")
    page.get_by_role("searchbox", name="Search documents").fill("")
    page.get_by_role("button", name=re.compile("^Name")).click()
    names = page.locator("tbody tr td:first-child button").all_inner_texts()
    files = [n for n in names if n.endswith(".docx")]
    check(f"{tag} sort by name ascending", files == sorted(files, key=str.lower), names)

    # Download.
    with page.expect_download() as dl:
        page.get_by_role("link", name="Download Report.docx").click()
    path = dl.value.path()
    check(f"{tag} download returns the file", path is not None and docx_text(Path(path).read_bytes()) == "report body", dl.value.suggested_filename)

    # Trash + Undo, then trash view restore and delete forever.
    page.get_by_role("button", name="Move Report (copy).docx to the trash").click()
    check(f"{tag} move to the trash", notice(page, r"Moved Report \(copy\)\.docx to the trash"))
    page.get_by_role("button", name="Undo").click()
    expect(page.get_by_role("button", name="Open Report (copy).docx")).to_be_visible(timeout=15_000)
    check(f"{tag} Undo brings it back", True)
    page.get_by_role("button", name="Move Report (copy).docx to the trash").click()
    notice(page, "to the trash")
    page.get_by_role("navigation", name="Folder path").get_by_role("button", name="Library").click()
    page.get_by_role("button", name=f"Move folder Projects {label} to the trash").click()
    check(f"{tag} trash a folder with its documents", notice(page, rf"Moved folder Projects {label} and \d document\(s\) in it to the trash"))
    page.get_by_role("radio", name=re.compile("^Trash")).click()
    expect(page.get_by_role("button", name=f"Restore Projects {label}")).to_be_visible(timeout=10_000)
    shot(page, f"04-trash-{label}")
    page.get_by_role("button", name="Delete Report (copy).docx for good").click()
    page.get_by_role("button", name="Confirm delete Report (copy).docx").click()
    check(f"{tag} delete forever from the trash", notice(page, r"Deleted Report \(copy\)\.docx for good"))
    page.get_by_role("button", name=f"Restore Projects {label}").click()
    check(f"{tag} restore the folder", notice(page, f"Restored Projects {label}"))
    page.get_by_role("radio", name="Files").click()
    page.get_by_role("button", name=f"Open folder Projects {label}").click()
    expect(page.get_by_role("button", name="Open Report.docx")).to_be_visible(timeout=10_000)
    page.get_by_role("button", name="Open folder Drafts").click()
    expect(page.get_by_role("button", name="Open Meeting notes.docx")).to_be_visible(timeout=10_000)
    check(f"{tag} the restored folder brings back its subfolder and documents", True)

    # Keyboard: Escape closes an open actions row.
    page.get_by_role("button", name="More actions for Meeting notes.docx").click()
    page.get_by_label("New name for Meeting notes.docx").press("Escape")
    check(f"{tag} Escape closes the actions row", page.get_by_label("New name for Meeting notes.docx").count() == 0)

    if not installed:
        page.get_by_role("button", name="Open Meeting notes.docx").click()
        status = page.locator('[data-agent-region="office-editor-status"]')
        expect(status).to_contain_text("not installed", timeout=15_000)
        check(f"{tag} opening without the sidecar shows the not-installed state", True)
        shot(page, f"07-editor-not-installed-{label}")
        page.get_by_role("button", name="Back to documents").click()
        page.get_by_role("heading", name="Your documents").wait_for(timeout=15_000)
    errors = [e for e in page.errors if "hydrat" in e.lower() or "Warning" in e]  # type: ignore[attr-defined]
    check(f"{tag} no hydration/React errors in the console", not errors, errors[:3])
    page.context.close()


# ---------------------------------------------------------------------------------------------- 5. editor + versions
def wait_editor_ready(page: Page, timeout_ms: int = 300_000) -> str:
    status = page.locator('[data-agent-region="office-editor-status"]')
    status.wait_for(timeout=60_000)
    page.wait_for_function(
        "() => { const t = document.querySelector('[data-agent-region=\"office-editor-status\"]')?.textContent ?? ''; return t.startsWith('Editor ready') || t.startsWith('Could not open'); }",
        timeout=timeout_ms,
    )
    return status.inner_text()


def wait_for(predicate, timeout: float, step: float = 1.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(step)
    return None


def editor_versions(browser: Browser, firefox: Browser | None, base: str, alice: Api, cookie: str) -> None:
    _, body = alice.call("POST", "/api/office/docs", {"action": "upload", "name": "Versioned.docx", "data": b64(docx_bytes("first draft"))})
    doc = body["doc"]
    page = new_page(browser, base, cookie)
    page.goto(f"/tools/office?doc={doc['id']}", wait_until="domcontentloaded")
    text = wait_editor_ready(page)
    check("a user opens her document in the editor (running sidecar)", text.startswith("Editor ready"), text)
    shot(page, "08-editor-open")
    frame = page.frame_locator('iframe[name="frameEditor"]')
    canvas = frame.locator("#editor_sdk")
    canvas.wait_for(timeout=60_000)
    time.sleep(3)
    box = canvas.bounding_box()
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + 200)
    page.keyboard.press("Control+End")
    page.keyboard.type(" plus an edit", delay=40)
    time.sleep(2)
    page.keyboard.press("Control+s")
    saved = wait_for(lambda: alice.call("GET", f"/api/office/docs/{doc['id']}")[1]["doc"]["version"] > 1, timeout=90)
    check("edit + Ctrl+S saves a new version through the callback", bool(saved), "")
    _, details = alice.call("GET", f"/api/office/docs/{doc['id']}")
    kept = details.get("versions", [])
    check("the previous content is kept as version 1", [v["version"] for v in kept] == [1] and kept[0]["bytes"] == doc["bytes"], kept)
    status, raw = alice.call("GET", f"/api/office/docs/{doc['id']}?download=1")
    check("the current file has the edit", "plus an edit" in docx_text(raw), docx_text(raw)[:120])
    page.get_by_role("button", name="Close editor").click()
    page.get_by_role("heading", name="Your documents").wait_for(timeout=60_000)
    closed = wait_for(lambda: alice.call("GET", f"/api/office/docs/{doc['id']}")[1]["doc"]["key"] != details["doc"]["key"], timeout=120)
    check("closing the editor ends the session (new key)", bool(closed), "")

    library_ready(page)
    page.get_by_role("button", name="Versions of Versioned.docx").click()
    region = page.get_by_role("region", name="Versions of Versioned.docx")
    expect(region.get_by_role("button", name="Restore version 1 of Versioned.docx")).to_be_visible(timeout=15_000)
    region.get_by_role("button", name="Preview version 1 of Versioned.docx").click()
    expect(region.get_by_text("first draft")).to_be_visible(timeout=10_000)
    check("versions panel: preview of version 1 shows its text", True)
    shot(page, "09-versions-panel")
    with page.expect_download() as dl:
        region.get_by_role("link", name="Download version 1 of Versioned.docx").click()
    vpath = dl.value.path()
    check("download a version", vpath is not None and docx_text(Path(vpath).read_bytes()) == "first draft", dl.value.suggested_filename)
    region.get_by_role("button", name="Restore version 1 of Versioned.docx").click()
    check("restore version 1 (UI)", notice(page, r"Restored version 1 of Versioned\.docx as version \d+"))
    _, raw = alice.call("GET", f"/api/office/docs/{doc['id']}?download=1")
    _, details = alice.call("GET", f"/api/office/docs/{doc['id']}")
    check("restored content is current, the edited one is kept", docx_text(raw) == "first draft" and len(details["versions"]) >= 2 and details["doc"]["versionSource"] == "restore", details["doc"].get("versionSource"))
    shot(page, "10-version-restored")
    page.get_by_role("button", name="Open Versioned.docx").click()
    text = wait_editor_ready(page)
    check("the restored document opens in the editor", text.startswith("Editor ready"), text)
    page.get_by_role("button", name="Close editor").click()
    page.context.close()
    if firefox:
        fpage = new_page(firefox, base, cookie)
        fpage.goto(f"/tools/office?doc={doc['id']}", wait_until="domcontentloaded")
        text = wait_editor_ready(fpage)
        check("[firefox] the editor opens", text.startswith("Editor ready"), text)
        shot(fpage, "11-editor-firefox")
        fpage.get_by_role("button", name="Close editor").click()
        fpage.context.close()


def containers(project: str) -> tuple[list[str], list[str]]:
    names = subprocess.run(["docker", "ps", "-a", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Names}}"], capture_output=True, text=True).stdout.split()
    vols = subprocess.run(["docker", "volume", "ls", "-q", "--filter", f"label=com.docker.compose.project={project}"], capture_output=True, text=True).stdout.split()
    return names, vols


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("KNIFE_E2E_HOST") or os.environ.get("KNIFE_HOST") or "127.0.0.1")
    parser.add_argument("--skip-docker", action="store_true")
    parser.add_argument("--keep", action="store_true", help="leave server + sidecar up until Enter")
    parser.add_argument("--shots", default=str(SHOTS))
    parser.add_argument("--prefix", default=os.environ.get("KNIFE_SIDECAR_PREFIX", "knife-test-office"))
    args = parser.parse_args()
    globals()["SHOTS"] = Path(args.shots)
    project = f"{args.prefix}-office"
    server = ScratchServer(host=args.host)
    url = server.start(env={"KNIFE_AUTH_MODE": "public", "KNIFE_SIDECAR_PREFIX": args.prefix, "KNIFE_MAIL_TRANSPORT": "outbox", "KNIFE_STORAGE_RECOUNT_SEC": "1"})
    print(f"scratch server {url}, data dir {server.data_dir}, compose project {project}", flush=True)
    installed = False
    try:
        anon = Api(url)
        r = cli(server, "set-password", "genor", stdin=ADMIN_PW + "\n")
        check("CLI: owner password", r.returncode == 0, r.stderr)
        cli(server, "set-email", "genor", "owner@example.test")
        for user in ("alice", "bob", "carol"):
            r = cli(server, "add", user, "--name", user.title(), "--email", f"{user}@example.test", "--role", "user", "--password-prompt", stdin=PW.get(user, "carol password 3") + "\n")
            check(f"CLI: add {user} (role user)", r.returncode == 0, r.stderr + r.stdout)
        admin = Api(url, anon.login("genor", ADMIN_PW))
        for user in ("alice", "bob", "carol"):
            status, body = admin.call("POST", f"/api/admin/users/{user}", {"action": "quota", "bytes": GIB})
            check(f"admin sets {user}'s quota to 1 GiB", status == 200, (status, body))
        alice_cookie = anon.login("alice", PW["alice"])
        bob_cookie = anon.login("bob", PW["bob"])
        carol_cookie = anon.login("carol", "carol password 3")
        alice, bob, carol = Api(url, alice_cookie), Api(url, bob_cookie), Api(url, carol_cookie)

        isolation(url, alice, bob)
        with sync_playwright() as pw:
            chromium = pw.chromium.launch()
            firefox = pw.firefox.launch()
            quota(server, url, admin, carol, chromium, carol_cookie)
            browser_walk(chromium, url, alice_cookie, "chromium", installed=False)
            browser_walk(firefox, url, bob_cookie, "firefox", installed=False)
            if not args.skip_docker:
                status, body = admin.call("POST", "/api/services/office", {"action": "install"})
                check("admin installs the office sidecar", status == 202, (status, body))
                op = admin.wait_op(body["op"], timeout=1800)
                installed = op["status"] == "done"
                check("install op done", installed, op.get("error") or op.get("phase"))
                if installed:
                    editor_versions(chromium, firefox, url, alice, alice_cookie)
            chromium.close()
            firefox.close()
    finally:
        if args.keep:
            input(f"--keep: server {url}, data {server.data_dir}; press Enter to clean up ")
        if not args.skip_docker:
            try:
                admin_api = Api(url, Api(url).login("genor", ADMIN_PW))
                status, body = admin_api.call("POST", "/api/services/office", {"action": "remove", "purge": True})
                if isinstance(body, dict) and "op" in body:
                    op = admin_api.wait_op(body["op"], timeout=600)
                    check("remove (purge) op done", op["status"] == "done", op.get("error", ""))
            except Exception as error:  # noqa: BLE001
                check("remove (purge) op", False, error)
            left, vols = containers(project)
            check("no container or volume of the test project left", not left and not vols, f"{left} {vols}")
        server.stop()
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    for name, _, detail in failed:
        print(f"  FAIL {name}: {detail}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
