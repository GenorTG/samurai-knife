"""web group: website check, csp, curl, robots-txt, sitemap, ids, jwt, password, mcp-connect, epoch and dates, url."""
import base64
import datetime as dt
import hashlib
import hmac
import http.server
import json
import re
import threading
from urllib.parse import urlparse

from tests.coverage.core import Case, Ctx, first_error, has, matches

GROUP = "web"
SKIPS: dict[tuple[str, str | None], str] = {}


def _dash(s: str) -> str:
    return s.replace("—", "-").replace("–", "-")


def _num(hay: str, n) -> str | None:
    return None if re.search(rf"(?<![\d.]){re.escape(str(n))}(?![\d])", hay) else f"number {n} not found"


# ---------------------------------------------------------------- stacktrace
_ST_IN = (
    "TypeError: Cannot read properties of undefined (reading 'id')\n"
    "    at parseRow (lib/csv.ts:211:19)\n"
    "    at mapRows (lib/csv.ts:88:5)\n"
    "    at mapRows (lib/csv.ts:88:5)\n"
    "    at Object.<anonymous> (/srv/app/main.js:9:1)\n"
    "\n"
    "Traceback (most recent call last):\n"
    "  File \"worker.py\", line 18, in run\n"
    "  File \"worker.py\", line 18, in run\n"
    "  File \"util/io.py\", line 7, in read_all\n"
    "    return fh.read()\n"
    "ValueError: bad data\n"
)


def _st_norm(line: str) -> str:
    s = line.strip()
    m = re.match(r"^at\s+(.*?)\s+\((.*?):(\d+):(\d+)\)$", s)
    if m:
        return f"at {m[1]} - {m[2]}:{m[3]}:{m[4]}"
    m = re.match(r'^File "(.*?)", line (\d+), in (.*)$', s)
    if m:
        return f"at {m[3]} - {m[1]}:{m[2]}"
    return s


_st_lines = [_st_norm(x) for x in _ST_IN.splitlines() if x.strip()]
_ST_FRAMES = ["at parseRow - lib/csv.ts:211:19", "at mapRows - lib/csv.ts:88:5", "at run - worker.py:18",
              "at read_all - util/io.py:7", "at Object.<anonymous> - /srv/app/main.js:9:1"]
assert all(f in _st_lines for f in _ST_FRAMES)


# ---------------------------------------------------------------- ansi
_ESC = "\x1b"
_ANSI_IN = (f"{_ESC}]0;ci-runner\x07{_ESC}[1;34mSTEP 3/7{_ESC}[0m compiling {_ESC}[33m14{_ESC}[39m modules\n"
            f"{_ESC}[2K{_ESC}[31mERROR{_ESC}[0m: cannot resolve 'left-pad'\n")
_ANSI_CLEAN = re.sub(r"\x1b\][^\x07]*\x07|\x1b\[[0-?]*[ -/]*[@-~]", "", _ANSI_IN)
assert _ANSI_CLEAN == "STEP 3/7 compiling 14 modules\nERROR: cannot resolve 'left-pad'\n"


# ---------------------------------------------------------------- headers
_HDR_IN = ("HTTP/1.1 503 Service Unavailable\n"
           "Content-Type: text/html; charset=utf-8\n"
           "Retry-After: 120\n"
           "Set-Cookie: sid=abc; Secure; HttpOnly\n"
           "Set-Cookie: theme=dark; Path=/\n"
           "Cache-Control: no-store\n"
           "Via: 1.1 edge-a\n"
           "Via: 1.1 edge-b\n"
           "X-Content-Type-Options: nosniff\n"
           "Server: nginx\n")
_hn: dict[str, int] = {}
for _l in _HDR_IN.splitlines()[1:]:
    _k = _l.split(":", 1)[0].lower()
    _hn[_k] = _hn.get(_k, 0) + 1
_HDR_NAMES = len(_hn)  # 8
_HDR_DUPS = sum(1 for v in _hn.values() if v > 1)  # 2
_HDR_MISSING = [k for k in ("strict-transport-security", "content-security-policy", "referrer-policy") if k not in _hn]
assert (_HDR_NAMES, _HDR_DUPS, len(_HDR_MISSING)) == (7, 2, 3)


# ---------------------------------------------------------------- csp
def _csp(c: Ctx):
    h = c.haystack()
    return first_error(
        has(h, "Content-Security-Policy-Report-Only"),
        matches(h, r"script-src 'self' https://cdn\.jsdelivr\.net"),
        matches(h, r"img-src 'self' data:"),
        matches(h, r"connect-src 'self' https://api\.stripe\.com wss://live\.example\.net"),
        matches(h, r"object-src 'none'"),
        matches(h, r"frame-ancestors 'none'"),
    )


# ---------------------------------------------------------------- curl
def _curl(c: Ctx):
    h = c.haystack()
    return first_error(has(h, "O'\\''Brien", "https://api.example.com/v2/customers"),
                       matches(h, r"X-Request-Id: 7f3a-91"), matches(h, r"POST"))


# ---------------------------------------------------------------- multipart


# ---------------------------------------------------------------- semver


# ---------------------------------------------------------------- lockfile
_LOCK = {"name": "shop", "lockfileVersion": 3, "packages": {
    "": {"name": "shop"},
    "node_modules/lodash": {"version": "4.17.21"},
    "node_modules/zod": {"version": "3.23.8"},
    "node_modules/tool-a/node_modules/lodash": {"version": "4.17.15"},
    "node_modules/tool-b/node_modules/lodash": {"version": "4.16.6"},
    "node_modules/chalk": {"version": "5.3.0"},
    "node_modules/tool-a": {"version": "2.1.0"},
    "node_modules/tool-b": {"version": "0.9.4", "dev": True},
    "node_modules/tool-b/node_modules/chalk": {"version": "4.1.2"},
    "node_modules/tool-b/node_modules/zod": {"version": "3.23.8"},
}}
_pk = [(p, v) for p, v in _LOCK["packages"].items() if p]
_vers: dict[str, set] = {}
for _p, _v in _pk:
    _vers.setdefault(_p.split("node_modules/")[-1], set()).add(_v["version"])
_LOCK_DUPS = {n: sorted(v) for n, v in _vers.items() if len(v) > 1}
assert set(_LOCK_DUPS) == {"lodash", "chalk"}


# ---------------------------------------------------------------- robots
_ROBOTS = ("User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nDisallow: /shop/*/checkout\nAllow: /shop/cart/\nDisallow: /admin$\n")


def _robots(c: Ctx):
    a = c.answer.lower()
    blocked = re.search(r"disallow|blocked|not allowed|may not|cannot|can't|forbidden|denied", a)
    allowed_claim = re.search(r"\bis allowed\b|\bcan crawl\b|\bmay crawl\b|\ballowed by\b", a) and not re.search(r"not allowed|isn't allowed|disallowed", a)
    return first_error(None if blocked else "does not say the path is blocked",
                       "claims the path is allowed" if allowed_claim else None,
                       has(a, "/shop/*/checkout"))


# ---------------------------------------------------------------- sitemap
_SM_LOCS = [("https://shop.example/", "2026-03-01"), ("https://shop.example/about", "2026-02-30"),
            ("https://shop.example/blog", "2026-01-15"), ("https://shop.example/blog", "2026-01-16"),
            ("https://shop.example/contact", ""), ("https://shop.example/blog", ""), ("https://shop.example/faq", "2025-12-31")]
_SM_XML = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "".join(
    f"  <url><loc>{u}</loc>" + (f"<lastmod>{d}</lastmod>" if d else "") + "</url>\n" for u, d in _SM_LOCS) + "</urlset>\n"
_SM_DUPS = len(_SM_LOCS) - len({u for u, _ in _SM_LOCS})  # 2
assert (len(_SM_LOCS), _SM_DUPS) == (7, 2)


def _sitemap(c: Ctx):
    a = c.answer
    return first_error(_num(a, 7), _num(a, 2), has(a, "2026-02-30"))


# ---------------------------------------------------------------- ids (hash)
_HASH_TEXT = "invoice-2031/Zażółć#88"
_HASH = hashlib.sha256(_HASH_TEXT.encode()).hexdigest()


def _ids(c: Ctx):
    return has(c.haystack().lower(), _HASH)


# ---------------------------------------------------------------- snowflake
_SF_EPOCH = 1420070400000  # Discord epoch
_SF_TS, _SF_W, _SF_S = 1_800_000_123_456 - _SF_EPOCH, 21, 933  # 5 worker bits? Discord: 5 worker + 5 process = 10 bits


# ---------------------------------------------------------------- jwt
def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


_JWT_EXP = int(dt.datetime(2032, 7, 19, 12, 0, 0, tzinfo=dt.timezone.utc).timestamp())
_jh = _b64u(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
_jp = _b64u(json.dumps({"sub": "usr_8841c", "name": "Wanda Kowalczyk", "role": "auditor", "iat": 1893495000, "exp": _JWT_EXP},
                       separators=(",", ":")).encode())
_JWT = f"{_jh}.{_jp}." + _b64u(hmac.new(b"tr1angle-pine-77", f"{_jh}.{_jp}".encode(), hashlib.sha256).digest())


def _jwt(c: Ctx):
    a = c.answer.replace("**", "").replace("__", "")  # "Does **not** verify": markdown emphasis must not split the phrase
    neg = re.search(r"not (valid|match|verif)|invalid|does not match|doesn't match|mismatch|fail|✕|incorrect|wrong", a, re.I)
    return first_error(has(a, "usr_8841c", "auditor", "2032-07-19"),
                       None if neg else "did not report that the signature does not verify with secret tr1angle-pine-78")


# ---------------------------------------------------------------- password
_PW = "Maple#Maple#427"
_PW_BITS = len(_PW) * __import__("math").log2(len(set(_PW)))  # 47.55


def _password(c: Ctx):
    a = c.answer
    return None if re.search(r"(?<![\d.])(48|47\.[5-9]\d*)(?![\d])", a) else f"expected about {_PW_BITS:.1f} bits (48)"


# ---------------------------------------------------------------- mcp-connect
def _mcp(c: Ctx):
    o = urlparse(c.url())
    ep = f"{o.scheme}://{o.netloc}/api/mcp"
    return first_error(has(c.answer, ep), has(c.answer, "mcpServers"))


# ---------------------------------------------------------------- epoch group
_FMT = dt.datetime(2031, 3, 9, 17, 45)
_FMT_OUT = f"{_FMT.strftime('%a')} {_FMT.day} {_FMT.strftime('%b')} {_FMT.strftime('%y')}, {_FMT.hour % 12 or 12}:{_FMT.minute:02d} {'AM' if _FMT.hour < 12 else 'PM'}"
assert _FMT_OUT == "Sun 9 Mar 31, 5:45 PM"


def _secs(s):
    h, m, x = map(int, s.split(":"))
    return h * 3600 + m * 60 + x


_DUR_T = _secs("37:48:09") + _secs("15:20:55")
_DUR_OUT = f"{_DUR_T // 3600}:{_DUR_T % 3600 // 60:02d}:{_DUR_T % 60:02d}"
assert _DUR_OUT == "53:09:04"

_ISO_D = dt.date(2027, 1, 3)
_ISO_Y, _ISO_W, _ISO_WD = _ISO_D.isocalendar()
assert (_ISO_Y, _ISO_W, _ISO_WD) == (2026, 53, 7)

_DS, _DE = dt.date(2026, 2, 14), dt.date(2026, 4, 2)
_DAYS = (_DE - _DS).days + 1
_WD = [0] * 7
for _i in range(_DAYS):
    _WD[(_DS + dt.timedelta(_i)).weekday()] += 1


# ---------------------------------------------------------------- url
def _url(c: Ctx):
    return first_error(has(c.answer, "/cart?item=42&qty=3"), matches(c.answer, r"\bpl-PL\b"))


_IDN_ORIG = "café-à-côté.example"
_IDN_ASCII = _IDN_ORIG.encode("idna").decode()
assert _IDN_ASCII.encode().decode("idna") == _IDN_ORIG


# ---------------------------------------------------------------- website check (a local fixture site)
# The Website check fetches a live page on the server; outside public mode a loopback address is allowed, so each
# process that loads these cases serves its own tiny site with known gaps (one redirect, a cookie without Secure and
# SameSite, a skipped heading level, one image without alt). Answers come from this page, not from the model.
_SITE_PAGE = (b"<!doctype html><html lang=\"en\"><head><title>Coverage fixture shop</title>"
              b"<meta name=\"viewport\" content=\"width=device-width\"></head><body><main><h1>Fixture shop</h1>"
              b"<h3>Skipped a level</h3><img src=\"a.png\"><img src=\"b.png\" alt=\"Logo\"></main></body></html>")


class _SiteHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/old":
            self.send_response(301)
            self.send_header("Location", "/")
            self.end_headers()
            return
        if self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Set-Cookie", "session=abc123; Path=/; HttpOnly")
            self.end_headers()
            self.wfile.write(_SITE_PAGE)
            return
        self.send_response(404)
        self.end_headers()


_SITE = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _SiteHandler)
threading.Thread(target=_SITE.serve_forever, daemon=True).start()
_SITE_URL = f"http://127.0.0.1:{_SITE.server_address[1]}/old"


def _site_check(c: Ctx):
    low = c.answer.lower()
    return first_error(
        None if "/tools/web" in c.url() else f"the check did not run in the Web workbench (url {c.url()})",
        has(c.page_only(), "Fixture shop"),
        matches(c.answer, r"\b301\b"),
        None if "secure" in low and "samesite" in low else "the cookie's missing Secure and SameSite flags are not both named",
        matches(c.answer, r"\bh2\b|h1\s*(?:→|->|to)\s*h3|level\s*2"),
        matches(c.answer, r"\b(?:1|one)\s+(?:image|img)|(?:image|img)s?\b[^.\n]{0,40}\b(?:1|one)\b"),
    )


CASES = [
    Case("dates", "epoch", "What calendar date and time in UTC is the Unix timestamp 1700000000?",
         lambda c: first_error(
             # any common spelling of 14 Nov 2023: ISO, "November 14, 2023", "14 Nov 2023", "Tuesday, 14 November 2023"
             matches(c.haystack(), r"2023-11-14|(?<!\d)14(?:th)?\s+(?:of\s+)?Nov(?:ember)?\.?,?\s+2023|Nov(?:ember)?\.?\s+14(?:th)?,?\s+2023"),
             has(c.haystack(), "22:13:20"))),
    Case("web", "csp",
         "Write me a report-only Content-Security-Policy header. Scripts only from our own origin and https://cdn.jsdelivr.net; images from our origin and data: URIs; "
         "connections (fetch/XHR/websocket) to our origin, https://api.stripe.com and wss://live.example.net; no plugins/objects at all; and nobody may frame the page. "
         "Give me the full header line.", _csp),
    Case("web", "curl",
         "Build me a curl command (properly quoted for a POSIX shell) that does a POST to https://api.example.com/v2/customers with the header "
         "'Content-Type: application/json', the header 'X-Request-Id: 7f3a-91' and the JSON body {\"name\":\"O'Brien\",\"tier\":3}.", _curl),
    Case("web", "robots",
         "Here is our robots.txt:\n\n" + _ROBOTS + "\nMay Googlebot crawl /shop/cart/checkout? Tell me which rule decides it.", _robots),
    Case("web", "sitemap",
         "Check this sitemap:\n\n" + _SM_XML + "\nHow many entries does it list, how many redundant duplicate entries (repeat appearances of an already listed URL) are there, "
         "and which entry has an invalid last-modified date?", _sitemap),
    Case("ids", "ids",
         f"Give me the SHA-256 hash (hex) of the exact text: {_HASH_TEXT}", _ids),
    Case("ids", "jwt",
         f"Decode this JWT:\n\n{_JWT}\n\nWho is the subject, what is the role, when does it expire (UTC)? Also check the signature against the secret tr1angle-pine-78 and tell me whether it verifies.",
         _jwt),
    Case("ids", "password",
         f"Rate this password: {_PW}. Estimate its entropy in bits, but don't give credit for the full character-class pool: "
         "a password of N characters that only uses U distinct characters is worth at most N*log2(U) bits. Give the bits as a whole number.",
         _password),
    Case("mcp-connect", None,
         "I want to connect an external agent (Cursor) to the same tool service you are running on. What exact URL do I put in its MCP config? Give me the JSON snippet too.",
         _mcp),
    Case("dates", "format",
         "Format the date and time 2031-03-09 17:45 using the pattern 'ddd D MMM YY, h:mm A' (day.js style tokens, UK English).",
         lambda c: has(_dash(c.haystack()), _FMT_OUT)),
    Case("dates", "duration",
         "Add the two durations 37:48:09 and 15:20:55 (H:MM:SS, hours may pass 24). What is the total?",
         lambda c: has(c.haystack(), _DUR_OUT)),
    Case("web", "url",
         "Take this URL: https://auth.example.org/login?next=%2Fcart%3Fitem%3D42%26qty%3D3&lang=pl-PL&utm_id=x9 . "
         "What is the decoded value of the next parameter, and what is the lang value?", _url),
    Case("web", "check",
         f"Run a website check on {_SITE_URL} . What status does the first hop answer with, which flags is the session cookie "
         "missing, which heading level does the page skip, and how many images have no alt text?", _site_check),
]
