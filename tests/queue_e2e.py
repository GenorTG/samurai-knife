"""Work-queue end-to-end: bounded Python lane, abort propagation, 503 overflow, async job API, reaping.

Start a scratch server from the SAME checkout this file lives in (the process-table oracle matches the checkout's
script path), with its own data dir, its own TMPDIR (so leftover scratch dirs are countable) and small queue sizes:

    mkdir -p /tmp/q-data /tmp/q-tmp
    TMPDIR=/tmp/q-tmp KNIFE_DATA_DIR=/tmp/q-data KNIFE_PORT=3301 KNIFE_PY_LIGHT=4 KNIFE_PY_HEAVY=1 \\
      KNIFE_PY_HEAVY_DEPTH=8 KNIFE_JOB_TTL_SEC=3 KNIFE_PY_LIGHT_PER_ACCOUNT=64 KNIFE_PY_HEAVY_PER_ACCOUNT=16 npm run dev

(The per-account share is lifted so this one account can fill a lane; that cap is tested in tests/roles_mcp.test.mjs.)
    TMPDIR=/tmp/q-tmp KNIFE_DATA_DIR=/tmp/q-data ../samurai-knife-py/venv/bin/python tests/queue_e2e.py http://127.0.0.1:3301

Independent oracles: the OS process table sampled every 50 ms (peak concurrent `sql_tool.py` / `pdf_tool.py` of THIS
checkout), pypdf for output files, /tmp-scratch directory listing. Needs reportlab + pypdf (the engine venv).
"""
import base64
import http.client
import io
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from pypdf import PdfReader
from reportlab.pdfgen import canvas

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3301").rstrip("/")
HOST, PORT = BASE.split("//", 1)[1].split(":")
ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = str(ROOT / "server" / "py" / "scripts") + "/"
TMP = os.environ.get("TMPDIR", "")
DATA_DIR = os.environ.get("KNIFE_DATA_DIR", "")
failures: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f" | {str(detail)[:300]}"))
    if not ok:
        failures.append(name)


def info(text: str) -> None:
    print("     " + text)


# ----------------------------------------------------------------------------------------------- fixtures
def make_pdf(pages: int, tag: str = "p") -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for i in range(pages):
        c.drawString(100, 700, f"{tag} page {i} " + "lorem ipsum " * 12)
        c.showPage()
    c.save()
    return buf.getvalue()


SMALL = make_pdf(3, "small")
MEDIUM = make_pdf(1200, "medium")   # ~1 s of compress work
BIG = make_pdf(6000, "big")         # long enough to still be running when we abort it


def multipart(action: str, data: bytes, params: dict | None = None) -> tuple[bytes, str]:
    b = uuid.uuid4().hex
    body = f'--{b}\r\nContent-Disposition: form-data; name="action"\r\n\r\n{action}\r\n'.encode()
    if params is not None:
        body += f'--{b}\r\nContent-Disposition: form-data; name="params"\r\n\r\n{json.dumps(params)}\r\n'.encode()
    body += (f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n'
             "Content-Type: application/pdf\r\n\r\n").encode() + data + f"\r\n--{b}--\r\n".encode()
    return body, f"multipart/form-data; boundary={b}"


class Headers(dict):
    """Case-insensitive header dict (Node answers with lower-case names)."""

    def __init__(self, items):
        super().__init__({k.lower(): v for k, v in items})

    def get(self, key, default=None):
        return super().get(key.lower(), default)

    def __getitem__(self, key):
        return super().__getitem__(key.lower())

    def __contains__(self, key):
        return super().__contains__(str(key).lower())


def call(method: str, path: str, body: bytes | None = None, headers: dict | None = None, timeout: float = 300):
    req = urllib.request.Request(BASE + path, body, headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, Headers(resp.headers.items()), resp.read()
    except urllib.error.HTTPError as err:
        return err.code, Headers(err.headers.items()), err.read()


def jcall(method: str, path: str, payload: dict | None = None, headers: dict | None = None):
    h = {"Origin": BASE, **(headers or {})}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        h["Content-Type"] = "application/json"
    s, hd, raw = call(method, path, data, h)
    try:
        return s, hd, json.loads(raw)
    except ValueError:
        return s, hd, {"_raw": raw[:200]}


def pdf(action: str, data: bytes, params: dict | None = None, *, asynchronous: bool = False, headers: dict | None = None):
    body, ctype = multipart(action, data, params)
    return call("POST", "/api/pdf" + ("?async=1" if asynchronous else ""), body, {"Content-Type": ctype, "Origin": BASE, **(headers or {})})


def submit_async(action: str, data: bytes, params: dict | None = None, headers: dict | None = None) -> str:
    s, _, raw = pdf(action, data, params, asynchronous=True, headers=headers)
    assert s == 202, (s, raw[:200])
    return json.loads(raw)["jobId"]


def sql(action: str = "format", params: dict | None = None, **kw):
    return jcall("POST", "/api/sql", {"action": action, "params": params or {"sql": "select 1", "dialect": "sqlite"}}, **kw)


def job(job_id: str, headers: dict | None = None):
    return jcall("GET", f"/api/jobs/{job_id}", headers=headers)


def wait_job(job_id: str, until: set[str], timeout: float = 120, headers: dict | None = None) -> dict:
    end = time.time() + timeout
    last: dict = {}
    while time.time() < end:
        s, _, last = job(job_id, headers)
        if s == 200 and last.get("status") in until:
            return last
        time.sleep(0.05)
    return last


def cancel_all(ids: list[str]) -> None:
    for jid in ids:
        jcall("DELETE", f"/api/jobs/{jid}")


# ----------------------------------------------------------------------------------------------- process table oracle
def our_procs() -> list[tuple[int, str]]:
    out = subprocess.run(["ps", "-eo", "pid,args"], capture_output=True, text=True).stdout.splitlines()
    found = []
    for line in out:
        if SCRIPTS in line and "bin/python" in line:
            pid, _, args = line.strip().partition(" ")
            kind = "pdf" if "pdf_tool.py" in args else "sql" if "sql_tool.py" in args else None
            if kind:
                found.append((int(pid), kind))
    return found


class Sampler:
    def __init__(self) -> None:
        self.peak = {"pdf": 0, "sql": 0}
        self._stop = False
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop:
            counts = {"pdf": 0, "sql": 0}
            for _, kind in our_procs():
                counts[kind] += 1
            for kind in counts:
                self.peak[kind] = max(self.peak[kind], counts[kind])
            time.sleep(0.05)

    def __enter__(self) -> "Sampler":
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop = True
        self._thread.join()


def wait_no_procs(timeout: float = 8.0, kind: str | None = None) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if not [p for p in our_procs() if kind in (None, p[1])]:
            return True
        time.sleep(0.05)
    return False


def knife_scratch() -> list[str]:
    if not TMP:
        return []
    return sorted(p.name for p in Path(TMP).glob("knife-*"))


def stats() -> dict:
    s, _, j = jcall("GET", "/api/system/queue")
    assert s == 200, (s, j)
    return j


# ----------------------------------------------------------------------------------------------- 0. configuration
print("== 0. configuration")
st = stats()
lanes = st["lanes"]
cfg = (lanes["light"]["concurrency"], lanes["heavy"]["concurrency"], lanes["heavy"]["maxDepth"], st["jobs"]["ttlSec"])
check("server started with light=4 heavy=1 heavy-depth=8 ttl=3s", cfg == (4, 1, 8, 3), cfg)
if cfg != (4, 1, 8, 3):
    sys.exit("start the scratch server with the env shown in this file's docstring")
check("TMPDIR points at an isolated scratch dir", bool(TMP) and TMP != "/tmp" and Path(TMP).is_dir(), TMP)
check("queue idle at start", all(lanes[n]["running"] == 0 and lanes[n]["queued"] == 0 for n in lanes), lanes)
base_completed = {n: lanes[n]["completed"] for n in lanes}
base_cancelled = {n: lanes[n]["cancelled"] for n in lanes}

# ----------------------------------------------------------------------------------------------- 1. burst caps
print("== 1. burst: 8 pdf + 24 sql at once")
results: dict[str, list] = {"pdf": [], "sql": []}


def fire(kind: str) -> None:
    t = time.time()
    s, h, _ = pdf("compress", MEDIUM) if kind == "pdf" else sql()
    results[kind].append((s, time.time() - t))


with Sampler() as sampler:
    threads = [threading.Thread(target=fire, args=("pdf",)) for _ in range(8)]
    threads += [threading.Thread(target=fire, args=("sql",)) for _ in range(24)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
info(f"peak concurrent python: pdf={sampler.peak['pdf']} sql={sampler.peak['sql']}")
check("peak concurrent pdf_tool.py <= heavy cap (1)", sampler.peak["pdf"] <= 1, sampler.peak)
check("peak concurrent sql_tool.py <= light cap (4)", sampler.peak["sql"] <= 4, sampler.peak)
check("the caps were actually reached (the oracle sees processes)", sampler.peak["pdf"] == 1 and sampler.peak["sql"] >= 2, sampler.peak)
check("all 8 pdf (1 running + 7 queued) and 24 sql answered 200", all(s == 200 for s, _ in results["pdf"] + results["sql"]),
      [s for s, _ in results["pdf"] + results["sql"] if s != 200])
check("python lane idle afterwards", wait_no_procs())

# ----------------------------------------------------------------------------------------------- 2. light never waits behind heavy
print("== 2. a tiny sql call while 6 pdf jobs are queued")
ids = [submit_async("compress", BIG) for _ in range(6)]
time.sleep(0.3)
lat = []
for _ in range(3):
    t = time.time()
    s, _, j = sql()
    lat.append(time.time() - t)
    check("sql answered while heavy lane is busy", s == 200 and j.get("ok") is True, (s, j))
lat.sort()
info(f"sql latency while pdf backlog: {[round(x, 2) for x in lat]}")
check("median tiny sql call < 1.5 s with 6 pdf jobs in the lane", lat[1] < 1.5, lat)
statuses = [job(i)[2].get("status") for i in ids]
check("pdf backlog really existed (1 running, >=4 still queued)", statuses.count("running") == 1 and statuses.count("queued") >= 4, statuses)
positions = [job(i)[2].get("position") for i in ids if job(i)[2].get("status") == "queued"]
check("queue positions are 0,1,2,... in FIFO order", positions == sorted(positions) and positions[0] == 0 and positions == list(range(len(positions))), positions)
cancel_all(ids)
check("cancelling the whole backlog leaves no python process", wait_no_procs())

# ----------------------------------------------------------------------------------------------- 3. client abort
print("== 3. client abort mid-run")


def raw_post(data: bytes, action: str = "compress") -> socket.socket:
    body, ctype = multipart(action, data)
    s = socket.create_connection((HOST, int(PORT)))
    s.sendall((f"POST /api/pdf HTTP/1.1\r\nHost: {HOST}:{PORT}\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\n\r\n").encode() + body)
    return s


def wait_for_proc(kind: str, timeout: float = 30) -> list[int]:
    end = time.time() + timeout
    while time.time() < end:
        pids = [p for p, k in our_procs() if k == kind]
        if pids:
            return pids
        time.sleep(0.05)
    return []


before_scratch = set(knife_scratch())
sock = raw_post(BIG)
pids = wait_for_proc("pdf")
check("sync pdf request started a python process", len(pids) == 1, pids)
sock.close()
t0 = time.time()
gone = wait_no_procs(6, "pdf")
info(f"python gone {time.time() - t0:.2f}s after the client disconnected")
check("client disconnect kills the python process (no orphan)", gone, our_procs())
check("...within the SIGTERM->SIGKILL window", time.time() - t0 < 5)
time.sleep(0.5)
leftover = set(knife_scratch()) - before_scratch
check("no scratch dirs left behind by the aborted request", not leftover, sorted(leftover))

# a queued request that is abandoned never starts python
first = raw_post(BIG)
wait_for_proc("pdf")
second = raw_post(MEDIUM)
time.sleep(0.5)
lanes_now = stats()["lanes"]["heavy"]
check("second request is waiting in the queue", lanes_now["queued"] == 1 and lanes_now["running"] == 1, lanes_now)
second.close()
time.sleep(0.5)
check("abandoned queued request leaves the queue", stats()["lanes"]["heavy"]["queued"] == 0, stats()["lanes"]["heavy"])
first.close()
check("and the running one dies too", wait_no_procs(6, "pdf"))
time.sleep(0.5)
check("heavy lane is free again (running=0)", stats()["lanes"]["heavy"]["running"] == 0)
s, _, raw = pdf("info", SMALL)
check("next request after the aborts works", s == 200, s)

# sql abort
slow_sql = {"action": "format", "params": {"sql": "select 1", "dialect": "sqlite"}}
# (sql is fast; the assertion is only that an abort of a tiny request leaves nothing behind)
conn = http.client.HTTPConnection(HOST, int(PORT))
conn.request("POST", "/api/sql", json.dumps(slow_sql), {"Content-Type": "application/json", "Origin": BASE})
conn.close()
check("aborted sql request leaves no python behind", wait_no_procs(5, "sql"))

# ----------------------------------------------------------------------------------------------- 4. overflow
print("== 4. overflow: 503 + Retry-After")
long_job = submit_async("compress", BIG)
wait_for_proc("pdf")
queued = [submit_async("info", SMALL) for _ in range(8)]  # depth 8
procs_before = len([p for p in our_procs() if p[1] == "pdf"])
s, h, raw = pdf("info", SMALL, asynchronous=True)
body = json.loads(raw) if raw else {}
check("async submit past the depth limit -> 503", s == 503, (s, raw[:200]))
check("503 carries Retry-After (seconds, >= 1)", str(h.get("Retry-After", "")).isdigit() and int(h["Retry-After"]) >= 1, h)
check("503 body names the error and lane", body.get("ok") is False and body.get("lane") == "heavy" and "full" in body.get("error", ""), body)
s2, h2, _ = pdf("info", SMALL)
check("sync request past the depth limit -> 503 + Retry-After, not a hang", s2 == 503 and "Retry-After" in h2, (s2, h2))
check("overflow did not start another python process", len([p for p in our_procs() if p[1] == "pdf"]) == procs_before)
s3, _, j3 = sql()
check("light lane unaffected by the heavy overflow", s3 == 200 and j3.get("ok") is True, (s3, j3))
cancel_all([long_job] + queued)
check("overflow backlog cancelled, python gone", wait_no_procs())
time.sleep(0.3)

# ----------------------------------------------------------------------------------------------- 5. async job lifecycle
print("== 5. async job lifecycle")
body, ctype = multipart("compress", SMALL)
s, h, raw = call("POST", "/api/pdf", body, {"Content-Type": ctype, "Origin": BASE, "Prefer": "respond-async"})
check("Prefer: respond-async -> 202 with Preference-Applied", s == 202 and h.get("Preference-Applied") == "respond-async", (s, h))
accepted = json.loads(raw)
check("202 body has jobId/statusUrl", accepted.get("ok") and accepted["jobId"].startswith("job_") and accepted["statusUrl"] == f"/api/jobs/{accepted['jobId']}", accepted)
done = wait_job(accepted["jobId"], {"done", "failed"})
check("compress job reaches done", done.get("status") == "done", done)
res = done.get("result", {})
check("file result advertises url/filename/mime/bytes", res.get("kind") == "file" and res["url"] == f"/api/jobs/{done['jobId']}/file"
      and res["filename"].endswith(".pdf") and res["mime"] == "application/pdf" and res["bytes"] > 0, res)
check("queuedMs/runMs are numbers", isinstance(done.get("queuedMs"), int) and isinstance(done.get("runMs"), int), done)
s, h, data = call("GET", res["url"])
check("GET /file returns the PDF with sync-route headers", s == 200 and h.get("Content-Type") == "application/pdf"
      and "attachment" in h.get("Content-Disposition", "") and "X-Knife-Data" in h, (s, h))
reader = PdfReader(io.BytesIO(data))
check("result PDF is valid and has the 3 source pages with their text", len(reader.pages) == 3 and "small page 2" in reader.pages[2].extract_text(), len(reader.pages))
meta = json.loads(base64.urlsafe_b64decode(h["X-Knife-Data"] + "=" * (-len(h["X-Knife-Data"]) % 4)))
check("X-Knife-Data payload matches the sync route's shape", meta.get("file") and meta.get("mime") == "application/pdf", meta)
ss, sh, sdata = pdf("compress", SMALL)
check("sync route gives an equivalent file (same pages)", ss == 200 and len(PdfReader(io.BytesIO(sdata)).pages) == 3 and "X-Knife-Data" in sh)

jid = submit_async("info", SMALL)
info_done = wait_job(jid, {"done", "failed"})
check("json action result inline", info_done.get("status") == "done" and info_done["result"]["kind"] == "json"
      and info_done["result"]["data"]["documents"][0]["pages"] == 3, info_done)
check("json job has no /file", call("GET", f"/api/jobs/{jid}/file")[0] == 404)

jid = submit_async("rotate", SMALL, {"pages": "99", "angle": 90})
bad = wait_job(jid, {"done", "failed"})
check("script error -> status failed with a readable error", bad.get("status") == "failed" and bool(bad.get("error")), bad)

s, _, j = job("job_doesnotexist")
check("unknown job -> 404", s == 404 and j.get("error") == "job_not_found", (s, j))

# ownership ---------------------------------------------------------------------------------------------
print("== 5b. ownership")
if DATA_DIR:
    def cli(*args: str, stdin: str | None = None):
        return subprocess.run(["node", str(ROOT / "scripts" / "accounts.mjs"), *args], input=stdin, capture_output=True, text=True,
                              env={**os.environ, "KNIFE_DATA_DIR": DATA_DIR}, cwd=ROOT)

    cli("add", "qbob", "--name", "Q Bob")
    cli("set-password", "qbob", stdin="correct horse battery\n")
    req = urllib.request.Request(BASE + "/api/account/login", json.dumps({"id": "qbob", "password": "correct horse battery"}).encode(),
                                 {"Content-Type": "application/json", "Origin": BASE})
    with urllib.request.urlopen(req) as resp:
        cookie = resp.headers.get("Set-Cookie", "").split(";")[0]
    check("second account logged in", cookie.startswith("knife_session="), cookie)
    mine = submit_async("compress", SMALL)
    wait_job(mine, {"done"})
    s, _, j = job(mine, {"Cookie": cookie})
    check("another account cannot read my job (404)", s == 404, (s, j))
    check("...nor its file", call("GET", f"/api/jobs/{mine}/file", None, {"Cookie": cookie})[0] == 404)
    check("...nor delete it", jcall("DELETE", f"/api/jobs/{mine}", headers={"Cookie": cookie})[0] == 404)
    check("the owner still sees it", job(mine)[2].get("status") == "done")
    theirs = submit_async("compress", SMALL, headers={"Cookie": cookie})
    check("the other account's job is invisible to me", job(theirs)[0] == 404 and job(theirs, {"Cookie": cookie})[0] == 200)
    jcall("DELETE", f"/api/jobs/{mine}")
    jcall("DELETE", f"/api/jobs/{theirs}", headers={"Cookie": cookie})
    s, _, _ = pdf("compress", SMALL, asynchronous=True, headers={"Origin": "http://evil.example"})
    check("async submit with a foreign Origin -> 403", s == 403, s)
    s, _, j = jcall("DELETE", f"/api/jobs/{mine}", headers={"Origin": "http://evil.example"})
    check("DELETE with a foreign Origin -> 403", s == 403, s)
else:
    info("skipped (set KNIFE_DATA_DIR to the server's data dir to add a second account)")

# cancel ------------------------------------------------------------------------------------------------
print("== 5c. cancel")
running = submit_async("compress", BIG)
wait_for_proc("pdf")
waiting = submit_async("compress", SMALL)
view = job(waiting)[2]
check("second job is queued behind the running one", view.get("status") == "queued" and view.get("position") == 0, view)
s, _, j = jcall("DELETE", f"/api/jobs/{waiting}")
check("DELETE of a queued job -> cancelled", s == 200 and j.get("status") == "cancelled", (s, j))
check("it never ran (no second python, status stays cancelled)", job(waiting)[2].get("status") == "cancelled" and len(our_procs()) == 1)
t0 = time.time()
s, _, j = jcall("DELETE", f"/api/jobs/{running}")
gone_at_return = not [p for p in our_procs() if p[1] == "pdf"]
check("DELETE of a running job -> cancelled and the process is already gone when it answers", s == 200 and j.get("status") == "cancelled" and gone_at_return, (s, j, our_procs()))
info(f"running-job cancel took {time.time() - t0:.2f}s")
check("GET afterwards shows cancelled", job(running)[2].get("status") == "cancelled")
dsc = submit_async("compress", SMALL)
wait_job(dsc, {"done"})
s, _, j = jcall("DELETE", f"/api/jobs/{dsc}")
check("DELETE of a finished job removes it (and its result)", s == 200 and j.get("status") == "done" and job(dsc)[0] == 404 and call("GET", f"/api/jobs/{dsc}/file")[0] == 404, (s, j))

# TTL reaping --------------------------------------------------------------------------------------------
print("== 5d. TTL reaping (3 s)")
jid = submit_async("compress", SMALL)
fin = wait_job(jid, {"done"})
t_done = time.time()
check("finished job is readable right away", fin.get("status") == "done" and call("GET", f"/api/jobs/{jid}/file")[0] == 200)
live_scratch = [n for n in knife_scratch() if n.startswith("knife-pdf-out-")]
check("its result dir exists while the job lives", len(live_scratch) >= 1, live_scratch)
time.sleep(max(0, 3.6 - (time.time() - t_done)))
check("after the TTL the job is gone (404) and so is its file", job(jid)[0] == 404 and call("GET", f"/api/jobs/{jid}/file")[0] == 404)
time.sleep(0.5)
check("every scratch dir (uploads, results, request/response) has been removed", knife_scratch() == [], knife_scratch())
check("job store is empty", stats()["jobs"]["live"] == 0 and stats()["jobs"]["bytes"] == 0, stats()["jobs"])

# ----------------------------------------------------------------------------------------------- 6. stats
print("== 6. stats")
st = stats()
h, l = st["lanes"]["heavy"], st["lanes"]["light"]
check("heavy lane: completed/cancelled counters moved", h["completed"] > base_completed["heavy"] and h["cancelled"] > base_cancelled["heavy"], h)
check("light lane: completed counter moved", l["completed"] >= base_completed["light"] + 25, l)
check("no slot was ever force-released (leaked == 0)", h["leaked"] == 0 and l["leaked"] == 0, (h, l))
check("percentiles reported", h["waitMs"]["n"] > 0 and h["runMs"]["p95"] >= h["runMs"]["p50"] > 0 and l["runMs"]["n"] > 0, (h["runMs"], l["runMs"]))
check("nothing running or queued at the end", h["running"] == 0 and h["queued"] == 0 and l["running"] == 0 and l["queued"] == 0, (h, l))
info(f"heavy runMs p50/p95 = {h['runMs']['p50']}/{h['runMs']['p95']} ms, waitMs p50/p95 = {h['waitMs']['p50']}/{h['waitMs']['p95']} ms")
check("final: no python process of this checkout is alive", wait_no_procs(3))

print()
print("ALL PASS" if not failures else f"{len(failures)} FAILURES: {failures}")
sys.exit(1 if failures else 0)
