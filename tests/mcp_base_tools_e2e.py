#!/usr/bin/env python3
"""Deterministic base knife_* tools through POST /api/agent/tool (the surface the widget uses).

Today: knife_decode_jwt must tell "signature not checked" (verified null) from "checked and wrong" (false) and "checked and right"
(true). It used to answer false for a missing secret, so a model told users their valid token was forged (quality review 2026-10-10).
Expected values come from Python's hmac, not from the app.

Usage: python3 tests/mcp_base_tools_e2e.py [base_url]    (any scratch server, no provider needed)
"""
import base64
import hashlib
import hmac
import json
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3210").rstrip("/")
FAILS: list[str] = []


def check(cond, message):
    print(("ok   " if cond else "FAIL ") + message)
    if not cond:
        FAILS.append(message)


def call(name, args):
    req = urllib.request.Request(BASE + "/api/agent/tool", data=json.dumps({"name": name, "args": args}).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Origin": BASE})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode() or "null")


def b64(obj):
    raw = obj if isinstance(obj, bytes) else json.dumps(obj, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def token(alg, secret, payload):
    head, body = b64({"alg": alg, "typ": "JWT"}), b64(payload)
    digest = {"HS256": hashlib.sha256, "HS384": hashlib.sha384, "HS512": hashlib.sha512}.get(alg)
    sig = b64(hmac.new(secret.encode(), f"{head}.{body}".encode(), digest).digest()) if digest else "c2ln"
    return f"{head}.{body}.{sig}"


def result(resp):
    """POST /api/agent/tool answers {"ok": true, "content": "<the tool's JSON, pretty-printed>"} (or ok false with an error)."""
    status, body = resp
    content = body.get("content") if isinstance(body, dict) else None
    if isinstance(content, str):
        try:
            return status, json.loads(content)
        except ValueError:
            return status, {"error": content}
    return status, body if isinstance(body, dict) else {}


payload = {"sub": "user-17", "name": "Zoë 中", "exp": 4102444800}
for alg in ("HS256", "HS384", "HS512"):
    tok = token(alg, "s3cret", payload)
    s, r = result(call("knife_decode_jwt", {"token": tok}))
    check(s == 200 and r.get("payload") == payload and r.get("header", {}).get("alg") == alg, f"{alg}: header and payload decode (unicode intact)")
    check(r.get("verified") is None, f"{alg}: no secret -> verified is null (not checked), got {r.get('verified')!r}")
    check("not checked" in (r.get("verifyNote") or ""), f"{alg}: no secret -> a note says the signature was not checked")
    s, r = result(call("knife_decode_jwt", {"token": tok, "secret": "s3cret"}))
    check(r.get("verified") is True, f"{alg}: right secret -> verified true")
    s, r = result(call("knife_decode_jwt", {"token": tok, "secret": "wrong"}))
    check(r.get("verified") is False, f"{alg}: wrong secret -> verified false")

s, r = result(call("knife_decode_jwt", {"token": token("RS256", "x", payload), "secret": "x"}))
check(r.get("verified") is None and "cannot be verified" in (r.get("verifyNote") or ""), "RS256 with a shared secret -> null plus an explanation")
s, r = result(call("knife_decode_jwt", {"token": "only.two"}))
check("three dot-separated" in json.dumps(r), f"a token without three parts is rejected with a readable message: {json.dumps(r)[:90]}")

print("\nall checks passed" if not FAILS else f"\n{len(FAILS)} FAILED: {FAILS}")
sys.exit(1 if FAILS else 0)
