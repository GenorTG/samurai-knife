"""Real model, plain-language database requests, judged by oracles that do not trust the model.

SCRATCH server only (own KNIFE_DATA_DIR, own port); the key is read at runtime by tests/real_provider.py.
  KNIFE_DATA_DIR=$(mktemp -d) KNIFE_PORT=3245 npm run dev   # then:
  python3 tests/agent_sql_real_e2e.py http://127.0.0.1:3245 [--cases pg_top3,tsql_monthly] [--model deepseek-v4-flash]

SQL answers: the last ```sql block of the reply is taken apart by the repo's own engine (server/py/scripts/sql_tool.py,
called directly): it must validate in the asked dialect with zero errors, pass `check` against the schema, and, after being
transpiled to SQLite, return the same rows as a hand-written reference query on a fixture database.
Non-SQL answers: every Python block must parse (ast), and the required tokens must be present.
"""
import argparse
import ast
import json
import re
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from real_provider import configure  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("base")
ap.add_argument("--model", default="deepseek-v4-flash")
ap.add_argument("--cases", default="")
args = ap.parse_args()
BASE = args.base.rstrip("/")
PY = str(ROOT.parent / "samurai-knife-py" / "venv" / "bin" / "python")
ENGINE = str(ROOT / "server" / "py" / "scripts" / "sql_tool.py")

DDL = """CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT, created_at TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), total REAL NOT NULL, ordered_at TEXT NOT NULL);"""

USERS = [(1, "Ann", "Warsaw", "2023-01-05"), (2, "Bob", "Krakow", "2023-02-10"), (3, "Cleo", "Warsaw", "2023-03-15"),
         (4, "Dan", "Gdansk", "2023-04-20"), (5, "Eve", "Krakow", "2023-05-25")]
ORDERS = [(1, 1, 120.0, "2024-01-03"), (2, 1, 80.0, "2024-01-17"), (3, 2, 45.5, "2024-02-02"), (4, 3, 300.0, "2024-02-20"),
          (5, 3, 10.0, "2024-03-01"), (6, 4, 60.0, "2024-03-09"), (7, 5, 75.0, "2024-03-30"), (8, 2, 99.5, "2024-03-31"),
          (9, 1, 5.0, "2023-12-31")]

failures: list[str] = []
errors: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f"  -> {detail}"))
    if not ok:
        failures.append(name)


def fixture() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.executescript(DDL)
    db.executemany("INSERT INTO users VALUES (?,?,?,?)", USERS)
    db.executemany("INSERT INTO orders VALUES (?,?,?,?)", ORDERS)
    return db


def engine(action: str, params: dict) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        rq, rs = Path(tmp, "request.json"), Path(tmp, "response.json")
        rq.write_text(json.dumps({"action": action, "params": params}))
        subprocess.run([PY, ENGINE, str(rq), str(rs)], check=False, capture_output=True, timeout=60)
        return json.loads(rs.read_text())


# Knife's prompt tells the model to name the dialect in the fence (```postgresql, ```mysql ...): all of these are SQL.
SQL_FENCES = ("sql", "mysql", "mariadb", "postgresql", "postgres", "pgsql", "psql", "plpgsql", "sqlite", "sqlite3", "tsql", "mssql", "transact-sql",
              "oracle", "plsql", "bigquery", "snowflake", "redshift", "duckdb", "trino", "presto", "spark", "sparksql", "hive", "clickhouse")


def blocks(answer: str, *langs: str) -> list[str]:
    found = re.findall(r"```([A-Za-z0-9_+-]*)\n(.*?)```", answer, re.S)
    return [body for lang, body in found if not langs or lang.lower() in langs]


def norm(rows: list[tuple]) -> list[tuple]:
    return sorted(tuple(round(v, 2) if isinstance(v, float) else v for v in r) for r in rows)


def sql_case(dialect: str, expect_sql: str, width: int):
    """Oracle for a SELECT answer: validates, checks against the schema, and matches the reference rows after transpile to sqlite."""
    def oracle(answer: str, tools: list[str]) -> list[tuple[str, bool, object]]:
        out: list[tuple[str, bool, object]] = []
        sql_blocks = blocks(answer, *SQL_FENCES)
        out.append(("answer contains a sql block", bool(sql_blocks), answer[:200]))
        if not sql_blocks:
            return out
        sql = sql_blocks[-1].strip()
        v = engine("validate", {"sql": sql, "dialect": dialect})
        errs = [i for i in v.get("data", {}).get("issues", []) if i.get("level") == "error"]
        out.append((f"validates in {dialect}", v.get("ok") and not errs, v))
        schema = engine("schema", {"ddl": DDL, "dialect": "sqlite"})["data"]["schema"]
        c = engine("check", {"sql": sql, "dialect": dialect, "schema": schema})
        out.append(("passes check against the schema", c.get("ok") and c["data"]["ok"], c))
        t = engine("transpile", {"sql": sql, "from": dialect, "to": "sqlite"})
        got = None
        try:
            got = norm([r[:width] for r in fixture().execute(t["data"]["sql"]).fetchall()])
        except Exception as exc:  # noqa: BLE001 - reported as the failure detail
            out.append(("runs on the fixture after transpile to sqlite", False, f"{exc} :: {t}"))
            return out
        want = norm(fixture().execute(expect_sql).fetchall())
        out.append(("same rows as the reference query", got == want, {"got": got, "want": want}))
        out.append(("used knife_sql_check", "knife_sql_check" in tools, tools))
        return out
    return oracle


def transpile_oracle(answer: str, tools: list[str]) -> list[tuple[str, bool, object]]:
    sql_blocks = blocks(answer, *SQL_FENCES)
    sql = sql_blocks[-1] if sql_blocks else ""
    v = engine("validate", {"sql": sql, "dialect": "postgres"}) if sql else {"ok": False}
    errs = [i for i in v.get("data", {}).get("issues", []) if i.get("level") == "error"]
    return [
        ("answer contains a sql block", bool(sql_blocks), answer[:200]),
        ("validates in postgres", bool(sql) and v.get("ok") and not errs, v),
        ("no SQLite-only strftime left", "strftime" not in sql.lower(), sql),
        ("used a knife_sql tool instead of guessing", any(t.startswith("knife_sql_") for t in tools), tools),
    ]


def trap_oracle(answer: str, tools: list[str]) -> list[tuple[str, bool, object]]:
    sql = "\n".join(blocks(answer, *SQL_FENCES))
    low = answer.lower()
    return [
        ("did not invent a phone column in SQL", "phone" not in sql.lower(), sql),
        ("said the schema has no phone column", "phone" in low and any(w in low for w in ("no ", "not ", "doesn't", "does not", "isn't", "missing", "n't")), answer[:240]),
    ]


def upsert_oracle(answer: str, tools: list[str]) -> list[tuple[str, bool, object]]:
    sql_blocks = blocks(answer, *SQL_FENCES)
    sql = sql_blocks[-1] if sql_blocks else ""
    v = engine("validate", {"sql": sql, "dialect": "mysql"}) if sql else {"ok": False}
    errs = [i for i in v.get("data", {}).get("issues", []) if i.get("level") == "error"]
    return [
        ("answer contains a sql block", bool(sql_blocks), answer[:200]),
        ("validates in mysql", bool(sql) and v.get("ok") and not errs, v),
        ("uses ON DUPLICATE KEY UPDATE", "on duplicate key update" in sql.lower(), sql),
    ]


def py_blocks_parse(answer: str) -> tuple[bool, object]:
    py = blocks(answer, "python", "py")
    if not py:
        return False, "no python block"
    for b in py:
        try:
            ast.parse(b)
        except SyntaxError as exc:
            return False, f"{exc}: {b[:120]}"
    return True, ""


def mongo_oracle(answer: str, tools: list[str]) -> list[tuple[str, bool, object]]:
    ok, why = py_blocks_parse(answer)
    return [("python block parses", ok, why),
            ("has the age > 30 and Warsaw filter", all(t in answer for t in ("$gt", "30", "Warsaw")), answer[:200]),
            ("sorts newest first", bool(re.search(r"-1|DESC|descending", answer)), answer[:200]),
            ("used knife_mongo_compile", "knife_mongo_compile" in tools, tools)]


def chroma_oracle(answer: str, tools: list[str]) -> list[tuple[str, bool, object]]:
    ok, why = py_blocks_parse(answer)
    return [("python block parses", ok, why),
            ("two metadata conditions joined with $and", "$and" in answer and "$gte" in answer and "category" in answer, answer[:240]),
            ("asks for 5 results", bool(re.search(r"n_results\s*=\s*5", answer)), answer[:240]),
            ("used knife_chroma_compile", "knife_chroma_compile" in tools, tools)]


def redis_oracle(answer: str, tools: list[str]) -> list[tuple[str, bool, object]]:
    up = answer.upper()
    return [("uses INCR and EXPIRE (or a Lua/transaction equivalent)", "INCR" in up and ("EXPIRE" in up or "SET" in up), answer[:240]),
            ("shows redis-cli or redis-py", "redis-cli" in answer.lower() or "redis.Redis" in answer or "import redis" in answer, answer[:200]),
            ("used a knife_redis tool", any(t.startswith("knife_redis_") for t in tools), tools)]


SCHEMA_PROMPT = "My database schema is:\n" + DDL + "\n"
CASES = {
    "pg_top3": (SCHEMA_PROMPT + "In PostgreSQL, which 3 users have the highest total order amount? Show the user name and the total.",
                sql_case("postgres", "SELECT u.name, SUM(o.total) FROM users u JOIN orders o ON o.user_id = u.id GROUP BY u.id, u.name ORDER BY SUM(o.total) DESC LIMIT 3", 2)),
    "tsql_monthly": (SCHEMA_PROMPT + "For SQL Server: how many orders were placed in each calendar month of 2024? Give the month number and the count.",
                     sql_case("tsql", "SELECT CAST(strftime('%m', ordered_at) AS INTEGER), COUNT(*) FROM orders WHERE strftime('%Y', ordered_at) = '2024' GROUP BY 1", 2)),
    "mysql_city_avg": (SCHEMA_PROMPT + "For MySQL: average order total per user city, only cities with at least 2 orders, highest average first. Show city and average.",
                       sql_case("mysql", "SELECT u.city, AVG(o.total) FROM users u JOIN orders o ON o.user_id = u.id GROUP BY u.city HAVING COUNT(*) >= 2 ORDER BY AVG(o.total) DESC", 2)),
    "sqlite_no_orders": (SCHEMA_PROMPT + "In SQLite: names of users who have never placed an order.",
                         sql_case("sqlite", "SELECT name FROM users WHERE id NOT IN (SELECT user_id FROM orders)", 1)),
    "transpile_pg": ("Convert this SQLite query for PostgreSQL and tell me what changed: SELECT name, strftime('%Y', created_at) AS yr FROM users WHERE city = 'Warsaw' LIMIT 3", transpile_oracle),
    "trap_phone": (SCHEMA_PROMPT + "In PostgreSQL show each user's name and phone number.", trap_oracle),
    "mysql_upsert": (SCHEMA_PROMPT + "For MySQL: insert the user with id 1, name 'Ann', city 'Warsaw', or update the name and city if that id already exists.", upsert_oracle),
    "mongo_find": ("Write a MongoDB query for users older than 30 who live in Warsaw, newest first (field createdAt), as PyMongo code.", mongo_oracle),
    "chroma_query": ("Using Chroma in Python: get the 5 nearest documents to the text 'refund policy' from the collection 'docs', only where the metadata category is 'legal' and year is at least 2024.", chroma_oracle),
    "redis_limiter": ("Which Redis commands do I need for a rate limiter that allows 10 requests a minute per user? Show redis-cli and redis-py.", redis_oracle),
}
selected = [c for c in (args.cases.split(",") if args.cases else CASES) if c]


def history(page: Page, k: str) -> list[dict]:
    return json.loads(page.evaluate("k => localStorage.getItem(k) || '[]'", k))


def run_prompt(page: Page, k: str, prompt: str, timeout_s: int = 300) -> tuple[str, list[str], int]:
    n_user = sum(1 for m in history(page, k) if m["role"] == "user") + 1
    box = page.locator("textarea[aria-label='Message the assistant']")
    box.fill(prompt)
    box.press("Enter")
    done = """([k, n]) => { const m = JSON.parse(localStorage.getItem(k) || '[]');
        if (m.filter(x => x.role === 'user').length < n) return false;
        const l = m[m.length - 1]; return (l.role === 'assistant' && !l.tool_calls) || l.role === 'notice'; }"""
    for _ in range(timeout_s * 10):
        if page.locator("[data-agent-approval]").count():
            page.get_by_role("button", name="Allow", exact=True).click()
        if page.evaluate(done, [k, n_user]):
            break
        page.wait_for_timeout(100)
    else:
        return "", [], 0
    ms = history(page, k)
    last_user = max(i for i, m in enumerate(ms) if m["role"] == "user")
    turn = ms[last_user:]
    tools = [c["function"]["name"] for m in turn if m["role"] == "assistant" for c in m.get("tool_calls", [])]
    answer = next((m["content"] for m in reversed(turn) if m["role"] == "assistant" and not m.get("tool_calls") and m.get("content")), "")
    return answer, tools, sum(1 for m in turn if m["role"] == "assistant")


configure(BASE, args.model)
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
    page.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))
    page.goto(BASE + "/tools/sql-lab?tab=build", wait_until="networkidle")
    page.keyboard.press("Control+j")
    page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']")
    k = page.evaluate("fetch('/api/account').then(r => r.json()).then(a => `sk.agent.chat.v1.${a.id}:${encodeURIComponent(a.provider?.baseUrl ?? '')}:${encodeURIComponent(a.provider?.model ?? '')}`)")
    for name in selected:
        prompt, oracle = CASES[name]
        page.locator("button[aria-label='Clear conversation']").click() if page.locator("button[aria-label='Clear conversation']").is_enabled() else None
        answer, tools, rounds = run_prompt(page, k, prompt)
        print(f"--- {name}: rounds={rounds} tools={' '.join(tools)}")
        if not answer:
            check(f"{name}: run finished with an answer", False, "no answer within the time limit")
            continue
        for label, ok, detail in oracle(answer, tools):
            check(f"{name}: {label}", bool(ok), detail)
    browser.close()

check("zero console errors", not errors, errors[:3])
print("\nall checks passed" if not failures else f"\n{len(failures)} FAILED: {failures}")
sys.exit(1 if failures else 0)
