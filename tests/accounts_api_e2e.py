"""Accounts + agent API end-to-end against a live server and the scripted mock provider.

Start the mock:   node tests/mock_provider.mjs 3299
Start the server: KNIFE_DATA_DIR=$(mktemp -d) KNIFE_PORT=3231 npm run dev
Run:              KNIFE_DATA_DIR=<same dir> python3 tests/accounts_api_e2e.py http://127.0.0.1:3231 http://127.0.0.1:3299

Never point this at a real model server.
"""
import json
import os
import stat
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

if len(sys.argv) < 3:
    sys.exit("usage: python3 tests/accounts_api_e2e.py <base_url> <mock_url>")
BASE = sys.argv[1].rstrip("/")
MOCK = sys.argv[2].rstrip("/")
DATA_DIR = os.environ.get("KNIFE_DATA_DIR")
if not DATA_DIR:
    sys.exit("KNIFE_DATA_DIR must point at the data dir the server was started with")
ROOT = Path(__file__).resolve().parent.parent
MOCK_KEY = "mock-key"
failures: list[str] = []
seen_get_bodies: list[str] = []


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401
        return None


opener = urllib.request.build_opener(NoRedirect)


def call(method, path, body=None, cookie=None, origin="same", raw=None, base=None, extra_headers=None):
    url = (base or BASE) + path
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    for name, value in (extra_headers or {}).items():
        req.add_header(name, value)
    if cookie:
        req.add_header("Cookie", cookie)
    if method != "GET" and origin == "same":
        req.add_header("Origin", BASE)
    elif origin not in ("same", None):
        req.add_header("Origin", origin)
    try:
        with opener.open(req, timeout=60) as resp:
            status, text, headers = resp.status, resp.read().decode(), resp.headers
    except urllib.error.HTTPError as err:
        status, text, headers = err.code, err.read().decode(), err.headers
    try:
        parsed = json.loads(text)
    except ValueError:
        parsed = None
    if method == "GET" and base is None:
        seen_get_bodies.append(text)
    return status, parsed, headers, text


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  -> ' + str(detail)}")
    if not ok:
        failures.append(name)


def cli(*args, stdin=None):
    env = {**os.environ, "KNIFE_DATA_DIR": DATA_DIR}
    return subprocess.run(
        ["node", str(ROOT / "scripts" / "accounts.mjs"), *args],
        input=stdin, capture_output=True, text=True, env=env, cwd=ROOT,
    )


def cookie_from(headers):
    raw = headers.get("Set-Cookie", "")
    return raw.split(";")[0] if raw else None


# 1. Default account bootstrap ------------------------------------------------
s, j, h, _ = call("GET", "/api/account")
check("bootstrap: GET /api/account -> genor, no password, no provider",
      s == 200 and j and j["id"] == "genor" and j["displayName"] == "Genor"
      and j["requiresPassword"] is False and j["provider"] is None, (s, j))
accounts_file = Path(DATA_DIR) / "accounts.json"
check("accounts.json created with mode 0600", accounts_file.exists() and stat.S_IMODE(accounts_file.stat().st_mode) == 0o600)
check("data dir mode 0700", stat.S_IMODE(Path(DATA_DIR).stat().st_mode) == 0o700)

# 2. No register route ---------------------------------------------------------
for path in ("/api/account/register", "/api/register", "/api/account/signup"):
    s, _, _, _ = call("POST", path, {"id": "x", "password": "y"})
    check(f"no register route: POST {path} is 404/405", s in (404, 405), s)
s, _, _, _ = call("POST", "/api/account", {"id": "x"})
check("POST /api/account (create) not allowed", s in (404, 405), s)

# 3. Provider validation + config as default (passwordless) account ----------------
chat_body = {"messages": [{"role": "user", "content": "hello"}]}
s, j, _, _ = call("POST", "/api/agent/chat", chat_body)
check("chat without provider -> 409 provider_not_configured", s == 409 and j["error"] == "provider_not_configured", (s, j))
s, j, _, _ = call("POST", "/api/account/provider/test")
check("provider test without provider -> 409", s == 409, (s, j))

for bad in ("ftp://example.com/v1", "not a url", "javascript:alert(1)", "http://user:pw@host/v1"):
    s, j, _, _ = call("PUT", "/api/account/provider", {"baseUrl": bad, "model": "m"})
    check(f"bad baseUrl rejected: {bad}", s == 400, (s, j))
s, j, _, _ = call("PUT", "/api/account/provider", {"baseUrl": f"{MOCK}/v1", "model": ""})
check("empty model rejected", s == 400, (s, j))
s, j, _, _ = call("PUT", "/api/account/provider", raw=b"{nope")
check("invalid JSON rejected", s == 400, (s, j))
s, j, _, _ = call("PUT", "/api/account/provider", {"baseUrl": f"{MOCK}/v1", "model": "m", "extraHeaders": {"Authorization": "x"}})
check("managed extra header rejected", s == 400, (s, j))

s, j, _, text = call("PUT", "/api/account/provider", {
    "baseUrl": f"{MOCK}/v1/", "model": "mock-model", "apiKey": "wrong-secret-123456",
    "extraHeaders": {"X-Test-Header": "hello"},
})
check("PUT provider strips trailing slash, returns masked shape",
      s == 200 and j["provider"]["baseUrl"] == f"{MOCK}/v1" and j["provider"]["hasKey"] is True
      and j["provider"]["keyHint"] == "…3456" and j["provider"]["extraHeaderNames"] == ["X-Test-Header"]
      and "wrong-secret" not in text and "apiKey" not in text, (s, text))

s, j, _, text = call("POST", "/api/account/provider/test")
check("provider test with wrong key -> ok:false 401, key redacted/not echoed",
      s == 200 and j["ok"] is False and j["status"] == 401 and "wrong-secret-123456" not in text, (s, text))
s, j, _, text = call("POST", "/api/agent/chat", chat_body)
check("chat with wrong key -> upstream error, key redacted",
      s == 502 and "wrong-secret-123456" not in text and "[redacted]" in text, (s, text))

s, j, _, text = call("PUT", "/api/account/provider", {"baseUrl": f"{MOCK}/v1", "model": "mock-model", "apiKey": MOCK_KEY})
check("PUT provider with real mock key", s == 200 and j["provider"]["extraHeaderNames"] == ["X-Test-Header"], (s, text))
s, j, _, _ = call("PUT", "/api/account/provider", {"baseUrl": f"{MOCK}/v1", "model": "mock-model"})
check("omitting apiKey keeps the stored key", s == 200 and j["provider"]["hasKey"] is True and j["provider"]["keyHint"] == "…", (s, j))

s, j, _, text = call("POST", "/api/account/provider/test")
check("provider test -> ok, modelCount 2", s == 200 and j == {"ok": True, "status": 200, "modelCount": 2}, (s, text))

# 4. Chat roundtrip with tool calls ------------------------------------------------
s, j, _, _ = call("GET", "/api/agent/tools")
tools = j["tools"] if j else []
names = {t["function"]["name"] for t in tools}
check("GET /api/agent/tools lists knife_* tools as OpenAI function tools",
      s == 200 and len(tools) >= 10 and "knife_count_text" in names
      and all(t["type"] == "function" and t["function"]["parameters"]["type"] == "object" for t in tools), (s, names))

s, j, _, _ = call("POST", "/api/agent/chat", {"messages": [{"role": "user", "content": "hi there"}], "temperature": 0.2, "maxTokens": 50})
check("chat echo roundtrip", s == 200 and j["message"] == {"role": "assistant", "content": "ECHO: hi there"}
      and j["finishReason"] == "stop" and j["usage"]["promptTokens"] == 1 and j["usage"]["completionTokens"] == 1, (s, j))
_, last, _, _ = call("GET", "/__last", base=MOCK)
check("mock saw bearer key, extra header, model, stream:false, temperature, max_tokens",
      last["headers"]["authorization"] == f"Bearer {MOCK_KEY}" and last["headers"]["x-test-header"] == "hello"
      and last["body"]["model"] == "mock-model" and last["body"]["stream"] is False
      and last["body"]["temperature"] == 0.2 and last["body"]["max_tokens"] == 50, last)

convo = [{"role": "system", "content": "be brief"},
         {"role": "user", "content": 'please CALL:knife_count_text:{"text":"alpha beta gamma"}'}]
s, j, _, _ = call("POST", "/api/agent/chat", {"messages": convo, "tools": tools})
calls = (j or {}).get("message", {}).get("tool_calls") or []
check("chat returns assistant tool_calls", s == 200 and j["finishReason"] == "tool_calls" and len(calls) == 1
      and calls[0]["function"]["name"] == "knife_count_text", (s, j))
_, last, _, _ = call("GET", "/__last", base=MOCK)
check("tool definitions were forwarded upstream", len(last["body"].get("tools", [])) == len(tools), last["body"].keys())

s, j, _, _ = call("POST", "/api/agent/tool", {"name": calls[0]["function"]["name"], "args": json.loads(calls[0]["function"]["arguments"])})
check("POST /api/agent/tool executes knife_count_text", s == 200 and j["ok"] is True and '"words": 3' in j["content"], (s, j))
tool_content = j["content"]
convo += [{"role": "assistant", "content": "", "tool_calls": calls},
          {"role": "tool", "tool_call_id": calls[0]["id"], "content": tool_content}]
s, j, _, _ = call("POST", "/api/agent/chat", {"messages": convo, "tools": tools})
check("tool result roundtrip -> DONE: <result>", s == 200 and j["message"]["content"] == f"DONE: {tool_content}", (s, j))

s, j, _, _ = call("POST", "/api/agent/tool", {"name": "knife_nope", "args": {}})
check("unknown tool -> 404 ok:false", s == 404 and j["ok"] is False, (s, j))
s, j, _, _ = call("POST", "/api/agent/tool", {"name": "knife_count_text", "args": {"text": 5}})
check("invalid tool args -> ok:false with message", s == 200 and j["ok"] is False and j["error"], (s, j))
s, j, _, _ = call("POST", "/api/agent/tool", {"name": "knife_format_json", "args": {"text": "{bad"}})
check("tool runtime error -> ok:false", s == 200 and j["ok"] is False, (s, j))
s, j, _, _ = call("POST", "/api/agent/chat", {"messages": []})
check("empty messages rejected", s == 400, (s, j))
s, j, _, _ = call("POST", "/api/agent/chat", {"messages": [{"role": "user", "content": "x"}] * 201})
check("too many messages rejected", s == 400, (s, j))
s, j, _, _ = call("POST", "/api/agent/chat", {"messages": [{"role": "user", "content": "x" * (2 * 1024 * 1024 + 10)}]})
check("oversized body rejected 413", s == 413, (s, j))

# 5. Cross-origin POSTs rejected -----------------------------------------------------
evil = "http://evil.example"
for method, path, body in [
    ("POST", "/api/agent/chat", chat_body),
    ("POST", "/api/agent/tool", {"name": "knife_count_text", "args": {"text": "a"}}),
    ("POST", "/api/account/provider/test", None),
    ("PUT", "/api/account/provider", {"baseUrl": "http://evil.example/v1", "model": "m", "apiKey": "stolen"}),
    ("POST", "/api/account/login", {"id": "genor", "password": "x"}),
    ("POST", "/api/account/logout", None),
]:
    s, j, _, _ = call(method, path, body, origin=evil)
    check(f"cross-origin {method} {path} -> 403", s == 403, (s, j))
s, j, _, _ = call("GET", "/api/account")
check("evil PUT did not change provider", j["provider"]["baseUrl"] == f"{MOCK}/v1", j)

# 6. Password-protected accounts via the CLI ------------------------------------------
r = cli("add", "alice", "--name", "Alice")
check("CLI add alice", r.returncode == 0, r.stderr)
r = cli("set-password", "alice", stdin="correct horse battery\n")
check("CLI set-password alice", r.returncode == 0, r.stderr)
r = cli("add", "alice", "--name", "Dup")
check("CLI add duplicate refused", r.returncode != 0 and "already exists" in r.stderr)
r = cli("set-password", "alice", stdin="short\n")
check("CLI rejects short password", r.returncode != 0)
r = cli("remove", "genor")
check("CLI refuses to remove default", r.returncode != 0 and "default" in r.stderr, r.stderr)
r = cli("set-provider", "alice", "--base-url", f"{MOCK}/v1", "--model", "mock-model", "--key-stdin", stdin=f"{MOCK_KEY}\n")
check("CLI set-provider alice (key via stdin)", r.returncode == 0, r.stderr)
r = cli("set-provider", "alice", "--base-url", f"{MOCK}/v1", "--model", "mock-model", "--key", "plain-argv")
check("CLI does not accept --key as argv value", r.returncode != 0)
r = cli("list")
check("CLI list shows accounts and masks key", "alice" in r.stdout and MOCK_KEY not in r.stdout and "…" in r.stdout, r.stdout)
check("accounts.json still 0600 after CLI writes", stat.S_IMODE(accounts_file.stat().st_mode) == 0o600)
r = cli("set-default", "alice")
check("CLI set-default alice", r.returncode == 0, r.stderr)

s, j, _, text = call("GET", "/api/account")
check("passworded default -> 401 login_required with login choices only",
      s == 401 and j["error"] == "login_required" and j["accounts"] == [{"id": "alice", "displayName": "Alice"}], (s, text))
for method, path, body in [("POST", "/api/agent/chat", chat_body), ("GET", "/api/agent/tools", None),
                           ("POST", "/api/agent/tool", {"name": "knife_count_text", "args": {"text": "a"}}),
                           ("PUT", "/api/account/provider", {"baseUrl": f"{MOCK}/v1", "model": "m"}),
                           ("POST", "/api/account/provider/test", None)]:
    s, _, _, _ = call(method, path, body)
    check(f"unauthenticated {method} {path} -> 401", s == 401, s)

s, j, _, _ = call("POST", "/api/account/login", {"id": "alice", "password": "wrong"})
check("login with wrong password -> 401", s == 401 and j["error"] == "invalid_credentials", (s, j))
s, j, _, _ = call("POST", "/api/account/login", {"id": "genor", "password": ""})
check("login to passwordless account refused", s == 401, (s, j))
s, j, _, _ = call("POST", "/api/account/login", {"id": "nobody", "password": "x"})
check("login unknown account -> same 401", s == 401 and j["error"] == "invalid_credentials", (s, j))
s, j, h, text = call("POST", "/api/account/login", {"id": "alice", "password": "correct horse battery"})
cookie = cookie_from(h)
set_cookie = h.get("Set-Cookie", "")
check("login ok sets httpOnly SameSite=Strict 30d cookie, no Secure on http",
      s == 200 and j["id"] == "alice" and cookie and cookie.startswith("knife_session=")
      and "HttpOnly" in set_cookie and "SameSite=Strict" in set_cookie and "Path=/" in set_cookie
      and "Max-Age=2592000" in set_cookie and "Secure" not in set_cookie, (s, set_cookie))
check("login response has no hash/password", "passwordHash" not in text and "scrypt" not in text)

s, j, _, _ = call("GET", "/api/account", cookie=cookie)
check("session cookie resolves alice", s == 200 and j["id"] == "alice" and j["requiresPassword"] is True
      and j["provider"]["hasKey"] is True, (s, j))
s, j, _, _ = call("POST", "/api/agent/chat", {"messages": [{"role": "user", "content": "as alice"}]}, cookie=cookie)
check("alice chat uses her own provider", s == 200 and j["message"]["content"] == "ECHO: as alice", (s, j))
_, last, _, _ = call("GET", "/__last", base=MOCK)
check("alice has no extra header (per-account config)", last["headers"]["x-test-header"] is None, last)
s, j, _, _ = call("GET", "/api/account", cookie=cookie[:-3] + "xyz")
check("tampered cookie -> 401", s == 401, s)
forged = "knife_session=" + cookie.split("=", 1)[1].split(".")[0] + ".AAAA"
s, _, _, _ = call("GET", "/api/account", cookie=forged)
check("forged signature -> 401", s == 401, s)

s, j, h, _ = call("POST", "/api/account/logout", cookie=cookie)
check("logout clears cookie", s == 200 and "Max-Age=0" in h.get("Set-Cookie", ""), (s, h.get("Set-Cookie")))

# set-password invalidates existing sessions
r = cli("set-password", "alice", stdin="another long password\n")
s, _, _, _ = call("GET", "/api/account", cookie=cookie)
check("changing password invalidates old session", s == 401, s)

# Rate limit on a third account (unique id: the limiter is in-memory per server process)
carol = f"carol{os.getpid()}"
cli("add", carol, "--name", "Carol")
cli("set-password", carol, stdin="carol password 1\n")
codes = [call("POST", "/api/account/login", {"id": carol, "password": "bad"})[0] for _ in range(6)]
check("login rate limit: 5 failures then 429", codes == [401] * 5 + [429], codes)
s, _, _, _ = call("POST", "/api/account/login", {"id": carol, "password": "carol password 1"})
check("rate limit also blocks correct password during window", s == 429, s)

# The limiter must not trust a client-supplied X-Forwarded-For (nothing fronts the app): a fresh header per guess is not a fresh budget.
dave = f"dave{os.getpid()}"
cli("add", dave, "--name", "Dave")
cli("set-password", dave, stdin="dave password 1\n")
codes = [call("POST", "/api/account/login", {"id": dave, "password": "bad"}, extra_headers={"X-Forwarded-For": f"203.0.113.{n}"})[0] for n in range(1, 8)]
check("login rate limit ignores a spoofed X-Forwarded-For (5 x 401 then 429)", codes == [401] * 5 + [429] * 2, codes)

# Only application/json bodies are read: text/plain and form posts are "simple" cross-site requests (no CORS preflight), and the
# Origin guard compares hostnames only, so another port on the same host would otherwise get through.
for ctype in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""):
    s, j, _, _ = call("POST", "/api/account/login", raw=b'{"id":"genor","password":"x"}', extra_headers={"Content-Type": ctype})
    check(f"POST with Content-Type {ctype or '(empty)'!r} is refused with 415", s == 415, (s, j))
s, j, _, _ = call("POST", "/api/account/login", raw=b'{"id":"genor","password":"x"}', extra_headers={"Content-Type": "application/json; charset=utf-8"})
check("application/json; charset=utf-8 is still accepted (reaches the credential check)", s in (200, 401), s)

# 7. Keys never in GET responses ---------------------------------------------------------
leaks = [b for b in seen_get_bodies if MOCK_KEY in b or "wrong-secret" in b or "apiKey" in b or "passwordHash" in b or "scrypt$" in b]
check(f"no key/hash in any of {len(seen_get_bodies)} GET responses", not leaks, leaks[:1])

# cleanup so repeated runs against the same data dir start sane
cli("set-default", "genor")
cli("remove", "alice")
cli("remove", carol)

print()
if failures:
    print(f"FAILED ({len(failures)}): {failures}")
    sys.exit(1)
print("ALL PASS")
