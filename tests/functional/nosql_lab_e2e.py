#!/usr/bin/env python3
"""Real-UI functional tests for the NoSQL and vector lab: /tools/nosql-lab tabs mongo, chroma, redis.

Usage: python3 tests/functional/nosql_lab_e2e.py [base_url] [--shots DIR] [-v]    (default http://127.0.0.1:3273)

Expected code strings are written here by hand from the client syntaxes (never read back from the app), so the
UI is compared with an independent oracle. Also covers form <-> JSON sync, copy, download, named field errors,
the assistant hand-off event, 1280 and 390 px layout (no horizontal overflow) and zero console errors.
Light-theme screenshots of every tab are written with --shots.
"""
import json
import sys
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright

_argv = sys.argv[1:]
SHOTS = Path(_argv[_argv.index("--shots") + 1]) if "--shots" in _argv else None
_ARGS = [a for i, a in enumerate(_argv) if not a.startswith("-") and not (i and _argv[i - 1] == "--shots")]
BASE = (_ARGS[0] if _ARGS else "http://127.0.0.1:3273").rstrip("/")
FAILS: list[str] = []
CONSOLE: list[str] = []
PASSED = 0
page = None


def ok(name):
    global PASSED
    PASSED += 1
    print(f"ok   {name}", flush=True)


def fail(name, err):
    FAILS.append(name)
    print(f"FAIL {name}: {err}", flush=True)


def check(name):
    def deco(fn):
        before = len(CONSOLE)
        try:
            fn()
            if len(CONSOLE) > before:
                raise AssertionError("console/page errors: " + " | ".join(CONSOLE[before:])[:300])
            ok(name)
        except Exception as e:  # noqa: BLE001
            fail(name, f"{type(e).__name__}: {str(e).splitlines()[0] if str(e) else ''}")
            if "-v" in sys.argv:
                traceback.print_exc()
        return fn

    return deco


def eq(actual, expected, what=""):
    assert actual == expected, f"{what}\n  expected: {expected!r}\n  actual:   {actual!r}"


def go(tab, width=1280):
    page.set_viewport_size({"width": width, "height": 900})
    page.goto(f"{BASE}/tools/nosql-lab?tab={tab}", wait_until="domcontentloaded")
    page.wait_for_selector("pre[aria-label$=' code']", timeout=30000)
    page.wait_for_timeout(300)


def L(label):
    """A form control by its Field label."""
    return page.locator(f'label:has(> span:text-is("{label}")) >> :is(textarea,input,select)').first


def code(label):
    return page.locator(f'pre[aria-label="{label} code"]').inner_text()


def spec_json(editor):
    return json.loads(L(editor).input_value())


def problems_text():
    return page.locator('[data-agent-region="problems"]').inner_text()


def alert_text():
    loc = page.locator('[data-agent-region="problems"] [role="alert"]')
    return loc.inner_text() if loc.count() else ""


def no_overflow():
    return page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")


def main():
    global page
    shots = SHOTS
    if shots:
        shots.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True, permissions=["clipboard-read", "clipboard-write"])
        ctx.add_init_script("try{localStorage.setItem('sk-theme','light')}catch(e){}")
        page = ctx.new_page()
        page.on("console", lambda m: CONSOLE.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: CONSOLE.append(str(e)))

        # ================================================================ MongoDB
        @check("mongo: default example renders the exact code of all three clients")
        def _():
            go("mongo")
            eq(code("mongosh"), 'db = db.getSiblingDB("shop");\n\ndb.users.find(\n  { status: "active", age: { $gte: 18 } },\n  { name: 1, email: 1, _id: 0 },\n).sort({ createdAt: -1 }).limit(20);\n')
            eq(
                code("PyMongo"),
                'from pymongo import MongoClient\n\nclient = MongoClient("mongodb://localhost:27017")\ncoll = client["shop"]["users"]\n\ndocs = list(coll.find(\n    {"status": "active", "age": {"$gte": 18}},\n    {"name": 1, "email": 1, "_id": 0},\n    limit=20,\n    sort=[("createdAt", -1)],\n))\nfor doc in docs:\n    print(doc)\n',
            )
            assert 'const docs = await coll.find(' in code("Node.js driver") and "projection: { name: 1, email: 1, _id: 0 }" in code("Node.js driver")
            assert "The MongoDB operation is valid." in problems_text()
            steps = page.locator('[data-agent-region="explanation"] li').all_inner_texts()
            eq(steps[1], 'Find documents where status equals "active" AND age is greater than or equal to 18.')

        @check("mongo: compact option removes wrapping")
        def _():
            go("mongo")
            page.get_by_label("Compact (no wrapping)").check()
            assert 'db.users.find({ status: "active", age: { $gte: 18 } }, { name: 1, email: 1, _id: 0 }).sort({ createdAt: -1 }).limit(20);' in code("mongosh")
            page.get_by_label("Compact (no wrapping)").uncheck()

        @check("mongo: invalid operator shows a role=alert error naming the field, and no code")
        def _():
            go("mongo")
            spec = spec_json("MongoDB spec (JSON)")
            spec["filter"] = {"age": {"$gtt": 5}}
            L("MongoDB spec (JSON)").fill(json.dumps(spec))
            page.wait_for_timeout(200)
            text = alert_text()
            assert "1 error" in text and "filter.age.$gtt" in text and "Unknown query operator $gtt. Did you mean $gt?" in text, text
            assert page.locator('pre[aria-label$=" code"]').count() == 0
            assert "Fix the errors above to see the code." in page.inner_text("main")

        @check("mongo: broken JSON gives a readable error with line/column")
        def _():
            go("mongo")
            L("MongoDB spec (JSON)").fill('{"op": "find", "collection": ')
            page.wait_for_timeout(200)
            text = alert_text()
            assert "Not valid" in text and "line 1" in text, text
            assert "The form needs a spec it can read" in page.inner_text("main")

        @check("mongo: form -> JSON sync (collection, operation switch, filter field)")
        def _():
            go("mongo")
            L("Collection").fill("orders")
            eq(spec_json("MongoDB spec (JSON)")["collection"], "orders")
            L("Operation").select_option("updateOne")
            spec = spec_json("MongoDB spec (JSON)")
            eq(spec["op"], "updateOne")
            eq(spec["update"], {"$set": {}})
            assert "limit" not in spec and "projection" not in spec, spec
            L("Update (JSON)").fill('{"$set": {"status": "done"}}')
            eq(spec_json("MongoDB spec (JSON)")["update"], {"$set": {"status": "done"}})
            assert "updateOne" in code("mongosh") and '$set: { status: "done" }' in code("mongosh")

        @check("mongo: JSON -> form sync, and an incomplete form field keeps the spec")
        def _():
            go("mongo")
            spec = spec_json("MongoDB spec (JSON)")
            spec["collection"] = "invoices"
            spec["limit"] = 7
            L("MongoDB spec (JSON)").fill(json.dumps(spec))
            page.wait_for_timeout(150)
            eq(L("Collection").input_value(), "invoices")
            eq(L("Limit").input_value(), "7")
            L("Filter (JSON)").fill('{"a": ')
            assert "not valid JSON yet" in page.inner_text("main")
            eq(spec_json("MongoDB spec (JSON)")["collection"], "invoices")  # spec untouched
            L("Filter (JSON)").fill('{"a": 1}')
            eq(spec_json("MongoDB spec (JSON)")["filter"], {"a": 1})

        @check("mongo: examples gallery loads a pipeline")
        def _():
            go("mongo")
            page.get_by_role("button", name="Load example: Revenue per customer").click()
            eq(spec_json("MongoDB spec (JSON)")["op"], "aggregate")
            assert "$group" in code("mongosh") and "db.orders.aggregate(" in code("mongosh")

        @check("mongo: mongosh syntax pasted into the editor is converted")
        def _():
            go("mongo")
            L("MongoDB spec (JSON)").fill('{op: "find", collection: "c", filter: {_id: ObjectId("507f1f77bcf86cd799439011"), n: NumberLong("9007199254740993")}}')
            page.wait_for_timeout(200)
            assert "Read your text as mongosh syntax" in page.inner_text("main")
            assert 'ObjectId("507f1f77bcf86cd799439011")' in code("mongosh") and 'NumberLong("9007199254740993")' in code("mongosh")
            assert 'Int64(9007199254740993)' in code("PyMongo")
            page.get_by_role("button", name="Replace editor text with JSON").click()
            eq(spec_json("MongoDB spec (JSON)")["filter"]["_id"], {"$oid": "507f1f77bcf86cd799439011"})

        @check("mongo: copy puts the exact code on the clipboard; download saves it")
        def _():
            go("mongo")
            page.get_by_role("button", name="Copy PyMongo").click()
            page.wait_for_timeout(300)
            eq(page.evaluate("navigator.clipboard.readText()"), code("PyMongo"))
            with page.expect_download() as info:
                page.get_by_role("button", name="Save mongosh as file").click()
            dl = info.value
            eq(dl.suggested_filename, "mongosh.js")
            eq(Path(dl.path()).read_text(), code("mongosh"))
            with page.expect_download() as info:
                page.get_by_role("button", name="Save PyMongo as file").click()
            eq(info.value.suggested_filename, "pymongo.py")
            with page.expect_download() as info:
                page.get_by_role("button", name="Save spec as .json").click()
            eq(json.loads(Path(info.value.path()).read_text())["collection"], "users")

        @check("mongo: language filter shows one snippet")
        def _():
            go("mongo")
            page.get_by_role("button", name="PyMongo", exact=True).click()
            eq(page.locator('pre[aria-label$=" code"]').count(), 1)
            page.get_by_role("button", name="All", exact=True).click()
            eq(page.locator('pre[aria-label$=" code"]').count(), 4)

        @check("mongo: ask-the-assistant emits sk:agent-open with the spec and problems")
        def _():
            go("mongo")
            page.evaluate("window.__open = null; window.addEventListener('sk:agent-open', (e) => { window.__open = e.detail; })")
            page.get_by_role("button", name="Ask the assistant about this spec").click()
            detail = page.evaluate("window.__open")
            assert detail and "knife_mongo_validate" in detail["prompt"] and '"collection": "users"' in detail["prompt"], detail
            assert "MongoDB tab" in detail["prompt"]

        @check("mongo: value converter (shell -> relaxed / canonical / back)")
        def _():
            go("mongo")
            L("Value to convert").fill('{n: NumberInt(5), d: ISODate("2019-08-11T17:54:14.692Z")}')
            L("Convert to").select_option("canonical")
            eq(json.loads(page.locator('output[aria-label="Converted value"]').inner_text()), {"n": {"$numberInt": "5"}, "d": {"$date": {"$numberLong": "1565546054692"}}})
            L("Convert to").select_option("relaxed")
            eq(json.loads(page.locator('output[aria-label="Converted value"]').inner_text()), {"n": 5, "d": {"$date": "2019-08-11T17:54:14.692Z"}})
            L("Value to convert").fill('ObjectId("zz")')
            assert "Cannot convert" in page.inner_text("main")

        # ================================================================== Chroma
        @check("chroma: default query example renders exact Python and JS")
        def _():
            go("chroma")
            eq(
                code("Python (chromadb, PersistentClient)"),
                'import chromadb\n\nclient = chromadb.PersistentClient(path="./chroma")\ncollection = client.get_collection(name="articles")\nresults = collection.query(\n    query_texts=["friendly animals"],\n    n_results=5,\n    where={"year": 2023},\n    where_document={"$not_contains": "talk"},\n)\nprint(results)\n',
            )
            js = code("JavaScript (chromadb npm)")
            assert 'await collection.query({' in js and 'queryTexts: ["friendly animals"]' in js and "nResults: 5" in js and 'whereDocument: { $not_contains: "talk" }' in js, js
            steps = page.locator('[data-agent-region="explanation"] li').all_inner_texts()
            assert steps[3].startswith("For each query, return the 5 nearest records"), steps

        @check("chroma: multi-key where is rejected with the field and the $and fix")
        def _():
            go("chroma")
            spec = spec_json("Chroma spec (JSON)")
            spec["where"] = {"year": 2023, "topic": "dogs"}
            L("Chroma spec (JSON)").fill(json.dumps(spec))
            page.wait_for_timeout(200)
            text = alert_text()
            assert "where" in text and "exactly one condition" in text and "$and" in text, text

        @check("chroma: length mismatch, duplicate ids and nested metadata each name their field")
        def _():
            go("chroma")
            L("Chroma spec (JSON)").fill(json.dumps({"op": "add", "collection": "abc", "ids": ["a", "a", "b"], "documents": ["1", "2"], "metadatas": [{"x": {"y": 1}}]}))
            page.wait_for_timeout(200)
            text = alert_text()
            for needle in ("ids[1]", "documents", "same length", "metadatas[0].x", "nested"):
                assert needle in text, (needle, text)

        @check("chroma: form edits update the JSON (n_results, client type, operation switch)")
        def _():
            go("chroma")
            L("n_results").fill("9")
            eq(spec_json("Chroma spec (JSON)")["n_results"], 9)
            assert "n_results=9" in code("Python (chromadb, PersistentClient)")
            L("Client").select_option("http")
            L("Server host").fill("db.local")
            L("Server port").fill("9000")
            spec = spec_json("Chroma spec (JSON)")
            eq(spec["client"], {"type": "http", "host": "db.local", "port": 9000})
            assert 'chromadb.HttpClient(host="db.local", port=9000)' in code("Python (chromadb, HttpClient)")
            L("Operation").select_option("delete")
            spec = spec_json("Chroma spec (JSON)")
            eq(spec["op"], "delete")
            assert "query_texts" not in spec and "n_results" not in spec, spec
            assert "delete is permanent" in page.inner_text('[data-agent-region="problems"]')

        @check("chroma: add with nasty strings generates escaped Python and JS")
        def _():
            go("chroma")
            L("Chroma spec (JSON)").fill(json.dumps({"op": "add", "collection": "notes", "ids": ["a"], "documents": ['q"uote \\ back\nnew é 日本']}))
            page.wait_for_timeout(200)
            assert 'documents=["q\\"uote \\\\ back\\nnew é 日本"]' in code("Python (chromadb, PersistentClient)")
            assert 'documents: ["q\\"uote \\\\ back\\nnew é 日本"]' in code("JavaScript (chromadb npm)")

        @check("chroma: example gallery + downloads")
        def _():
            go("chroma")
            page.get_by_role("button", name="Load example: Create a cosine-distance collection").click()
            assert 'configuration={"hnsw": {"space": "cosine"}}' in code("Python (chromadb, PersistentClient)")
            with page.expect_download() as info:
                page.get_by_role("button", name="Save JavaScript (chromadb npm) as file").click()
            eq(info.value.suggested_filename, "javascript-chromadb-npm.mjs")
            assert "getOrCreateCollection" in Path(info.value.path()).read_text()

        # =================================================================== Redis
        @check("redis: default example renders exact redis-cli / redis-py / node-redis")
        def _():
            go("redis")
            eq(code("redis-cli"), "SET user:1:name Ada EX 60\nGET user:1:name\nTTL user:1:name\n")
            eq(code("redis-py"), 'import redis\n\nr = redis.Redis(host="localhost", port=6379, db=0, decode_responses=True)\n\nprint(r.set("user:1:name", "Ada", ex=60))\nprint(r.get("user:1:name"))\nprint(r.ttl("user:1:name"))\n')
            node = code("node-redis")
            assert 'client.set("user:1:name", "Ada", { EX: 60 })' in node and 'createClient({ url: "redis://localhost:6379" })' in node
            steps = page.locator('[data-agent-region="explanation"] li').all_inner_texts()
            assert steps[1].startswith("1. SET user:1:name Ada EX 60: Sets the string value of a key") and "Complexity: O(1)" in steps[1], steps

        @check("redis: command lines <-> JSON spec sync")
        def _():
            go("redis")
            L("Commands (one redis-cli command per line)").fill('SET greeting "hello world" EX 10\nHSET h a 1 b 2')
            spec = spec_json("Redis spec (JSON)")
            eq(spec["ops"], [{"command": "SET", "args": ["greeting", "hello world", "EX", "10"]}, {"command": "HSET", "args": ["h", "a", "1", "b", "2"]}])
            eq(code("redis-cli"), 'SET greeting "hello world" EX 10\nHSET h a 1 b 2\n')
            assert 'r.hset("h", mapping={"a": "1", "b": "2"})' in code("redis-py")
            spec["ops"].append({"command": "GET", "args": ["greeting"]})
            L("Redis spec (JSON)").fill(json.dumps(spec))
            page.wait_for_timeout(150)
            assert L("Commands (one redis-cli command per line)").input_value().endswith("GET greeting")

        @check("redis: wrong command, bad option and arity name the exact argument")
        def _():
            go("redis")
            L("Commands (one redis-cli command per line)").fill('STE a b\nSET k v EXX 5\nGET a b')
            page.wait_for_timeout(200)
            text = alert_text()
            for needle in ("ops[0].command", "Did you mean SET?", "ops[1].args[2]", 'Unexpected argument "EXX"', "ops[2].args", "exactly 1 argument, got 2"):
                assert needle in text, (needle, text)
            assert page.locator('pre[aria-label$=" code"]').count() == 0

        @check("redis: KEYS * compiles with warnings and complexity in the explanation")
        def _():
            go("redis")
            L("Commands (one redis-cli command per line)").fill("KEYS *")
            page.wait_for_timeout(200)
            text = problems_text()
            assert "KEYS walks every key" in text and "Use SCAN" in text, text
            assert "Complexity: O(N)" in page.locator('[data-agent-region="explanation"]').inner_text()
            assert code("redis-cli") == "KEYS *\n"

        @check("redis: transaction mode, connection settings, TLS")
        def _():
            go("redis")
            L("How to run them").select_option("transaction")
            L("Host").fill("cache.internal")
            L("Port").fill("6380")
            L("Database number").fill("3")
            page.get_by_label("Use TLS (rediss://)").check()
            assert code("redis-cli").startswith("SELECT 3\nMULTI\nSET user:1:name Ada EX 60\n") and code("redis-cli").endswith("EXEC\n"), code("redis-cli")
            assert 'redis.Redis(host="cache.internal", port=6380, db=3, ssl=True, decode_responses=True)' in code("redis-py")
            assert "r.pipeline(transaction=True)" in code("redis-py")
            assert 'url: "rediss://cache.internal:6380/3"' in code("node-redis") and ".multi()" in code("node-redis")
            eq(spec_json("Redis spec (JSON)")["connection"], {"host": "cache.internal", "port": 6380, "db": 3, "tls": True})

        @check("redis: hand-written MULTI is an error that points at mode")
        def _():
            go("redis")
            L("Commands (one redis-cli command per line)").fill("MULTI\nSET a 1\nEXEC")
            page.wait_for_timeout(200)
            assert 'Set "mode": "transaction"' in alert_text() or "transaction" in alert_text(), alert_text()

        @check("redis: command reference lookup shows syntax, complexity and pitfalls")
        def _():
            go("redis")
            L("Look up a command").fill("expire")
            page.wait_for_function("document.querySelector('output[aria-label=\"Matching commands\"]').innerText.includes('EXPIRE key seconds')")
            out = page.locator('output[aria-label="Matching commands"]').inner_text()
            assert "EXPIRE key seconds [NX | XX | GT | LT]" in out and "O(1)" in out, out
            L("Look up a command").fill("keys")
            page.wait_for_function("document.querySelector('output[aria-label=\"Matching commands\"]').innerText.startsWith('KEYS')")
            assert "Watch out: KEYS walks every key" in page.locator('output[aria-label="Matching commands"]').inner_text()
            L("Look up a command").fill("zzzz")
            page.wait_for_function("document.querySelector('output[aria-label=\"Matching commands\"]').innerText.includes('No command')")
            assert "No command matches." in page.locator('output[aria-label="Matching commands"]').inner_text()

        @check("redis: examples + big ints + ask assistant prompt")
        def _():
            go("redis")
            page.get_by_role("button", name="Load example: Leaderboard with a sorted set").click()
            assert 'r.zadd("leaders", {"ada": 120, "bob": 95, "cy": 200})' in code("redis-py")
            page.evaluate("window.__open = null; window.addEventListener('sk:agent-open', (e) => { window.__open = e.detail; })")
            page.get_by_role("button", name="Ask the assistant about this spec").click()
            assert "knife_redis_validate" in page.evaluate("window.__open")["prompt"] and "ZADD" in page.evaluate("window.__open")["prompt"]

        # ========================================================= layout + shots
        for tab in ("mongo", "chroma", "redis"):
            for width in (1280, 390):

                @check(f"{tab}: no horizontal overflow at {width}px")
                def _(tab=tab, width=width):
                    go(tab, width)
                    assert no_overflow(), page.evaluate("document.documentElement.scrollWidth")
                    # every code block and the spec editor stay inside the viewport
                    boxes = page.evaluate(
                        "Array.from(document.querySelectorAll('main pre, main textarea, main section')).map(e => { const r = e.getBoundingClientRect(); return [e.tagName, Math.round(r.left), Math.round(r.right)]; })"
                    )
                    bad = [b for b in boxes if b[2] > width + 1 or b[1] < -1]
                    assert not bad, bad[:3]
                    if shots:
                        # fresh context so the assistant panel opened by earlier tests is not in the picture
                        fresh = browser.new_context(viewport={"width": width, "height": 900})
                        fresh.add_init_script("try{localStorage.setItem('sk-theme','light')}catch(e){}")
                        shot_page = fresh.new_page()
                        shot_page.goto(f"{BASE}/tools/nosql-lab?tab={tab}", wait_until="domcontentloaded")
                        shot_page.wait_for_selector("pre[aria-label$=' code']", timeout=30000)
                        shot_page.wait_for_timeout(500)
                        shot_page.screenshot(path=str(shots / f"nosql-{tab}-{width}.png"), full_page=True)
                        fresh.close()

        browser.close()

    print(f"\n{PASSED} passed, {len(FAILS)} failed")
    if FAILS:
        print("FAILED:", *FAILS, sep="\n  ")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
