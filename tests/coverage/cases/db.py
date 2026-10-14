"""db group: sql-lab (format, convert, validate, build, schema, run, connect) and nosql-lab (mongo, chroma, redis).

Expected values are written by hand here (SQL contract, urllib.parse, plain arithmetic over the inline CSV); nothing is read
back from the app. Code-generation oracles are tolerant of whitespace but strict on the substantive tokens.
"""
import json
import re
from urllib.parse import quote

from tests.coverage.core import Case, Ctx, first_error, has, matches

GROUP = "db"
SKIPS: dict[tuple[str, str | None], str] = {}


def _num(hay: str, n) -> str | None:
    s = str(n)
    return None if re.search(rf"(?<![\d.]){re.escape(s)}(?![\d])", hay) else f"number {n} not found"


def _hay(c: Ctx) -> str:
    """The agent's reply plus the page. The deterministic knife_* tools (what the system prompt prefers for these jobs) return the result to the
    agent without touching the page, so a prompt that only asks for the code "in your reply" must be judged on the reply."""
    return c.answer + "\n" + c.page_only()


def _ws(pattern: str) -> str:
    """Make every space in a literal pattern match any whitespace run (tolerant to the generator's wrapping)."""
    return r"\s*".join(re.escape(part) for part in pattern.split())


# ---------------------------------------------------------------- sql-lab:format
_FMT_IN = ("select o.id,c.email,sum(oi.qty*oi.unit_price) as revenue from orders o join customers c on c.id=o.customer_id "
           "join order_items oi on oi.order_id=o.id where o.status='paid' and o.placed_at>='2024-01-01' "
           "group by o.id,c.email having sum(oi.qty*oi.unit_price)>250 order by revenue desc")


def _format(c: Ctx):
    p = _hay(c)
    return first_error(
        matches(p, r"SELECT\s*\n\s+\S"),  # pretty-printed: one column per line
        matches(p, r"\nFROM orders"),
        matches(p, r"\n\s*(?:JOIN|INNER JOIN) customers"),
        matches(p, r"\nWHERE"),
        matches(p, r"\nGROUP BY"),
        matches(p, r"\nHAVING"),
        matches(p, r"\nORDER BY"),
        has(p, "o.placed_at", "oi.unit_price", "'paid'", "'2024-01-01'", "250"),
    )


# ---------------------------------------------------------------- sql-lab:convert
# T-SQL has no LIMIT/OFFSET: pagination is `ORDER BY ... OFFSET n ROWS FETCH NEXT m ROWS ONLY` (documented SQL Server syntax).
def _convert(c: Ctx):
    h = c.haystack()
    return first_error(
        matches(h, r"OFFSET\s+35\s+ROWS"),
        matches(h, r"FETCH\s+(?:NEXT|FIRST)\s+7\s+ROWS?\s+ONLY"),
        has(h, "deleted = 0"),
        "backticks survived into T-SQL" if re.search(r"`users`", c.page_only()) and not re.search(r"\[users\]|\busers\b", c.page_only()) else None,
    )


# ---------------------------------------------------------------- sql-lab:validate
_VAL_SQL = ("SELECT id, email FROM customers WHERE active = 1;\n"
            "UPDATE customers SET tier = 'gold' WHERE spent > 5000;\n"
            "INSERT INTO audit_log (actor, action) VALUES ('cron', 'tiering');\n"
            "SELECT id, FROM orders WHERE;\n"
            "DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP;\n")
_VAL_BAD_LINE = next(i for i, l in enumerate(_VAL_SQL.splitlines(), 1) if "FROM orders WHERE;" in l)
assert _VAL_BAD_LINE == 4


def _validate(c: Ctx):
    a = c.answer
    return first_error(
        matches(a, rf"line\s*(?:#|no\.?|number)?\s*{_VAL_BAD_LINE}\b"),
        matches(a, r"error|invalid|syntax|syntactic|not (?:\w+ )?valid|fail|broken|wrong|malformed"),
        "claims the script is valid" if re.search(r"\b(all|every|everything)\b[^.]{0,40}\bvalid\b", a, re.I) and not re.search(r"\bnot\b|\bexcept\b|\binvalid\b", a, re.I) else None,
        "wrongly blames another line" if re.search(r"line\s*(?:#|no\.?|number)?\s*(?:1|2|3|5)\b", a, re.I) and not re.search(r"lines?\s*(?:1|2|3|5)\b[^.]{0,60}(?:fine|ok|valid|clean|good)", a, re.I) else None,
    )


# ---------------------------------------------------------------- sql-lab:build
def _spec_fields(c: Ctx) -> list[dict]:
    out = []
    for v in c.values():
        s = v.strip()
        if not (s.startswith("{") and s.endswith("}")):
            continue
        try:
            d = json.loads(s)
        except ValueError:
            continue
        if isinstance(d, dict) and d.get("op") == "select":
            out.append(d)
    return out


def _build(c: Ctx):
    p = c.page_only()
    specs = _spec_fields(c)
    froms = [s.get("from") for s in specs]
    from_ok = any((f == "shipments") or (isinstance(f, dict) and f.get("name") == "shipments") for f in froms)
    return first_error(
        None if specs else "no JSON query description with op=select is on the page",
        None if from_ok else f"spec is not selecting from shipments: {froms[:2]}",
        matches(p, r"FROM\s+shipments"),
        matches(p, r"IN\s*\(\s*'late'\s*,\s*'lost'\s*\)|IN\s*\(\s*'lost'\s*,\s*'late'\s*\)"),
        matches(p, r"weight_kg\s*>\s*12\.5"),
        matches(p, r"ORDER BY\s+(?:\w+\.)?shipped_at\s+DESC"),
        matches(p, r"LIMIT\s+25"),
        matches(c.answer, r"LIMIT\s+25"),
    )


# ---------------------------------------------------------------- sql-lab:schema
_DDL = ("CREATE TABLE warehouses (id SERIAL PRIMARY KEY, code TEXT NOT NULL UNIQUE, city TEXT);\n"
        "CREATE TABLE suppliers (id SERIAL PRIMARY KEY, name TEXT NOT NULL, country TEXT, vat_id TEXT, rating INTEGER, created_at TIMESTAMP);\n"
        "CREATE TABLE shipments (id SERIAL PRIMARY KEY, warehouse_id INTEGER NOT NULL REFERENCES warehouses(id), "
        "supplier_id INTEGER REFERENCES suppliers(id), weight_kg NUMERIC(8,2), status TEXT);\n"
        "CREATE TABLE shipment_items (shipment_id INTEGER REFERENCES shipments(id), sku TEXT, qty INTEGER, PRIMARY KEY (shipment_id, sku));\n")
_DDL_FKS = _DDL.count("REFERENCES")  # 3
_DDL_COLS = {m.group(1): 1 + len(re.findall(r",\s*(\w+)\s+(?:SERIAL|TEXT|INTEGER|NUMERIC|TIMESTAMP)", m.group(2)))
             for m in re.finditer(r"CREATE TABLE (\w+) \((.*)\);", _DDL)}
_DDL_WIDEST = max(_DDL_COLS, key=_DDL_COLS.get)
assert (_DDL_FKS, _DDL_WIDEST, _DDL_COLS[_DDL_WIDEST]) == (3, "suppliers", 6), (_DDL_FKS, _DDL_COLS)


def _schema(c: Ctx):
    a = c.answer
    return first_error(
        has(_hay(c), "warehouses", "suppliers", "shipments", "shipment_items"),
        matches(a, rf"(?:{_DDL_FKS}|three)\b[^.\n]{{0,60}}foreign|foreign[^.\n]{{0,60}}\b(?:{_DDL_FKS}|three)\b"),
        has(a.lower(), _DDL_WIDEST),
        _num(a, _DDL_COLS[_DDL_WIDEST]),
    )


# ---------------------------------------------------------------- sql-lab:run
_RUN_CSV = ("id,region,product,units,unit_price\n"
            "1,north,anvil,12,19.5\n"
            "2,south,anvil,7,19.5\n"
            "3,north,rope,40,2.25\n"
            "4,east,rope,15,2.25\n"
            "5,south,bolt,300,0.1\n"
            "6,north,bolt,120,0.1\n"
            "7,east,anvil,3,19.5\n")
_run_tot: dict[str, float] = {}
_run_cnt: dict[str, int] = {}
for _row in _RUN_CSV.splitlines()[1:]:
    _, _reg, _, _u, _p = _row.split(",")
    _run_tot[_reg] = round(_run_tot.get(_reg, 0.0) + int(_u) * float(_p), 2)
    _run_cnt[_reg] = _run_cnt.get(_reg, 0) + 1
assert _run_tot == {"north": 336.0, "south": 166.5, "east": 92.25} and _run_cnt == {"north": 3, "south": 2, "east": 2}


def _money(hay: str, v: float) -> str | None:
    forms = {f"{v:.2f}", f"{v:g}", f"{v:.1f}"}
    return None if any(re.search(rf"(?<![\d.]){re.escape(f)}(?![\d])", hay) for f in forms) else f"value {v} not found"


def _run(c: Ctx):
    p = c.page_only()
    a = c.answer
    return first_error(
        *[_money(a, v) for v in _run_tot.values()],
        *[_money(p, v) for v in _run_tot.values()],
        has(a.lower(), "north", "south", "east"),
    )


# ---------------------------------------------------------------- sql-lab:connect
_DSN_PW = "p@ss:w/rd#1"
_DSN_URL = f"postgresql://report_ro:{quote(_DSN_PW, safe='')}@db-eu.example.net:6432/warehouse?sslmode=require"
assert _DSN_URL == "postgresql://report_ro:p%40ss%3Aw%2Frd%231@db-eu.example.net:6432/warehouse?sslmode=require"


def _connect(c: Ctx):
    h = c.haystack()
    return first_error(
        has(h, _DSN_URL),
        has(c.answer, _DSN_URL),
    )


# ---------------------------------------------------------------- nosql-lab:mongo
def _mongo(c: Ctx):
    p = _hay(c)
    return first_error(
        matches(p, _ws("db.invoices.find(")),
        matches(p, r"amount:\s*\{\s*\$gte:\s*250\s*\}"),
        matches(p, r"status:\s*\"overdue\""),
        matches(p, r"\.sort\(\s*\{\s*dueDate:\s*1\s*\}\s*\)"),
        matches(p, r"\.limit\(\s*12\s*\)"),
        matches(p, r"customer:\s*1"),
        matches(p, r"amount:\s*1"),
        matches(c.answer, r"db\.invoices\.find\("),
    )


# ---------------------------------------------------------------- nosql-lab:chroma
def _chroma(c: Ctx):
    p = _hay(c)
    return first_error(
        matches(p, _ws('PersistentClient(path="./vectors")')),
        matches(p, _ws('get_collection(name="recipes")')),
        matches(p, _ws('query_texts=["spicy lentil soup"]')),
        matches(p, r"n_results\s*=\s*7"),
        # both spellings are the same Chroma filter: {"cuisine": "indian"} and {"cuisine": {"$eq": "indian"}}
        matches(p, r'where\s*=\s*\{\s*"cuisine"\s*:\s*(?:"indian"|\{\s*"\$eq"\s*:\s*"indian"\s*\})\s*\}'),
        matches(c.answer, r"n_results\s*=\s*7"),
    )


# ---------------------------------------------------------------- nosql-lab:redis
def _redis(c: Ctx):
    p = _hay(c)
    return first_error(
        matches(p, r"\bSET\s+session:9f3\s+tok-4471\s+EX\s+900\b"),
        matches(p, r"\bINCR\s+visits:home\b"),
        matches(p, r"\bTTL\s+session:9f3\b"),
        matches(p, _ws('.set("session:9f3", "tok-4471", ex=900)')),
        matches(p, r"\.incr\w*\(\s*\"visits:home\""),
        matches(p, _ws('.ttl("session:9f3")')),
        matches(c.answer, r"ex\s*=\s*900"),
    )


CASES = [
    Case("sql-lab", "format", "Pretty-print this SQL for PostgreSQL (uppercase keywords, one column per line, each clause on its own line) and paste the formatted version in your reply:\n\n" + _FMT_IN, _format),
    Case("sql-lab", "convert",
         "This is MySQL; I need the equivalent for SQL Server (T-SQL). Convert it and paste the T-SQL in your reply:\n\n"
         "SELECT id, name FROM `users` WHERE deleted = 0 ORDER BY id LIMIT 7 OFFSET 35;",
         _convert),
    Case("sql-lab", "validate",
         "Check whether this SQL script is syntactically valid. If something is wrong, tell me the line number of the broken statement and what the problem is:\n\n" + _VAL_SQL,
         _validate),
    Case("sql-lab", "build",
         "Build a PostgreSQL query for me from a structured JSON description of the query (not hand-written SQL), so I can tweak it afterwards: "
         "select id, tracking_no and weight_kg from the table shipments where status is one of 'late' or 'lost' AND weight_kg is greater than 12.5, "
         "newest shipped_at first, at most 25 rows. Leave the description and the generated SQL set up on screen, and paste the generated SQL in your reply.",
         _build),
    Case("sql-lab", "schema",
         "Here is the DDL of a small database. Parse it into a schema overview and tell me: how many foreign keys are there in total, and which table has the most columns (and how many)?\n\n" + _DDL,
         _schema),
    Case("sql-lab", "run",
         "Here is a CSV file called inventory_q3.csv:\n\n" + _RUN_CSV + "\n"
         "Load it as a SQL table (it must actually run as SQL in a database, not be computed by hand) and run a query that returns, for each region, "
         "the number of rows and the total stock value (units multiplied by unit_price) rounded to 2 decimals. Tell me the total value per region.",
         _run, timeout_ms=300_000),
    Case("sql-lab", "connect",
         "I need a PostgreSQL connection URL for host db-eu.example.net, port 6432, user report_ro, password p@ss:w/rd#1 and database warehouse, "
         "with the query parameter sslmode=require. The password has to be percent-encoded correctly. Reveal the full URL (with the password) and paste it in your reply.",
         _connect),
    Case("nosql-lab", "mongo",
         "Write me the mongosh command for the MongoDB collection invoices: find documents where amount is at least 250 and status equals \"overdue\", "
         "return only the fields customer and amount (no _id), sorted by dueDate ascending, limited to 12 documents. Paste the mongosh code in your reply.",
         _mongo),
    Case("nosql-lab", "chroma",
         "Give me Python code for Chroma (chromadb) using a persistent client stored at ./vectors: open the existing collection recipes and query it for the 7 nearest "
         "documents to the text \"spicy lentil soup\", only among records whose metadata cuisine is \"indian\". Paste the Python in your reply.",
         _chroma),
    Case("nosql-lab", "redis",
         "I need redis-py code for three Redis commands in a row: set the key session:9f3 to the value tok-4471 expiring after 900 seconds, "
         "increment the counter visits:home by one, then read the remaining TTL of session:9f3. Also show me the equivalent redis-cli lines. Paste the redis-py code in your reply.",
         _redis),
]
