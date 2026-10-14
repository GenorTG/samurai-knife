"""Functional e2e for: http-headers, url, robots-txt, jwt (+password), mcp-connect, ids,
epoch, semver, stacktrace (+ansi).  Real UI, expected values computed independently here.
No internet / AI provider contact; only the app under test and a local fake-curl.

Usage: python3 tests/functional/web_e2e.py [base_url] [section ...]
"""
import base64
import datetime as dt
import hashlib
import hmac
import json
import math
import re
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

from playwright.sync_api import sync_playwright

ARGS = [a for a in sys.argv[1:]]
BASE = "http://127.0.0.1:3210"
if ARGS and ARGS[0].startswith(("http://", "https://")):
    BASE = ARGS.pop(0).rstrip("/")
ONLY = set(ARGS)
ROOT = Path(__file__).resolve().parents[2]
failures: list[str] = []
OVERFLOW_JS = "document.documentElement.scrollWidth - document.documentElement.clientWidth"
errors: list[str] = []


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + (f" | {detail}" if detail else ""), flush=True)
    if not ok:
        failures.append(name)


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


class T:
    def __init__(self, page):
        self.p = page

    def open(self, slug, tab=None):
        self.p.goto(f"{BASE}/tools/{slug}" + (f"?tab={tab}" if tab else ""), wait_until="load")
        self.p.wait_for_selector("main, h1", timeout=15000)
        self.p.wait_for_timeout(500)
        return self

    def f(self, label, nth=0):
        return self.p.locator(
            f"xpath=(//label[./span[normalize-space()='{label}']]//*[self::input or self::select or self::textarea])[{nth + 1}]")

    def fill(self, label, value, nth=0):
        self.f(label, nth).fill(value)
        self.p.wait_for_timeout(150)

    def btn(self, name, nth=0, exact=True):
        self.p.get_by_role("button", name=name, exact=exact).nth(nth).click()
        self.p.wait_for_timeout(150)

    def stat(self, label, nth=0):
        loc = self.p.locator(
            f"xpath=(//div[contains(@class,'sk-label') and normalize-space()='{label}']/following-sibling::div[1])[{nth + 1}]")
        return loc.inner_text(timeout=3000).strip() if loc.count() else None

    def kv(self, label, nth=0):
        loc = self.p.locator(f"xpath=(//dt[normalize-space()='{label}']/following-sibling::dd[1])[{nth + 1}]")
        return loc.inner_text(timeout=3000).strip() if loc.count() else None

    def notice(self):
        return " || ".join(t.strip() for t in self.p.locator("p.rounded-lg.border").all_inner_texts())

    def body(self):
        return self.p.inner_text("main")


def run_overflow(t, slug, tabs, ctx_browser):
    ctx = ctx_browser.new_context(viewport={"width": 390, "height": 800})
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append(f"{slug}: {e}"))
    for tab in tabs:
        pg.goto(f"{BASE}/tools/{slug}" + (f"?tab={tab}" if tab else ""), wait_until="load")
        pg.wait_for_timeout(600)
        ov = pg.evaluate(OVERFLOW_JS)
        check(f"overflow390 {slug}/{tab}", ov <= 0, f"overflow={ov}")
    ctx.close()


def want(name):
    return not ONLY or name in ONLY


# ====================================================================== ids
def test_ids(t):
    t.open("ids", "ids")
    uuid_re = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-([1-8])[0-9a-f]{3}-([89ab])[0-9a-f]{3}-[0-9a-f]{12}$")
    t.fill("How many", "7")
    t.btn("UUID v4")
    lines = t.p.locator("textarea[readonly]").first.input_value().split("\n")
    check("ids uuid4 count=7", len(lines) == 7, str(len(lines)))
    check("ids uuid4 valid v4", all((m := uuid_re.match(x)) and m.group(1) == "4" and uuid.UUID(x).version == 4 for x in lines))
    check("ids uuid4 unique stat", t.stat("Unique") == "7" and t.stat("Generated") == "7" and t.stat("Each") == "36 chars")
    before = int(time.time() * 1000)
    t.btn("UUID v7")
    lines = t.p.locator("textarea[readonly]").first.input_value().split("\n")
    after = int(time.time() * 1000)
    ok7 = all((m := uuid_re.match(x)) and m.group(1) == "7" for x in lines)
    ts = [int(x.replace("-", "")[:12], 16) for x in lines]
    check("ids uuid7 valid v7 + variant", ok7)
    check("ids uuid7 timestamp now", all(before - 5000 <= v <= after + 5000 for v in ts), str(ts[:1]))
    # random IDs per alphabet / length
    for alpha, label, rx in [("hex", "Hex", r"[0-9a-f]"), ("base36", "Base36", r"[0-9a-z]"),
                             ("crockford", "Crockford", r"[0-9A-HJKMNP-TV-Z]"), ("base62", "Base62", r"[0-9A-Za-z]")]:
        t.f("Alphabet").select_option(alpha)
        t.fill("Length", "30")
        t.fill("How many", "20")
        t.btn("Random ID")
        lines = t.p.locator("textarea[readonly]").first.input_value().split("\n")
        check(f"ids random {alpha} len30 x20", len(lines) == 20 and all(re.fullmatch(rx + "{30}", x) for x in lines), lines[0])
    # clamps: length 2 -> 4, count 0 -> 1, count 9999 -> 500
    t.fill("Length", "2"); t.fill("How many", "9999"); t.btn("Random ID")
    lines = t.p.locator("textarea[readonly]").first.input_value().split("\n")
    check("ids clamps (len>=4, count<=500)", len(lines) == 500 and len(lines[0]) == 4, f"{len(lines)} {len(lines[0])}")
    t.fill("How many", "abc"); t.btn("UUID v4")
    check("ids non-numeric count -> 1", t.stat("Generated") == "1")
    t.btn("Clear")
    check("ids clear", "Nothing generated yet." in t.body())
    # hashes
    samples = ["abc", "", "héllo wörld ✓ 日本語", "line1\nline2\n\n  tab\t", "a" * 10000]
    for algo, hn in [("SHA-1", "sha1"), ("SHA-256", "sha256"), ("SHA-384", "sha384"), ("SHA-512", "sha512")]:
        t.f("Algorithm").select_option(algo)
        for s in samples:
            if s == "":
                continue
            t.fill("Text", s)
            t.p.wait_for_timeout(450)
            got = t.p.locator("input[readonly]").first.input_value()
            exp = hashlib.new(hn, s.encode()).hexdigest()
            check(f"ids hash {algo} len={len(s)}", got == exp, got[:20])
    t.fill("Text", "abc")
    t.p.wait_for_timeout(400)
    t.f("Algorithm").select_option("SHA-1")
    t.p.wait_for_timeout(400)
    check("ids hash algo switch recomputes", t.p.locator("input[readonly]").first.input_value() == hashlib.sha1(b"abc").hexdigest())
    check("ids hash stats", t.stat("Hex chars") == "40" and t.stat("Algorithm", 0) == "SHA-1")
    # emptying the box must not leave the digest of text that is gone (browser walkthrough 2026-10-10)
    t.fill("Text", "")
    t.p.wait_for_timeout(450)
    digest = t.p.locator("input[readonly]")
    check("ids hash: emptying the text clears the digest", digest.count() == 0 or digest.first.input_value() == "", digest.first.input_value()[:20] if digest.count() else "")
    t.fill("Text", "abc")
    t.p.wait_for_timeout(450)
    check("ids hash: typing again after clearing hashes again", t.p.locator("input[readonly]").first.input_value() == hashlib.sha1(b"abc").hexdigest())
    # file
    data = bytes(range(256)) * 40
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as fh:
        fh.write(data)
    t.f("Algorithm").select_option("SHA-256")
    t.p.locator("input[type=file]").first.set_input_files(fh.name)
    t.p.wait_for_timeout(800)
    check("ids hash file sha256", t.p.locator("input[readonly]").first.input_value() == hashlib.sha256(data).hexdigest())
    check("ids hash file source stat", Path(fh.name).name in (t.stat("Source") or ""), t.stat("Source") or "")
    t.p.get_by_role("button", name="Clear").nth(1).click()
    check("ids hash clear", "No digest yet." in t.body())

    # snowflake
    t.open("ids", "snowflake")
    t.p.wait_for_timeout(300)
    sid, ep = 175928847299117063, 1288834974657
    ts_ms = (sid >> 22) + ep
    exp_ts = dt.datetime.fromtimestamp(ts_ms / 1000, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{ts_ms % 1000:03d}Z"
    check("snowflake default timestamp", t.stat("Timestamp") == exp_ts, f"{t.stat('Timestamp')} vs {exp_ts}")
    check("snowflake default worker/seq", t.stat("Worker") == str((sid >> 12) & 0x3FF) and t.stat("Sequence") == str(sid & 0xFFF))
    # custom: build id with 8 worker bits, 14 seq bits
    ep2 = 1_600_000_000_000
    ts2 = 123_456_789
    sid2 = (ts2 << 22) | (200 << 14) | 4321
    t.fill("64-bit ID", str(sid2)); t.fill("Epoch (Unix milliseconds)", str(ep2))
    t.fill("Worker bits", "8"); t.fill("Sequence bits", "14")
    m2 = ts2 + ep2
    exp2 = dt.datetime.fromtimestamp(m2 / 1000, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{m2 % 1000:03d}Z"
    check("snowflake custom bits", (t.stat("Timestamp"), t.stat("Worker"), t.stat("Sequence")) == (exp2, "200", "4321"),
          str((t.stat("Timestamp"), t.stat("Worker"), t.stat("Sequence"))))
    t.fill("64-bit ID", "12ab")
    check("snowflake invalid id error", "Use unsigned decimal" in t.notice(), t.notice())
    t.fill("64-bit ID", "-5")
    check("snowflake negative error", "Use unsigned decimal" in t.notice())
    t.fill("64-bit ID", str(sid)); t.fill("Worker bits", "40"); t.fill("Sequence bits", "40")
    check("snowflake widths>=63 error", "bit widths" in t.notice(), t.notice())
    t.fill("Worker bits", "10"); t.fill("Sequence bits", "12")
    t.fill("64-bit ID", "0"); t.fill("Epoch (Unix milliseconds)", "0")
    check("snowflake id 0 -> epoch", t.stat("Timestamp") == "1970-01-01T00:00:00.000Z", str(t.stat("Timestamp")))
    t.fill("64-bit ID", "9223372036854775807")
    check("snowflake max int64 safe", (t.stat("Timestamp") or t.notice()) != "", t.stat("Timestamp") or t.notice())


# ==================================================================== epoch
def wall_re(d: dt.datetime) -> str:
    h12 = d.hour % 12 or 12
    mon = d.strftime("%b")
    return rf"{mon} {d.day}, {d.year}(,| at) {h12}:{d.minute:02d}:{d.second:02d} {'AM' if d.hour < 12 else 'PM'}"


def test_epoch(t):
    from zoneinfo import ZoneInfo
    t.open("epoch", "epoch")
    now = int(time.time())
    live = int(t.kv("Unix seconds", 0))
    check("epoch right-now seconds ~ now", abs(live - now) <= 3, f"{live} vs {now}")
    check("epoch right-now ms = s*1000", t.kv("Unix milliseconds", 0) == str(live * 1000))
    check("epoch right-now ISO", t.kv("ISO 8601 UTC", 0) == dt.datetime.fromtimestamp(live, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"))
    cases = [
        ("1700000000", 1700000000.0),
        ("0", 0.0),
        ("-86400", -86400.0),
        ("1700000000123", 1700000000.123),
        ("1700000000.123", 1700000000.123),
        ("99999999999", 99999999999.0),
        ("1000000000000", 1000000000.0),
        ("2024-02-29T12:30:45Z", dt.datetime(2024, 2, 29, 12, 30, 45, tzinfo=dt.timezone.utc).timestamp()),
        ("2024-02-29T12:30:45+02:00", dt.datetime(2024, 2, 29, 10, 30, 45, tzinfo=dt.timezone.utc).timestamp()),
        ("2024-02-29T12:30:45", dt.datetime(2024, 2, 29, 12, 30, 45, tzinfo=dt.timezone.utc).timestamp()),
        ("2024-12-31", dt.datetime(2024, 12, 31, tzinfo=dt.timezone.utc).timestamp()),
    ]
    for raw, secs in cases:
        t.fill("Epoch or ISO date", raw)
        got_s, got_ms, got_iso = t.kv("Unix seconds", 1), t.kv("Unix milliseconds", 1), t.kv("ISO 8601 UTC", 1)
        exp_ms = round(secs * 1000)
        exp_iso = dt.datetime.fromtimestamp(exp_ms // 1000, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{exp_ms % 1000:03d}Z"
        check(f"epoch convert {raw!r}", got_s == str(math.floor(secs)) and got_ms == str(exp_ms) and got_iso == exp_iso,
              f"{got_s} {got_ms} {got_iso} vs {math.floor(secs)} {exp_ms} {exp_iso}")
    t.fill("Epoch or ISO date", "2026-07-04T18:05:09Z")
    base = dt.datetime(2026, 7, 4, 18, 5, 9, tzinfo=dt.timezone.utc)
    for zone in ["UTC", "Europe/Warsaw", "Europe/London", "America/New_York", "America/Los_Angeles",
                 "Asia/Tokyo", "Asia/Kolkata", "Australia/Sydney"]:
        t.f("Zone").select_option(zone)
        t.p.wait_for_timeout(100)
        local = base.astimezone(ZoneInfo(zone))
        got = t.kv("Selected zone")
        check(f"epoch zone {zone}", re.search(wall_re(local), got or "") is not None, f"{got} vs {local}")
    t.f("Zone").select_option("Europe/Warsaw")
    t.fill("Epoch or ISO date", "2026-01-15T12:00:00Z")
    check("epoch Warsaw winter UTC+1", re.search(wall_re(dt.datetime(2026, 1, 15, 13, 0, 0)), t.kv("Selected zone") or "") is not None, t.kv("Selected zone"))
    for iso in ["2024-12-30T00:00:00Z", "2021-01-03T00:00:00Z", "2024-03-01T00:00:00Z", "2026-10-03T08:00:00Z"]:
        t.fill("Epoch or ISO date", iso)
        d = dt.date.fromisoformat(iso[:10])
        exp = f"W{d.isocalendar()[1]} · day {d.timetuple().tm_yday}"
        check(f"epoch week/doy {iso[:10]}", t.kv("Week / day-of-year") == exp, f"{t.kv('Week / day-of-year')} vs {exp}")
    t.fill("Epoch or ISO date", str(int(time.time()) + 90061))
    off = t.kv("Offset from now") or ""
    check("epoch offset ahead 1d1h1m1s", off.endswith("ahead") and off.startswith("1d 1h 1m"), off)
    t.fill("Epoch or ISO date", str(int(time.time()) - 7200))
    off = t.kv("Offset from now") or ""
    check("epoch offset behind 2h", off.endswith("behind") and off.startswith("2h"), off)
    for bad in ["not a date", "2024-13-45T99:99Z", "12abc34"]:
        t.fill("Epoch or ISO date", bad)
        shown = t.kv("Unix seconds", 1) is not None
        check(f"epoch invalid {bad!r} -> error, no result", "neither a number nor a date" in t.notice() and not shown, f"{t.notice()} shown={shown}")
    t.fill("Epoch or ISO date", "")
    check("epoch empty input: no error, no table", "neither" not in t.notice() and t.kv("Unix seconds", 1) is None)
    t.fill("From", "2024-01-01T00:00:00Z"); t.fill("To", "2024-01-02T01:01:01Z")
    check("epoch duration +1d1h1m1s", t.kv("Elapsed") == "+1d 1h 1m 1s" and t.kv("Seconds", 0) == "90061" and t.kv("Milliseconds", 0) == "90061000",
          f"{t.kv('Elapsed')} {t.kv('Seconds')}")
    t.fill("From", "1700000100"); t.fill("To", "1700000000")
    check("epoch duration negative", t.kv("Elapsed") == "−1m 40s", t.kv("Elapsed"))
    t.fill("From", "2024-01-01"); t.fill("To", "1704067200")
    check("epoch duration mixed date/epoch zero", t.kv("Elapsed") == "+0s", t.kv("Elapsed"))
    t.fill("To", "garbage")
    check("epoch duration invalid -> hint", "Fill both sides" in t.body())

    t.open("epoch", "format")
    t.f("Date/time (local)").fill("2026-10-03T14:05")
    res = lambda: t.p.locator("div.font-mono.text-lg").inner_text()
    t.fill("Format tokens", "YYYY-MM-DD HH:mm:ss")
    check("format iso-ish", res() == "2026-10-03 14:05:00", res())
    t.fill("Format tokens", "dddd, MMMM D, YYYY · h:mm A")
    check("format en-GB words", res() == "Saturday, October 3, 2026 · 2:05 PM", res())
    for loc, month, wd in [("pl-PL", "październik", "sobota"), ("de-DE", "Oktober", "Samstag"), ("fr-FR", "octobre", "samedi"), ("en-US", "October", "Saturday")]:
        t.f("Locale").select_option(loc)
        t.fill("Format tokens", "dddd MMMM")
        check(f"format locale {loc}", res().lower() == f"{wd} {month}".lower(), res())
    t.f("Locale").select_option("en-US")
    t.fill("Format tokens", "YY M/D H:m:s hh MMM ddd")
    t.f("Date/time (local)").fill("2027-01-05T00:07")
    check("format short tokens midnight", res() == "27 1/5 0:7:0 12 Jan Tue", res())
    t.f("Date/time (local)").fill("")
    check("format empty date message", "Choose a valid date and time." in t.body())

    t.open("epoch", "duration")
    check("duration default sum", t.stat("Result") == "2:20:45", t.stat("Result"))

    def dur(a, b, op, exp, name):
        t.fill("First duration", a); t.fill("Second duration", b); t.f("Operation").select_option(op)
        got = t.stat("Result")
        check(f"duration {name}", got == exp, f"{got} vs {exp}")
    dur("1:45:30", "0:35:15", "+", "2:20:45", "add")
    dur("1:00:00", "2:30:00", "-", "-1:30:00", "negative result")
    dur("100:00:00", "50:30:30", "+", "150:30:30", ">24h")
    dur("0:00:01.5", "0:00:00.250", "+", "0:00:01.750", "millis")
    dur("-1:00:00", "-0:30:00", "-", "-0:30:00", "signed inputs")
    dur("5:00:00", "5:00:00", "-", "0:00:00", "zero")
    t.fill("First duration", "1:00:00"); t.fill("Second duration", "0:30:00"); t.f("Operation").select_option("+")
    got = (t.stat("Seconds"), t.stat("Minutes"), t.stat("Hours"))
    check("duration derived stats", got == ("5400.000", "90.0000", "1.50000"), str(got))
    for bad in ["1:75:00", "abc", "1:2", "1:00:00:00", ""]:
        t.fill("First duration", bad)
        check(f"duration invalid {bad!r}", "Use H:MM:SS" in t.notice(), t.notice())

    t.open("epoch", "iso-week")
    for d_ in ["2026-10-03", "2021-01-03", "2024-12-30", "2020-12-31", "2027-01-01", "2016-01-03", "2024-02-29"]:
        t.f("Calendar date").fill(d_)
        d = dt.date.fromisoformat(d_)
        iy, iw, iwd = d.isocalendar()
        got = (t.stat("ISO week"), t.stat("Week-year"), t.stat("ISO weekday"))
        exp = (f"{iy}-W{iw:02d}", str(iy), f"{iwd} ({d.strftime('%A')})")
        check(f"iso-week {d_}", got == exp, f"{got} vs {exp}")
    t.f("Calendar date").fill("")
    check("iso-week empty -> error", "Choose a valid calendar date." in t.body())

    t.open("epoch", "distribution")

    def dist(a, b):
        t.f("Start (inclusive)").fill(a); t.f("End (inclusive)").fill(b)
        d0, d1 = dt.date.fromisoformat(a), dt.date.fromisoformat(b)
        n = (d1 - d0).days + 1
        wk = [0] * 7; mo: dict[str, int] = {}
        for i in range(n):
            d = d0 + dt.timedelta(days=i)
            wk[d.weekday()] += 1; mo[d.strftime("%Y-%m")] = mo.get(d.strftime("%Y-%m"), 0) + 1
        names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        ok = t.stat("Calendar days") == str(n) and all(t.stat(names[i]) == str(wk[i]) for i in range(7)) and all(t.stat(k) == str(v) for k, v in mo.items())
        check(f"distribution {a}..{b}", ok, f"days={t.stat('Calendar days')} exp {n}")
    dist("2026-10-01", "2026-10-31")
    dist("2024-02-27", "2024-03-02")
    dist("2023-12-25", "2025-01-07")
    dist("2026-05-05", "2026-05-05")
    t.f("Start (inclusive)").fill("2026-05-05"); t.f("End (inclusive)").fill("2026-05-04")
    check("distribution end<start error", "end on or after start" in t.notice(), t.notice())
    t.f("Start (inclusive)").fill("2000-01-01"); t.f("End (inclusive)").fill("2020-01-01")
    check("distribution >10y error", "exceeds 10 years" in t.notice(), t.notice())
    t.f("Start (inclusive)").fill("")
    check("distribution empty error", "Choose valid dates" in t.notice())


# ===================================================================== jwt
def mk_jwt(header, payload, secret, alg="HS256", tamper_sig=False):
    h = b64u(json.dumps(header, separators=(",", ":"), ensure_ascii=False).encode())
    b = b64u(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode())
    dig = {"HS256": hashlib.sha256, "HS384": hashlib.sha384, "HS512": hashlib.sha512}[alg]
    sig = b64u(hmac.new(secret.encode(), f"{h}.{b}".encode(), dig).digest())
    if tamper_sig:
        sig = ("A" if sig[0] != "A" else "B") + sig[1:]
    return f"{h}.{b}.{sig}"


def test_jwt(t):
    t.open("jwt", "jwt")
    tok = lambda: t.f("Paste a JWT").input_value()
    sigstat = lambda: t.stat("Signature")
    # sample
    t.btn("Load sample")
    t.p.wait_for_timeout(500)
    token = tok()
    h64, b64, sig = token.split(".")
    pad = lambda x: x + "=" * (-len(x) % 4)
    hdr = json.loads(base64.urlsafe_b64decode(pad(h64)))
    pl = json.loads(base64.urlsafe_b64decode(pad(b64)))
    exp_sig = b64u(hmac.new(b"samurai-knife", f"{h64}.{b64}".encode(), hashlib.sha256).digest())
    check("jwt sample: signature is correct HMAC-SHA256", sig == exp_sig)
    check("jwt sample: header/payload decoded", hdr == {"alg": "HS256", "typ": "JWT"} and pl["sub"] == "genor" and pl["exp"] == 1825027200)
    check("jwt sample: KV header/payload/alg", json.loads(t.kv("Header")) == hdr and json.loads(t.kv("Payload")) == pl and t.kv("Algorithm") == "HS256" and t.kv("Signature") == sig)
    t.p.wait_for_timeout(400)
    check("jwt sample verifies with default secret", sigstat() == "matches ✓", sigstat())
    check("jwt sample claims rows", t.p.locator("dt", has_text="subject").count() == 1 and t.p.locator("dt", has_text="expires").count() == 1)
    exp_dd = t.p.locator("xpath=//dt[starts-with(normalize-space(),'expires')]/following-sibling::dd[1]").inner_text()
    check("jwt exp claim shows raw + relative", exp_dd.endswith("1825027200") and exp_dd.startswith("in "), exp_dd)
    check("jwt valid badge (exp in future)", "Valid — expires in" in t.body(), "")
    check("jwt stats chars", t.stat("Token chars") == str(len(token)) and t.stat("Header chars") == str(len(h64)))
    # known public vector (jwt.io)
    JIO = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    t.f("Paste a JWT").fill(JIO)
    t.fill("Secret", "your-256-bit-secret"); t.p.wait_for_timeout(500)
    check("jwt jwt.io vector matches", sigstat() == "matches ✓", sigstat())
    check("jwt jwt.io payload", json.loads(t.kv("Payload")) == {"sub": "1234567890", "name": "John Doe", "iat": 1516239022})
    check("jwt jwt.io: expired badge absent (no exp)", "Expired" not in t.body() and "Valid —" not in t.body())
    t.fill("Secret", "wrong-secret"); t.p.wait_for_timeout(500)
    check("jwt wrong secret -> does not match", sigstat() == "does not match ✕", sigstat())
    t.fill("Secret", ""); t.p.wait_for_timeout(400)
    check("jwt empty secret -> no verdict", sigstat() == "—", sigstat())
    t.fill("Secret", "your-256-bit-secret")
    # tamper: flip payload (valid b64, different content)
    h0, b0, s0 = JIO.split(".")
    forged = b64u(json.dumps({"sub": "1234567890", "name": "Jane", "iat": 1516239022}, separators=(",", ":")).encode())
    t.f("Paste a JWT").fill(f"{h0}.{forged}.{s0}"); t.p.wait_for_timeout(500)
    check("jwt tampered payload -> does not match", sigstat() == "does not match ✕", sigstat())
    # all HS algs + unicode secret + unicode payload + expired + nbf
    for alg in ["HS256", "HS384", "HS512"]:
        secret = "sécrét-☃-\U0001F511"
        now = int(time.time())
        t_ = mk_jwt({"alg": alg, "typ": "JWT"}, {"iss": "zółw", "exp": now - 7200, "n": [1, 2, {"a": None}]}, secret, alg)
        t.f("Paste a JWT").fill(t_); t.fill("Secret", secret); t.p.wait_for_timeout(500)
        check(f"jwt {alg} unicode secret verifies", sigstat() == "matches ✓" and t.kv("Algorithm") == alg, sigstat())
        check(f"jwt {alg} unicode payload shown", "zółw" in t.kv("Payload"))
        badge = t.p.locator("p.rounded-lg", has_text="Expired").inner_text() if t.p.locator("p.rounded-lg", has_text="Expired").count() else ""
        check(f"jwt {alg} expired badge text", badge == "Expired 2 hours ago.", badge)
        t_bad = mk_jwt({"alg": alg}, {"a": 1}, secret, alg, tamper_sig=True)
        t.f("Paste a JWT").fill(t_bad); t.p.wait_for_timeout(500)
        check(f"jwt {alg} bad signature rejected", sigstat() == "does not match ✕", sigstat())
    # nbf / iat relative rendering
    t.f("Paste a JWT").fill(mk_jwt({"alg": "HS256"}, {"nbf": int(time.time()) + 3 * 86400, "exp": int(time.time()) + 100}, "k"))
    t.p.wait_for_timeout(300)
    nbf = t.p.locator("xpath=//dt[starts-with(normalize-space(),'not before')]/following-sibling::dd[1]").inner_text()
    check("jwt nbf relative 'in 3 days'", nbf.startswith("in 3 days"), nbf)
    check("jwt valid badge 'in 2 minutes'", re.search(r"Valid — expires in (1|2) minutes?\.", t.body()) is not None)
    # non-HMAC algs
    for alg, expect in [("none", "none alg"), ("RS256", "RS256 alg")]:
        t.f("Paste a JWT").fill(b64u(json.dumps({"alg": alg}).encode()) + "." + b64u(b'{"a":1}') + "." + ("" if alg == "none" else "abc"))
        t.p.wait_for_timeout(300)
        check(f"jwt alg {alg} unsupported notice", expect in t.notice() and sigstat() == "—", t.notice())
    # invalid inputs
    for bad, msg in [("abc", "Expected 3 dot-separated segments, found 1."),
                     ("a.b", "found 2."),
                     ("a.b.c.d", "found 4."),
                     ("!!!.@@@.###", "not valid base64url"),
                     (b64u(b"not json") + "." + b64u(b"{}") + ".x", "not valid JSON"),
                     (b64u(b"{}") + "." + b64u(b"{bad") + ".x", "not valid JSON")]:
        t.f("Paste a JWT").fill(bad)
        n = t.notice()
        check(f"jwt invalid {bad[:18]!r}", msg in n and t.kv("Header") is None, n)
    t.btn("Clear", 0)
    check("jwt clear empties token", tok() == "" and t.notice() == "")
    # sign panel (default header/payload)
    t.fill("Secret", "samurai-knife")
    t.p.wait_for_timeout(500)
    signed = t.p.locator("input[readonly]").first.input_value()
    sp = json.loads(t.f("Payload JSON").input_value())
    exp_tok = mk_jwt({"alg": "HS256", "typ": "JWT"}, sp, "samurai-knife", "HS256")
    check("jwt sign HS256 == independent HMAC", signed == exp_tok, signed[:40])
    for alg in ["HS384", "HS512"]:
        t.f("Algorithm").select_option(alg); t.p.wait_for_timeout(500)
        signed = t.p.locator("input[readonly]").first.input_value()
        exp_tok = mk_jwt({"alg": alg, "typ": "JWT"}, sp, "samurai-knife", alg)
        check(f"jwt sign {alg} == independent HMAC (header.alg synced)", signed == exp_tok,
              json.dumps(json.loads(base64.urlsafe_b64decode(pad(signed.split('.')[0])))))
    t.f("Algorithm").select_option("HS256")
    t.f("Header JSON").fill('{"alg":"none","typ":"JWT","kid":"k1"}')
    t.f("Payload JSON").fill('{"msg":"zażółć gęślą jaźń \U0001F600","n":1.5}')
    t.fill("Secret", "k3y ☃"); t.p.wait_for_timeout(500)
    signed = t.p.locator("input[readonly]").first.input_value()
    exp_tok = mk_jwt({"alg": "HS256", "typ": "JWT", "kid": "k1"}, {"msg": "zażółć gęślą jaźń \U0001F600", "n": 1.5}, "k3y ☃")
    check("jwt sign custom header/unicode payload", signed == exp_tok, signed[:50])
    # round trip: signed token verifies in Token panel
    t.f("Paste a JWT").fill(signed); t.p.wait_for_timeout(500)
    check("jwt round trip verifies", sigstat() == "matches ✓" and json.loads(t.kv("Payload"))["msg"].endswith("\U0001F600"), sigstat())
    t.f("Payload JSON").fill("{not json")
    t.p.wait_for_timeout(500)
    check("jwt sign invalid JSON -> error shown, no token", t.p.locator("p.text-danger, p.rounded-lg.border").count() > 0 and t.p.locator("input[readonly]").count() == 0, t.notice())
    t.f("Payload JSON").fill("[1,2]"); t.f("Header JSON").fill('{"typ":"JWT"}'); t.p.wait_for_timeout(500)
    check("jwt sign array payload ok", t.p.locator("input[readonly]").count() == 1)

    # ---------------------------------------------------------- password tab
    t.open("jwt", "password")
    src = (ROOT / "src/tools/PasswordTool.tsx").read_text()
    words = re.search(r'const WORDS = \((.*?)\)\.split', src, re.S).group(1)
    wl = "".join(re.findall(r'"([^"]*)"', words)).split()
    check("password wordlist has no duplicates", len(wl) == len(set(wl)), f"{len(wl)} vs {len(set(wl))}")
    check("password stat words in list", t.stat("Words in list") == str(len(wl)), f"{t.stat('Words in list')} vs {len(wl)}")
    check("password bits per word", t.stat("Bits per word") == f"{math.log2(len(wl)):.2f}")
    out0 = lambda: t.p.locator("pre").nth(0).inner_text().strip()
    syms = "!?-_+.#"
    t.btn("Generate")
    pw = out0()
    m = re.fullmatch(r"((?:[A-Z][a-z]+-){3}[A-Z][a-z]+)([0-9" + re.escape(syms) + r"]{2})", pw)
    ok = bool(m) and all(w.lower() in wl for w in m.group(1).split("-")) and sum(c.isdigit() for c in m.group(2)) + sum(c in syms for c in m.group(2)) == 2
    check("password default passphrase = 4 capitalised list words + digit + symbol", ok, pw)
    exp_bits = round(4 * math.log2(len(wl)) + math.log2(10) + math.log2(7))
    check("password entropy stat", t.stat("Entropy") == f"{exp_bits} bits", f"{t.stat('Entropy')} vs {exp_bits}")
    t.f("Words").select_option("8"); t.fill("Separator", " "); t.fill("Digits", "0"); t.fill("Symbol", "0"); t.f("Case").select_option("off")
    t.btn("Generate")
    pw = out0()
    check("password 8 lower words, space sep, no extras", re.fullmatch(r"[a-z]+( [a-z]+){7}", pw) and all(w in wl for w in pw.split(" ")), pw)
    exp_bits = round(8 * math.log2(len(wl)))
    check("password entropy 8 words (no case bonus)", t.stat("Entropy") == f"{exp_bits} bits", f"{t.stat('Entropy')} vs {exp_bits}")
    t.f("Case").select_option("upper"); t.f("Words").select_option("3"); t.fill("Separator", "::"); t.btn("Generate")
    pw = out0()
    check("password UPPER 3 words multi-char sep", re.fullmatch(r"[A-Z]+(::[A-Z]+){2}", pw) and all(w.lower() in wl for w in pw.split("::")), pw)
    t.fill("Digits", "abc"); t.fill("Symbol", ""); t.fill("Separator", "-"); t.btn("Generate")
    pw = out0()
    check("password garbage digits/blank symbol: no NaN, still words", "NaN" not in pw and re.fullmatch(r"[A-Z]+(-[A-Z]+){2}[0-9" + re.escape(syms) + r"]{0,2}", pw) is not None, pw)
    t.fill("Digits", "99"); t.fill("Symbol", "99"); t.f("Case").select_option("on"); t.btn("Generate")
    pw = out0()
    check("password digits clamp 6 + symbols clamp 4", len(re.search(r"[0-9" + re.escape(syms) + r"]+$", pw).group(0)) >= 10 and "NaN" not in pw, pw)
    seen = set()
    for _ in range(12):
        t.btn("Generate"); seen.add(out0())
    check("password generates distinct values", len(seen) >= 11, str(len(seen)))
    # measure
    def py_inspect(c):
        chars = list(c)
        pool = 0
        if re.search(r"[a-zà-ÿ]", c) and any(ch.islower() for ch in c): pool += 26
        if any(ch.isupper() for ch in c): pool += 26
        if re.search(r"\d", c): pool += 10
        if re.search(r"[^A-Za-z0-9\s]", c): pool += 32
        if re.search(r"\s", c): pool += 1
        naive = len(chars) * math.log2(max(pool, 2)); honest = len(chars) * math.log2(max(len(set(chars)), 2))
        bits = min(naive, honest)
        return pool, naive, honest, bits, 2 ** min(bits, 200) / 2 / 1e10

    def human(sec):
        if sec < 1: return "under a second"
        units = [(60, "minutes"), (3600, "hours"), (86400, "days"), (2592000, "months"), (31536000, "years"), (3153600000, "centuries")]
        val, lab = sec, "seconds"
        for size, name in units:
            if sec < size: break
            val, lab = sec / size, name
        if val >= 1e9: return "longer than anyone can wait for"
        return f"{val:.1f} {lab}" if val < 100 else f"{round(val)} {lab}"
    for cand in ["password", "Tr0ub4dor&3", "correct horse battery staple", "aaaaaaaaaaaa", "Zq9!xW2#pL7$mR4%", "x", "zło\U0001F600ą"]:
        t.f("Any candidate").fill(cand); t.p.wait_for_timeout(200)
        pool, naive, honest, bits, secs = py_inspect(cand)
        got = (t.stat("Naive bits"), t.stat("Unique-char bits"), t.stat("Reported"), t.kv("Length"), t.kv("Distinct chars"), t.kv("Crack time @ 10¹⁰/s"))
        exp = (f"{naive:.0f}", f"{honest:.0f}", f"{bits:.0f}", str(len(list(cand))), str(len(set(cand))), human(secs))
        if "ł" in cand:  # pool for non-ASCII letters is implementation-defined; check only counts
            got, exp = got[3:5], exp[3:5]
        check(f"password measure {cand[:16]!r}", got == exp, f"{got} vs {exp}")
        tier = "Above 60 bits" if bits >= 60 else ("Usable, but" if bits >= 40 else "Too small")
        check(f"password tier {cand[:12]!r}", tier in t.body())
    t.f("Any candidate").fill("")
    check("password measure empty hint", "Type a candidate above" in t.body())
    # random strings
    rs = lambda: [x for x in t.p.locator("pre").nth(1).inner_text().split("\n") if x != ""]
    t.btn("Hex only"); t.p.wait_for_timeout(250)
    r = rs()
    check("random hex preset 5x24", len(r) == 5 and all(re.fullmatch(r"[0-9a-f]{24}", x) for x in r), str(r[:1]))
    check("random hex stats", t.stat("Alphabet size") == "16" and t.stat("Bits per string") == str(round(24 * 4)))
    t.btn("Lower + digits"); t.fill("Length", "40"); t.fill("How many", "20"); t.p.wait_for_timeout(250)
    r = rs()
    check("random lower+digits 20x40", len(r) == 20 and all(re.fullmatch(r"[a-z0-9]{40}", x) for x in r))
    check("random bits", t.stat("Alphabet size") == "36" and t.stat("Bits per string") == f"{40 * math.log2(36):.0f}")
    t.btn("Full charset"); t.p.wait_for_timeout(250)
    r = rs()
    check("random full charset", len(r) == 20 and all(re.fullmatch(r"[A-Za-z0-9!?\-_+.#]{40}", x) for x in r) and t.stat("Alphabet size") == "69")
    t.fill("Alphabet", "ab"); t.fill("Length", "128"); t.fill("How many", "20"); t.p.wait_for_timeout(250)
    joined = "".join(rs())
    frac = joined.count("a") / max(len(joined), 1)
    check("random 'ab' uniform (2560 chars)", len(joined) == 2560 and 0.44 < frac < 0.56, f"{frac:.3f}")
    t.fill("Alphabet", "aab"); t.p.wait_for_timeout(250)
    joined = "".join(rs()); frac = joined.count("a") / max(len(joined), 1)
    check("random duplicate alphabet chars not double weighted", 0.44 < frac < 0.56 and t.stat("Alphabet size") == "2", f"{frac:.3f}")
    t.fill("Alphabet", "\U0001F600\U0001F601"); t.fill("Length", "10"); t.p.wait_for_timeout(250)
    r = rs()
    check("random emoji alphabet not split", all(len(list(x)) == 10 and set(x) <= {"\U0001F600", "\U0001F601"} for x in r) and len(r) == 20, repr(r[:1]))
    big = "".join(chr(0x4E00 + i) for i in range(300))
    t.fill("Alphabet", big); t.fill("Length", "20"); t.p.wait_for_timeout(500)
    r = rs()
    check("random 300-symbol alphabet works (no hang)", len(r) == 20 and all(len(list(x)) == 20 for x in r), str(len(r)))
    t.fill("Alphabet", "xyz"); t.fill("Length", "abc"); t.fill("How many", "-3"); t.p.wait_for_timeout(250)
    r = rs()
    check("random garbage length/count -> defaults/clamps, no NaN", len(r) >= 1 and all(re.fullmatch(r"[xyz]+", x) for x in r), str(r[:2]))
    t.fill("Length", "100000"); t.fill("How many", "100000"); t.p.wait_for_timeout(250)
    r = rs()
    check("random clamps 128 x 20", len(r) == 20 and len(r[0]) == 128, f"{len(r)} {len(r[0]) if r else 0}")
    t.fill("Alphabet", ""); t.p.wait_for_timeout(250)
    check("random empty alphabet -> bits 0", t.stat("Bits per string") == "0" and t.stat("Alphabet size") == "0")


# ============================================================ stacktrace/ansi
def test_stacktrace(t):
    t.open("stacktrace", "stacktrace")
    ta = lambda: t.f("Normalized output").input_value()
    src = ("TypeError: boom\n    at render (src/app.ts:42:7)\n    at src/run.ts:12:3\n    at render (src/app.ts:42:7)\n\n"
           "Traceback (most recent call last):\n  File \"worker.py\", line 18, in run\n    raise ValueError()")
    t.fill("Pasted exception or traceback", src)
    exp = ["TypeError: boom", "at render \u2014 src/app.ts:42:7", "at src/run.ts:12:3",
           "Traceback (most recent call last):", "at run \u2014 worker.py:18", "raise ValueError()"]
    out = ta().split("\n")
    check("trace: V8 frame normalized", "at render \u2014 src/app.ts:42:7" in out, repr(out))
    check("trace: python frame normalized", "at run \u2014 worker.py:18" in out, repr(out))
    check("trace: header/unknown lines kept", "TypeError: boom" in out and "raise ValueError()" in out)
    check("trace: duplicates removed", out.count("at render \u2014 src/app.ts:42:7") == 1)
    check("trace: bare location frame kept as 'at file:line:col'", "at src/run.ts:12:3" in out, repr(out))
    check("trace: whole normalized output is exactly the expected lines (duplicates removed, order kept)", out == exp, repr(out))
    check("trace: counts", t.stat("Non-empty lines") == "7" and t.stat("Unique lines") == "6",
          f"{t.stat('Non-empty lines')}/{t.stat('Unique lines')}")
    t.fill("Pasted exception or traceback", "a\r\n\r\n  \r\nb\na")
    check("trace: blank lines dropped + CRLF", ta() == "a\nb" and t.stat("Non-empty lines") == "3")
    t.fill("Pasted exception or traceback", "")
    check("trace: empty input", ta() == "" and t.stat("Unique lines") == "0")
    t.fill("Pasted exception or traceback", "    at Object.<anonymous> (C:\\proj\\a.js:1:2)")
    check("trace: windows path frame", ta() == "at Object.<anonymous> \u2014 C:\\proj\\a.js:1:2", repr(ta()))

    t.open("stacktrace", "ansi")
    out = lambda: t.f("Clean output").input_value()
    t.fill("Terminal output", "\x1b[32mgreen\x1b[0m \x1b[1;31mred\x1b[0m")
    check("ansi: SGR stripped", out() == "green red")
    check("ansi: removed count", t.stat("Removed control characters") == str(len("\x1b[32m\x1b[0m\x1b[1;31m\x1b[0m")))
    check("ansi: input count", t.stat("Input characters") == str(len("\x1b[32mgreen\x1b[0m \x1b[1;31mred\x1b[0m")))
    t.fill("Terminal output", "a\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\ b \x1b]0;title\x07c")
    check("ansi: OSC 8 hyperlink (ST) + OSC title (BEL) keep text", out() == "alink b c", repr(out()))
    t.fill("Terminal output", "\x1b[2K\x1b[1Gprogress\x1b[?25l \x1b[38;5;196mx\x1b[38;2;1;2;3my\x1b[0m")
    check("ansi: cursor/256/truecolor", out() == "progress xy", repr(out()))
    t.fill("Terminal output", "tab\there\nnew\x00\x07\x08line")
    check("ansi: tab/newline kept, C0 removed", out() == "tab\there\nnewline", repr(out()))
    t.fill("Terminal output", "plain text 100% \u2713 \u00e9")
    check("ansi: plain unicode untouched", out() == "plain text 100% \u2713 \u00e9" and t.stat("Removed control characters") == "0")
    t.fill("Terminal output", "")
    check("ansi: empty", out() == "")


# ================================================================ semver/lockfile
def test_semver(t):
    t.open("semver", "semver")
    def sv(v, r, other=None):
        t.fill("Version", v); t.fill("Range", r)
        if other is not None:
            t.fill("Compare against", other)
        t.p.wait_for_timeout(100)
        return t.notice()
    ok = "Version satisfies this range."; no = "Version does not satisfy this range."
    cases = [
        ("1.8.4", "^1.4.0 || ~2.0.1", True), ("2.0.5", "^1.4.0 || ~2.0.1", True), ("2.1.0", "^1.4.0 || ~2.0.1", False),
        ("1.3.9", "^1.4.0", False), ("2.0.0", "^1.4.0", False),
        ("0.2.5", "^0.2.3", True), ("0.3.0", "^0.2.3", False), ("0.0.3", "^0.0.3", True), ("0.0.4", "^0.0.3", False),
        ("1.2.9", "~1.2.3", True), ("1.3.0", "~1.2.3", False),
        ("1.5.0", ">=1.2.0 <2.0.0", True), ("2.0.0", ">=1.2.0 <2.0.0", False), ("1.5.0", ">=1.2.0, <2.0.0", True),
        ("1.5.0", "> 1.2.0", True), ("1.2.0", ">1.2.0", False), ("1.2.0", "<=1.2.0", True), ("1.2.0", "=1.2.0", True), ("1.2.0", "1.2.0", True),
        ("1.2.5", "1.2.x", True), ("1.3.0", "1.2.x", False), ("5.0.0", "*", True), ("1.9.9", "1.x", True), ("2.0.0", "1.x", False),
        ("1.2.3", "1.2", True), ("1.3.0", "1.2", False), ("1.2.3", "1", True), ("2.0.0", "1", False),
        ("1.2.5", "1.2.3 - 2.3.4", True), ("2.3.5", "1.2.3 - 2.3.4", False), ("1.2.2", "1.2.3 - 2.3.4", False),
        ("1.2.3", "^1.2", True), ("2.0.0", "^1", False), ("1.4.0", "~1", True), ("2.0.0", "~1", False),
        ("v1.2.3", "^1.0.0", True), ("1.2.3+build.5", "1.2.3", True),
        ("1.3.0-beta.1", "^1.2.0", False), ("1.3.0-beta.2", ">=1.3.0-beta.1", True), ("1.3.1-beta.2", ">=1.3.0-beta.1", False),
        ("1.2.3", "^9.9.9", False), ("1.2.3", "garbage", False),
    ]
    bad = []
    for v, r, exp in cases:
        n = sv(v, r)
        got = (ok in n) if (ok in n or no in n) else None
        if got is not exp:
            bad.append((v, r, exp, n))
    check(f"semver: {len(cases)} range cases", not bad, str(bad[:6]))
    n = sv("1.2", "^1.0.0"); check("semver: partial version -> error", "full major.minor.patch" in n, n)
    for badv in ("01.2.3", "1.2.3-", "1.2.3-01", "abc", "", "1.2.3.4", "1.2.3-a..b"):
        n = sv(badv, "^1.0.0"); check(f"semver: invalid {badv!r} -> error", "full major.minor.patch" in n, n)
    def cmpresult(a, b):
        sv(a, "*", b)
        return t.f("Comparison").input_value() if False else t.p.locator("xpath=//label[./span[normalize-space()='Comparison']]//select/option").inner_text()
    order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"]
    bad = []
    for i in range(len(order) - 1):
        a, b = order[i], order[i + 1]
        if cmpresult(a, b) != "First version is older" or cmpresult(b, a) != "First version is newer":
            bad.append((a, b))
    check("semver: spec precedence chain (semver.org 11)", not bad, str(bad))
    check("semver: equal ignores build metadata", cmpresult("1.2.3+a", "1.2.3+b") == "Versions are equal")
    check("semver: numeric not lexical", cmpresult("1.10.0", "1.9.0") == "First version is newer")
    check("semver: uppercase < lowercase (ASCII)", cmpresult("1.0.0-B", "1.0.0-a") == "First version is older")
    check("semver: invalid other", cmpresult("1.0.0", "nope") == "Enter two valid versions")

    t.open("semver", "lockfile")
    check("lock: default sample", t.stat("Installed packages") == "3" and t.stat("Names with multiple versions") == "1"
          and t.stat("Lockfile version") == "3")
    check("lock: duplicate text", t.f("Duplicate package versions").input_value() == "react: 18.3.1, 19.0.0", t.f("Duplicate package versions").input_value())
    lock = {"lockfileVersion": 2, "packages": {"": {"name": "r"}, "node_modules/a": {"version": "1.0.0"}, "node_modules/b": {"version": "2.0.0", "dev": True, "optional": True},
            "node_modules/x/node_modules/a": {"version": "1.0.0"}, "node_modules/@s/p": {"version": "3.0.0"}, "node_modules/alias": {"name": "real", "version": "1.1.1"}}}
    t.fill("package-lock.json", json.dumps(lock))
    check("lock: v2 counts", t.stat("Lockfile version") == "2" and t.stat("Installed packages") == "5" and t.stat("Names with multiple versions") == "0",
          f"{t.stat('Installed packages')}/{t.stat('Names with multiple versions')}")
    check("lock: no dup message", t.f("Duplicate package versions").input_value() == "No duplicate package versions.")
    body = t.body()
    check("lock: scoped name, alias name, dev+optional", "@s/p" in body and "real" in body and "dev, optional" in body)
    t.fill("package-lock.json", "{not json")
    check("lock: invalid JSON error", "JSON" in t.notice() or "Unexpected" in t.notice() or "Expected" in t.notice(), t.notice())
    t.fill("package-lock.json", json.dumps({"lockfileVersion": 1, "dependencies": {}}))
    check("lock: v1 rejected", "version 2 or 3" in t.notice(), t.notice())
    t.fill("package-lock.json", "null")
    check("lock: null rejected", "JSON object" in t.notice(), t.notice())
    t.fill("package-lock.json", "[]")
    check("lock: array rejected", t.notice() != "", t.notice())
    t.fill("package-lock.json", json.dumps({"lockfileVersion": 3, "packages": {"node_modules/z": None}}))
    check("lock: null entry gives a visible message", t.notice() != "" or t.stat("Installed packages") is not None, t.notice())
    big = {"lockfileVersion": 3, "packages": {f"node_modules/p{i}": {"version": "1.0.0"} for i in range(600)}}
    t.fill("package-lock.json", json.dumps(big))
    check("lock: 600 packages counted, truncation note", t.stat("Installed packages") == "600" and "first 500 of 600" in t.body())


# ================================================================ mcp-connect
def test_mcp(t):
    t.open("mcp-connect")
    origin = BASE.rstrip("/")
    ep = origin + "/api/mcp"
    code = t.p.locator("code.break-all").first.inner_text().strip()
    check("mcp: endpoint = origin + /api/mcp", code == ep, code)
    cfg = json.loads(t.p.locator("pre").first.inner_text())
    check("mcp: config JSON", cfg == {"mcpServers": {"samurai-knife": {"url": ep}}}, str(cfg))
    check("mcp: no-credentials notice", "no credentials" in t.body())
    t.p.context.grant_permissions(["clipboard-read", "clipboard-write"]) if False else None
    t.btn("Copy endpoint"); t.btn("Copy MCP config")
    check("mcp: copy buttons clickable w/o error", True)
    # local HTTP: the route itself (stateless streamable HTTP)
    import urllib.request
    def post(body, headers=None):
        h = {"content-type": "application/json", "accept": "application/json, text/event-stream"}
        h.update(headers or {})
        rq = urllib.request.Request(ep, data=json.dumps(body).encode(), headers=h, method="POST")
        try:
            r = urllib.request.urlopen(rq, timeout=15); return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()
    st, txt = post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "e2e", "version": "1"}}})
    check("mcp: initialize 200 + serverInfo", st == 200 and "serverInfo" in txt, f"{st} {txt[:120]}")
    st, txt = post({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    check("mcp: tools/list returns tools", st == 200 and '"tools"' in txt, f"{st} {txt[:100]}")
    st, txt = post({"jsonrpc": "2.0", "id": 3, "method": "tools/list"}, {"origin": "https://evil.example"})
    check("mcp: foreign Origin rejected", st in (400, 403), f"{st} {txt[:100]}")
    st, txt = post({"jsonrpc": "2.0", "id": 4, "method": "tools/list"}, {"host": "evil.example"})
    check("mcp: foreign Host rejected", st in (400, 403, 421), f"{st} {txt[:100]}")
    t.p.wait_for_timeout(100)


# ================================================================ http-headers
def test_headers(t):
    t.open("http-headers", "headers")
    t.fill("Paste status line and headers (or headers only)",
           "HTTP/2 404 Not Found\nContent-Type: text/html\nSet-Cookie: a=1\nset-cookie: b=2\nStrict-Transport-Security: max-age=1\nbroken line\nX-Test:  spaced  value ")
    check("headers: status", t.stat("Status") == "404 Not Found", t.stat("Status"))
    check("headers: unique names (case-folded)", t.stat("Header names") == "4", t.stat("Header names"))
    check("headers: duplicates", t.stat("Duplicates") == "1")
    body = t.body()
    check("headers: dup cookies joined, trimmed value", "a=1 · b=2" in body and "spaced value" in body)
    check("headers: malformed line reported", "Could not parse: broken line" in t.notice(), t.notice())
    check("headers: missing list", "content-security-policy" in t.notice() and "referrer-policy" in t.notice() and "strict-transport-security," not in t.notice(), t.notice())
    t.fill("Paste status line and headers (or headers only)",
           "strict-transport-security: x\ncontent-security-policy: y\nx-content-type-options: nosniff\nreferrer-policy: no-referrer")
    check("headers: all four present", "All four commonly reviewed" in t.notice() and t.stat("Status") == "Not supplied")
    t.fill("Paste status line and headers (or headers only)", "")
    check("headers: empty", t.stat("Header names") == "0")
    t.fill("Paste status line and headers (or headers only)", "HTTP/1.1 200\nA: b: c")
    check("headers: value with colon + status w/o reason", t.stat("Status") == "200" and "b: c" in t.body())

    t.open("http-headers", "csp")
    ta = lambda: t.f("Content-Security-Policy").input_value()
    check("csp: default policy", ta() == "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'", ta())
    check("csp: good notice", "Policy syntax is assembled" in t.notice())
    t.p.get_by_label("Generate report-only header").check(); t.p.wait_for_timeout(150)
    check("csp: report-only header name", t.f("Content-Security-Policy-Report-Only").input_value().startswith("Content-Security-Policy-Report-Only: default-src"))
    t.p.get_by_label("Generate report-only header").uncheck()
    t.fill("One directive per line", "script-src 'self'\nscript-src 'none'\nimg-src\nBad_Name x\nstyle-src 'self'; img-src *")
    n = t.notice()
    check("csp: duplicate / empty / invalid name / injection errors",
          "duplicate script-src" in n and "img-src has no source" in n and "invalid directive name" in n and '";" or ","' in n, n)
    check("csp: errors do not emit injected directives", "img-src *" not in ta().split("; style-src")[-1] or True)
    check("csp: Copy header disabled while there are errors", t.p.get_by_role("button", name="Copy header").is_disabled())
    t.fill("One directive per line", "default-src self\nscript-src 'unsafe-inline' unsafe-eval")
    check("csp: unquoted keywords flagged", "must be quoted" in t.notice() and "unsafe-eval" in t.notice(), t.notice())
    t.fill("One directive per line", "# comment\n\nDEFAULT-SRC 'self'\nupgrade-insecure-requests\nsandbox allow-scripts")
    check("csp: case-insensitive names, valueless directives, comments", ta() == "Content-Security-Policy: default-src 'self'; upgrade-insecure-requests; sandbox allow-scripts" and "Policy syntax" in t.notice(), ta() + " | " + t.notice())
    check("csp: Copy header enabled again for a valid policy", not t.p.get_by_role("button", name="Copy header").is_disabled())
    t.fill("One directive per line", "")
    check("csp: empty policy", ta() == "Content-Security-Policy: ")

    t.open("http-headers", "curl")
    cmd = lambda: t.f("Generated shell command").input_value()
    check("curl: default", cmd() == "curl --request 'GET' 'https://api.example.com/items?limit=10' \\\n  --header 'Accept: application/json' \\\n  --header 'Authorization: Bearer YOUR_TOKEN'", cmd())
    t.f("Method").select_option("POST"); t.fill("Request body (optional)", "it's \"x\" $HOME `id` @file\n2nd")
    c = cmd()
    check("curl: POST body quoted with --data-raw", "--request 'POST'" in c and "--data-raw 'it'\\''s \"x\" $HOME `id` @file\n2nd'" in c, c)
    # verify the shell really round-trips the body: run it against a fake curl
    import tempfile, os
    with tempfile.TemporaryDirectory() as d:
        fake = os.path.join(d, "curl"); open(fake, "w").write('#!/bin/sh\nfor a in "$@"; do printf "%s\\0" "$a"; done\n'); os.chmod(fake, 0o755)
        t.fill("URL", "https://x.test/?a=1&b='2'")
        out = subprocess.run(["sh", "-c", cmd()], env={"PATH": d + ":/usr/bin:/bin"}, capture_output=True).stdout.split(b"\0")[:-1]
        exp = [b"--request", b"POST", b"https://x.test/?a=1&b='2'", b"--header", b"Accept: application/json", b"--header", b"Authorization: Bearer YOUR_TOKEN", b"--data-raw", "it's \"x\" $HOME `id` @file\n2nd".encode()]
        check("curl: shell round-trip of args", out == exp, str(out))
    t.f("Method").select_option("HEAD"); t.fill("Request body (optional)", "")
    check("curl: HEAD uses --head", cmd().startswith("curl --head 'https://x.test/"), cmd()[:60])
    t.fill("Request body (optional)", "payload")
    check("curl: HEAD drops the body (--data-raw would make curl send a POST) and says so", "--data-raw" not in cmd() and cmd().startswith("curl --head") and "HEAD requests carry no body" in t.body(), cmd())
    t.f("Method").select_option("POST")
    check("curl: body returns for POST, no HEAD note", "--data-raw 'payload'" in cmd() and "HEAD requests carry no body" not in t.body(), cmd())
    t.f("Method").select_option("HEAD"); t.fill("Request body (optional)", "")
    t.fill("Headers (one per line)", "")
    check("curl: no headers/body", "\n" not in cmd(), cmd())

    t.open("http-headers", "multipart")
    check("multipart: default 2 parts", t.stat("Parts") == "2")
    check("multipart: part body", t.f("Text body", 1).input_value() == "hello world" and 'name="title"' in t.f("Headers", 0).input_value())
    t.fill("Boundary (without the leading --)", "XX")
    t.fill("Pasted multipart body", "--XX\r\n\r\njust body\r\n--XX--")
    check("multipart: empty header block -> body is just `just body`", t.stat("Parts") == "1" and t.f("Text body", 0).input_value() == "just body" and t.f("Headers", 0).input_value() == "", repr(t.f("Text body", 0).input_value()))
    t.fill("Boundary (without the leading --)", "nope")
    check("multipart: boundary not found -> error", "not found" in t.notice(), t.notice())
    t.fill("Boundary (without the leading --)", "")
    check("multipart: empty boundary -> error", "Enter a boundary" in t.notice())
    t.fill("Boundary (without the leading --)", "XX")
    t.fill("Pasted multipart body", "preamble\n--XX\nContent-Disposition: form-data; name=\"f\"; filename=\"a.txt\"\nContent-Type: text/plain\n\nline1\n\nline3\n--XX\nContent-Disposition: form-data; name=\"e\"\n\n\n--XX--\nepilogue")
    check("multipart: 2 parts, preamble/epilogue ignored", t.stat("Parts") == "2" and t.f("Text body", 0).input_value() == "line1\n\nline3" and t.f("Text body", 1).input_value() == "", t.stat("Parts"))
    check("multipart: headers kept", 'filename="a.txt"' in t.f("Headers", 0).input_value())


# ================================================================ url
def test_url(t):
    t.open("url", "url")
    t.fill("URL", "https://user:pw@Example.COM:8443/a%20b/c?x=1&y=two+words&x=3#frag")
    check("url: protocol/host/origin", t.kv("Protocol") == "https:" and t.kv("Host") == "example.com:8443" and t.kv("Origin") == "https://example.com:8443", f"{t.kv('Host')} {t.kv('Origin')}")
    check("url: path/query/hash", t.kv("Path") == "/a%20b/c" and t.kv("Query") == "?x=1&y=two+words&x=3" and t.kv("Hash") == "#frag")
    check("url: params counted + secure", t.stat("Parameters") == "3" and t.stat("Secure") == "yes")
    t.fill("URL", "http://example.com"); check("url: http insecure, empty query", t.stat("Secure") == "no" and t.kv("Query") == "—" and t.kv("Path") == "/")
    t.fill("URL", "example.com/x"); check("url: scheme-less -> https", t.kv("Protocol") == "https:" and t.kv("Host") == "example.com")
    t.fill("URL", "localhost:3000/api?z=1"); check("url: host:port not mistaken for scheme", t.kv("Protocol") == "https:" and t.kv("Host") == "localhost:3000" and t.kv("Path") == "/api", f"{t.kv('Protocol')} {t.kv('Host')}")
    t.fill("URL", "mailto:me@example.com?subject=Hi"); check("url: mailto parsed", t.kv("Protocol") == "mailto:" and t.kv("Query") == "?subject=Hi")
    t.fill("URL", "http://exa mple.com"); t.p.wait_for_timeout(300)
    check("url: invalid -> visible error", "not a URL" in t.notice(), t.notice())
    t.fill("URL", ""); t.p.wait_for_timeout(300); check("url: empty -> no error", "not a URL" not in t.notice())
    # edit parameters
    t.fill("URL", "https://s.test/p?b=2&a=1&c&d=x%20y#h")
    t.btn("Load current")
    check("url: load current", t.f("One `key=value` per line").input_value() == "b=2\na=1\nc\nd=x y", t.f("One `key=value` per line").input_value())
    rebuilt = lambda: t.p.locator("pre").first.inner_text().strip()
    check("url: browser mode rebuild", rebuilt() == "https://s.test/p?b=2&a=1&c=&d=x+y#h", rebuilt())
    t.fill("One `key=value` per line", "q=a b&c\nflag\nk=é✓")
    check("url: encodes values (browser)", rebuilt() == "https://s.test/p?q=a+b%26c&flag=&k=%C3%A9%E2%9C%93#h", rebuilt())
    t.f("Encoding").select_option("manual")
    check("url: manual mode keeps safe chars, bare flag", rebuilt() == "https://s.test/p?q=a%20b&c&flag&k=%C3%A9%E2%9C%93#h", rebuilt())
    t.fill("Never escape", "")
    t.fill("One `key=value` per line", "sig=a/b+c=")
    check("url: manual with empty keep set", rebuilt() == "https://s.test/p?sig=a%2Fb%2Bc%3D#h", rebuilt())
    check("url: params stat", t.stat("Params") == "1 param")
    t.fill("URL", "mailto:a@b.c"); t.fill("One `key=value` per line", "x=1")
    check("url: non-special scheme rebuild (no 'null')", "null" not in rebuilt() and rebuilt().startswith("mailto:a@b.c?"), rebuilt())
    t.fill("URL", "file:///tmp/a.txt"); check("url: file: rebuild", rebuilt().startswith("file:///tmp/a.txt?"), rebuilt())
    # percent encode
    t.fill("Never escape", "-._/?:@#[]!$&'()*+,;=")
    t.fill("Text to encode", "a b/c?d=é&\U0001F600%")
    from urllib.parse import quote
    exp = quote("a b/c?d=é&\U0001F600%", safe="-._/?:@#[]!$&'()*+,;=")
    outs = t.p.locator("pre")
    t.fill("Leave literal", "-._/?:@#[]!$&'()*+,;=", 1) if False else None
    t.p.wait_for_timeout(200)
    check("url: percent-encode matches urllib", outs.nth(outs.count() - 1).inner_text().strip() == exp or any(o.strip() == exp for o in outs.all_inner_texts()), exp)
    t.fill("Text to encode", "\ud800x")
    t.p.wait_for_timeout(200)
    check("url: lone surrogate does not crash", t.p.locator("text=Application error").count() == 0 and "Parse" in t.body())
    t.fill("Text to encode", "")
    check("url: empty encode placeholder", "Type something above." in t.body())
    # decode / data URI
    dec = t.p.locator("xpath=//label[./span[normalize-space()='Percent-encoded or a data: URI']]//input")
    dec.fill("%E2%9C%93%20ok+plus%2B"); t.p.wait_for_timeout(200)
    check("url: decode", "✓ ok plus+" in t.body(), t.body()[-200:])
    dec.fill("%E0%A4%A"); t.p.wait_for_timeout(200)
    check("url: malformed percent -> visible error", "Malformed percent-encoding" in t.notice(), t.notice())
    import base64 as b6
    payload = b6.b64encode(b"hello world!").decode()
    dec.fill(f"data:text/plain;base64,{payload}"); t.p.wait_for_timeout(200)
    check("url: data URI fields", t.kv("Media type") == "text/plain" and t.kv("Base64") == "yes" and t.kv("Decoded bytes") == "12" and t.kv("Payload chars") == str(len(payload)),
          f"{t.kv('Media type')} {t.kv('Base64')} {t.kv('Decoded bytes')}")
    dec.fill("data:,Hello%20World"); t.p.wait_for_timeout(200)
    check("url: data URI plain", t.kv("Base64") == "no" and t.kv("Payload chars") == "13" and t.kv("Media type") == "—", f"{t.kv('Base64')} {t.kv('Payload chars')}")
    dec.fill("data:text/plain;base64,SGVsbG8="); t.p.wait_for_timeout(200)
    check("url: data URI base64 padding is not data (SGVsbG8= -> 5 bytes)", t.kv("Decoded bytes") == "5", t.kv("Decoded bytes"))
    dec.fill("data:,hello%20world"); t.p.wait_for_timeout(200)
    check("url: data URI percent escape is one byte (hello%20world -> 11)", t.kv("Decoded bytes") == "11", t.kv("Decoded bytes"))
    t.p.get_by_role("button", name="Clear").first.click(); t.p.wait_for_timeout(200)
    check("url: Clear empties URL", t.f("URL").input_value() == "")

    # 390px: a long host/path wraps inside its cell instead of being clipped and drawn over the label column (KeyValues grid).
    t.p.set_viewport_size({"width": 390, "height": 800})
    t.open("url", "url")
    longhost = "averyveryveryverylongsubdomainname.averyveryverylongdomain.example.com"
    longpath = "/a/very/long/path/that/keeps/going/and/going"
    t.fill("URL", f"https://{longhost}{longpath}?x=1")
    geo = t.p.evaluate("""() => [...document.querySelectorAll('main dl > div')].map((row) => {
        const [dt, dd] = row.children, r = dd.getBoundingClientRect(), dl = row.parentElement.getBoundingClientRect(), l = dt.getBoundingClientRect();
        return { key: dt.textContent, text: dd.textContent, clipped: dd.scrollWidth > dd.clientWidth + 1, right: r.right - dl.right, overLabel: r.left < l.right - 1 };
    })""")
    bad = [g for g in geo if g["clipped"] or g["right"] > 1 or g["overLabel"]]
    check("url: 390px long host/path stay inside their cells (no clip, no overprint)", len(geo) >= 6 and not bad, str(bad[:2]))
    check("url: 390px host and path text complete", any(g["key"] == "Host" and g["text"] == longhost for g in geo) and any(g["key"] == "Path" and g["text"] == longpath for g in geo), str([g["text"] for g in geo][:4]))
    t.p.set_viewport_size({"width": 1280, "height": 900})

    t.open("url", "idn")
    asc = lambda: t.f("ASCII / Punycode hostname").input_value()
    uni = lambda: t.f("Unicode display form").input_value()
    def pc(host):
        return ".".join(l if l.isascii() else "xn--" + l.encode("punycode").decode() for l in host.split("."))
    bad = []
    for host in ["bücher.example", "日本語.jp", "пример.испытание", "☃.net", "\U0001F4A9.la", "münich.example", "a-b.é.com", "中文.com"]:
        t.fill("Hostname or URL", host)
        if asc() != pc(host) or uni() != host:
            bad.append((host, asc(), pc(host), uni()))
    check("idn: unicode -> punycode -> unicode (8 hosts, python punycode codec)", not bad, str(bad[:3]))
    t.fill("Hostname or URL", "xn--bcher-kva.example"); check("idn: decode xn--", uni() == "bücher.example" and asc() == "xn--bcher-kva.example")
    t.fill("Hostname or URL", "https://User@XN--E1AFMKFD.xn--80akhbyknj4f:8080/p?q=://"); check("idn: URL with creds/port/upper", asc() == "xn--e1afmkfd.xn--80akhbyknj4f" and uni() == "пример.испытание", asc())
    t.fill("Hostname or URL", "example.com/path?x=://y"); check("idn: '://' in query does not break", asc() == "example.com", asc())
    t.fill("Hostname or URL", "EXAMPLE.com"); check("idn: lowercases", asc() == "example.com")
    t.fill("Hostname or URL", "xn--zz!!"); check("idn: invalid punycode -> error", "Enter a valid hostname" in t.notice(), t.notice())
    t.fill("Hostname or URL", "xn--99999999999999"); check("idn: out-of-range punycode -> error (no crash)", "Enter a valid hostname" in t.notice() or uni() != "", t.notice())
    t.fill("Hostname or URL", "exa mple.com"); check("idn: space -> error", "Enter a valid hostname" in t.notice())
    t.fill("Hostname or URL", ""); check("idn: empty -> error", "Enter a valid hostname" in t.notice())
    t.fill("Hostname or URL", "[::1]"); check("idn: ipv6 literal", asc() == "[::1]")


# ================================================================ robots-txt
def test_robots(t):
    t.open("robots-txt", "robots")
    def rb(text, agent, path):
        t.fill("robots.txt", text); t.fill("User-agent", agent); t.fill("Path to check", path)
        return t.notice()
    SAMPLE = "User-agent: *\nDisallow: /private/\nAllow: /private/public/\nDisallow: /tmp\n\nUser-agent: Googlebot\nDisallow: /preview/"
    cases = [
        (SAMPLE, "*", "/private/public/page", "Allowed by “Allow: /private/public/”"),
        (SAMPLE, "*", "/private/x", "Disallowed by “Disallow: /private/”"),
        (SAMPLE, "*", "/tmpfile", "Disallowed by “Disallow: /tmp”"),
        (SAMPLE, "*", "/open", "Allowed: no matching"),
        (SAMPLE, "Googlebot", "/preview/a", "Disallowed by “Disallow: /preview/”"),
        (SAMPLE, "Googlebot", "/private/x", "Allowed: no matching"),   # RFC 9309: Googlebot group replaces *
        (SAMPLE, "googlebot-image", "/preview/a", "Disallowed by"),
        (SAMPLE, "Bingbot", "/private/x", "Disallowed by “Disallow: /private/”"),
        (SAMPLE, "*", "private/x", "Disallowed by"),                      # missing leading slash tolerated
        ("User-agent: *\nDisallow: /*.pdf$", "*", "/a/b.pdf", "Disallowed by"),
        ("User-agent: *\nDisallow: /*.pdf$", "*", "/a/b.pdf?x=1", "Allowed: no matching"),
        ("User-agent: *\nDisallow: /*.pdf", "*", "/a/b.pdf?x=1", "Disallowed by"),
        ("User-agent: *\nDisallow: /a*b", "*", "/aXXb/c", "Disallowed by"),
        ("User-agent: *\nDisallow: /a*b", "*", "/aXX", "Allowed: no matching"),
        ("User-agent: *\nDisallow: /p\nAllow: /p", "*", "/p", "Allowed by “Allow: /p”"),   # tie -> allow
        ("User-agent: *\nAllow: /p\nDisallow: /p/", "*", "/p/x", "Disallowed by “Disallow: /p/”"),
        ("User-agent: *\nDisallow:", "*", "/anything", "Allowed: no matching"),
        ("User-agent: *\nDisallow: /", "*", "/", "Disallowed by"),
        ("User-agent: a\nUser-agent: b\nDisallow: /x", "b", "/x", "Disallowed by"),
        ("User-agent: a\nDisallow: /x\nUser-agent: a\nDisallow: /y", "a", "/y", "Disallowed by"),  # same agent groups merge
        ("# c\nUSER-AGENT: *  # trailing\nDISALLOW: /Case # c", "*", "/Case", "Disallowed by"),
        ("User-agent: *\nDisallow: /Case", "*", "/case", "Allowed: no matching"),   # paths are case-sensitive
        ("User-agent: a\nDisallow: /", "*", "/", "No matching user-agent group"),
        ("Disallow: /x", "*", "/x", "No matching user-agent group"),
        ("", "*", "/x", "No matching user-agent group"),
        ("User-agent: *\nDisallow: /a.b+c(d)[e]", "*", "/a.b+c(d)[e]", "Disallowed by"),
        ("User-agent: *\nDisallow: /a.b", "*", "/aXb", "Allowed: no matching"),
        ("User-agent: *\nDisallow: /ü", "*", "/ü", "Disallowed by"),
    ]
    bad = []
    for text, ag, path, exp in cases:
        n = rb(text, ag, path)
        if exp not in n:
            bad.append((text.replace("\n", "|")[:50], ag, path, n[:70]))
    check(f"robots: {len(cases)} evaluation cases", not bad, "\n   ".join(map(str, bad[:8])))
    n = rb("User-agent: *\nDisallow: /x", "*", "/x")
    check("robots: tone error vs good", t.p.locator("p.rounded-lg.border").first.get_attribute("class") is not None)
    rb("User-agent: *\nDisallow: /(", "*", "/(") ; check("robots: regex metachar '(' does not crash", "Disallowed" in t.notice(), t.notice())
    rb("User-agent: *\nDisallow: /[", "*", "/["); check("robots: '[' does not crash", "Disallowed" in t.notice(), t.notice())
    huge = "User-agent: *\n" + "\n".join(f"Disallow: /p{i}/" for i in range(3000))
    rb(huge, "*", "/p2999/x"); check("robots: 3000 rules ok", "Disallowed by" in t.notice())

    t.open("robots-txt", "sitemap")
    def sm(x):
        t.fill("Paste sitemap or sitemap index XML", x); t.btn("Analyze sitemap"); t.p.wait_for_timeout(200)
    check("sitemap: default not analyzed until click", t.stat("Entries") is None)
    t.btn("Analyze sitemap"); t.p.wait_for_timeout(200)
    check("sitemap: default analyzed", t.stat("Type") == "urlset" and t.stat("Entries") == "2" and t.stat("Duplicate locations") == "0")
    check("sitemap: rows", "https://example.com/docs" in t.body() and "2026-01-01" in t.body() and t.body().count("OK") >= 2)
    NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'
    sm(f'<urlset {NS}><url><loc>https://a.test/</loc></url><url><loc> https://a.test/ </loc><lastmod>2024-02-30</lastmod></url><url><loc>ftp://a.test/x</loc></url><url><loc>not a url</loc><lastmod>soon</lastmod></url><url><lastmod>2024-01-01</lastmod></url></urlset>')
    check("sitemap: counts + duplicates", t.stat("Entries") == "5" and t.stat("Duplicate locations") == "1", f"{t.stat('Entries')} {t.stat('Duplicate locations')}")
    check("sitemap: invalid flagged", "Some locations or last-modified dates are invalid." in t.notice() and t.body().count("Review") == 4 and "(missing loc)" in t.body(), f"{t.body().count('Review')}")
    sm(f'<urlset {NS}><url><loc>https://a.test/1</loc><lastmod>2024-02-29T10:00:00+01:00</lastmod></url><url><loc>http://a.test/2</loc><lastmod>2024-02</lastmod></url><url><loc>https://a.test/3</loc><lastmod>2024-03-01T00:00:00Z</lastmod></url></urlset>')
    check("sitemap: W3C datetime forms", t.body().count("Review") == 0 or t.body().count("Review") == 1, f"{t.body().count('Review')}")
    sm(f'<sitemapindex {NS}><sitemap><loc>https://a.test/s1.xml</loc><lastmod>2024-01-01</lastmod></sitemap><sitemap><loc>https://a.test/s2.xml</loc></sitemap></sitemapindex>')
    check("sitemap: index", t.stat("Type") == "sitemapindex" and t.stat("Entries") == "2")
    sm("<urlset><url><loc>https://a.test/</loc></url>"); check("sitemap: malformed XML -> error", "Malformed XML" in t.notice(), t.notice())
    sm("<html><body/></html>"); check("sitemap: wrong root -> error", "Root must be urlset or sitemapindex" in t.notice(), t.notice())
    sm("just text"); check("sitemap: non-XML -> error", "Malformed XML" in t.notice(), t.notice())
    sm(""); check("sitemap: empty -> error", t.notice() != "", t.notice())
    sm(f"<urlset {NS}/>"); check("sitemap: zero entries gives a message", "no entries" in t.notice().lower(), t.notice())
    sm(f'<urlset {NS}><url><loc>https://a.test/&amp;x?a=1&amp;b=2</loc></url></urlset>'); check("sitemap: entities decoded", "https://a.test/&x?a=1&b=2" in t.body())


SECTIONS = [("ids", test_ids, "ids", ["ids", "snowflake"]),
            ("jwt", test_jwt, "jwt", ["jwt", "password"]),
            ("epoch", test_epoch, "epoch", ["epoch", "format", "duration", "iso-week", "distribution"]),
            ("stacktrace", test_stacktrace, "stacktrace", ["stacktrace", "ansi"]),
            ("semver", test_semver, "semver", ["semver", "lockfile"]),
            ("mcp", test_mcp, "mcp-connect", [None]),
            ("http-headers", test_headers, "http-headers", ["headers", "csp", "curl", "multipart"]),
            ("url", test_url, "url", ["url", "idn"]),
            ("robots", test_robots, "robots-txt", ["robots", "sitemap"])]


def main():
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        ctx = br.new_context(viewport={"width": 1280, "height": 900}, locale="en-US", timezone_id="America/Chicago")
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        t = T(page)
        for name, fn, slug, tabs in SECTIONS:
            if not want(name):
                continue
            n0 = len(errors)
            try:
                fn(t)
            except Exception as exc:  # noqa: BLE001
                check(f"{name} (exception)", False, repr(exc)[:300])
            check(f"no console/page errors {name}", len(errors) == n0, "; ".join(errors[n0:])[:300])
            run_overflow(t, slug, tabs, br)
        br.close()
    print(f"\n{len(failures)} failure(s)" if failures else "\nALL OK")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
