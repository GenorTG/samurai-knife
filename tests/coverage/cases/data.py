"""Data group: csv-profile, sql-format, json, yaml-json, csv, regex."""
import csv
import io
import json
import re
import xml.etree.ElementTree as ET

from tests.coverage.core import Case, Ctx, first_error, has, matches

GROUP = "data"
SKIPS: dict[tuple[str, str | None], str] = {
    ("workflows", "credentials"): "secrets are typed by the user only, by design the assistant never handles credential values (docs/WORKFLOWS.md); covered by tests/workflow_credentials.test.mjs and workflows_e2e",
}


# ------------------------------------------------------------------ helpers
def _rows(text: str) -> list[list[str]]:
    return list(csv.reader(io.StringIO(text)))


def _csv_text(rows: list[list[str]]) -> str:
    out = io.StringIO()
    csv.writer(out, lineterminator="\n").writerows(rows)
    return out.getvalue()


def _blobs(text: str):
    """Every JSON object/array that can be decoded starting at some '{' or '[' in text."""
    dec = json.JSONDecoder()
    for m in re.finditer(r"[{\[]", text):
        try:
            yield dec.raw_decode(text[m.start():])[0]
        except ValueError:
            continue


def _has_json(hay: str, expected) -> str | None:
    return None if any(b == expected for b in _blobs(hay)) else "no JSON value equal to the expected document in output"


def _num(n) -> str:
    return rf"(?<![\d.,]){re.escape(str(n))}(?![\d]|\.\d)"


def _near(hay: str, word_re: str, n) -> str | None:
    p = _num(n)
    return None if re.search(rf"{word_re}[^\n]{{0,80}}{p}|{p}[^\n]{{0,80}}{word_re}", hay, re.I) else f"{n} not stated near /{word_re}/"


def _has_nums(hay: str, nums) -> str | None:
    miss = [n for n in nums if not re.search(_num(n), hay)]
    return None if not miss else f"missing numbers {miss}"


def _norm(s: str) -> str:
    return s.replace("\r", "")


# ------------------------------------------------------------------ csv-profile
_PROFILE = (
    "id,amount,member,signup,city\n"
    "101,19.5,true,2024-02-11,Oslo\n"
    "102,,false,2024-03-02,Lima\n"
    "103,7.25,true,,Oslo\n"
    "104,12,,2025-01-20,Quito\n"
    "105,,false,2025-02-09,Lima\n"
    "106,3.75,true,2025-04-30,\n"
    "107,41,false,2025-05-17,Oslo\n"
    "108,,true,2025-06-01,Quito\n"
)
_pr = _rows(_PROFILE)
_p_hdr, _p_data = _pr[0], _pr[1:]
_p_missing = {h: sum(1 for r in _p_data if r[i].strip() == "") for i, h in enumerate(_p_hdr)}
_p_total = sum(_p_missing.values())
_p_worst = max(_p_missing, key=_p_missing.get)
_p_cities = len({r[4] for r in _p_data if r[4]})


def _oracle_profile(c: Ctx):
    a = c.answer
    return first_error(
        _near(a, r"missing|empty|blank|null", _p_total),
        _near(a, r"distinct|unique|different", _p_cities),
        has(a, _p_worst, ci=True),
    )


# ------------------------------------------------------------------ csv-profile duplicates
_DUP = "id,name,city\n7,Ann,Oslo\n8,Bo,Lima\n7,Ann,Oslo\n9,Cy,Rome\n8,BO,LIMA\n10,Di,Kyiv\n9,Cy,Rome\n7,ANN,oslo\n"
_seen: set = set()
_dup_lines: list[int] = []
for _i, _r in enumerate(_rows(_DUP), 1):
    _k = tuple(x.lower() for x in _r)
    if _k in _seen:
        _dup_lines.append(_i)
    _seen.add(_k)

# ------------------------------------------------------------------ delimiter

# ------------------------------------------------------------------ compare
_LEFT = "sku,qty,price\nA1,10,2.50\nB2,4,9.00\nC3,7,1.25\nD4,2,5.00\n"
_RIGHT = "sku,qty,price\nA1,10,2.50\nB2,5,9.00\nC3,7,1.50\nE5,2,5.00\nF6,1,3.00\n"
_la, _ra = _rows(_LEFT), _rows(_RIGHT)
_cmp_n = 0
for _i in range(max(len(_la), len(_ra))):
    for _j in range(3):
        _x = _la[_i][_j] if _i < len(_la) else None
        _y = _ra[_i][_j] if _i < len(_ra) else None
        _cmp_n += _x != _y

# ------------------------------------------------------------------ sql
_SQL = ("select c.name, sum(o.total) as spent from customers c inner join orders o on o.cid = c.id "
        "where o.status = 'paid' and o.total > 100 group by c.name having sum(o.total) > 500 order by spent desc limit 5;")


def _oracle_sql(c: Ctx):
    hay = _norm(c.page_only() + "\n" + c.answer)
    for kw in ("SELECT", "FROM", "WHERE", "GROUP BY", "HAVING", "ORDER BY", "LIMIT"):
        if not re.search(rf"(?m)^[ \t]*{kw}\b", hay):
            return f"no line starting with uppercase {kw}"
    if not re.search(r"(?m)^[ \t]*(INNER JOIN|JOIN)\b", hay):
        return "no line starting with JOIN"
    if "'paid'" not in hay:
        return "string literal 'paid' was altered or lost"
    return None


# ------------------------------------------------------------------ json
_J = {"zeta": [3, 1, 2], "alpha": {"y": True, "x": None, "b": {"q": 1.5, "p": "s"}}, "mid": "v"}
_J_EXPECT = _norm(json.dumps(_J, indent=4, sort_keys=True))
_J_MIN = json.dumps(_J, separators=(",", ":"))


def _oracle_lint(c: Ctx):
    hay = _norm(c.haystack())
    if _J_EXPECT not in hay:
        return "output is not the 4-space-indented, key-sorted JSON"
    return None


_ORDERS = {"orders": [
    {"id": "o-1", "lines": [{"sku": "KX-114", "qty": 2}, {"sku": "KX-220", "qty": 1}]},
    {"id": "o-2", "lines": [{"sku": "ZP-905", "qty": 4}, {"sku": "ZP-317", "qty": 9}, {"sku": "ZP-662", "qty": 1}]},
    {"id": "o-3", "lines": [{"sku": "QW-481", "qty": 3}]},
]}
_path_exp = [l["sku"] for l in _ORDERS["orders"][1]["lines"]]
_path_other = [l["sku"] for i in (0, 2) for l in _ORDERS["orders"][i]["lines"]]


def _oracle_path(c: Ctx):
    a = c.answer
    bad = [s for s in _path_other if s in a]
    return first_error(has(a, *_path_exp), f"answer includes SKUs of other orders: {bad}" if bad else None)


_PTR_DOC = {
    "a/b": {"m~n": ["plain-1", "plain-2", "quartz-9931"], "other": "quartz-9931x"},
    "a": {"b": {"m": ["wrong-0", "wrong-1", "wrong-2"]}},
}
assert _PTR_DOC["a/b"]["m~n"][2] == "quartz-9931"

_DIAG = {"cluster": {"name": "eu-west", "servers": [{"h": f"s{i}"} for i in range(7)],
                     "limits": {"cpu": 4, "mem": 16, "disk": 100, "net": 10, "gpu": 0},
                     "tags": ["a", "b", "c", "d", "e", "f", "g", "h", "i"]}}
_dg_servers = len(_DIAG["cluster"]["servers"])
_dg_limits = len(_DIAG["cluster"]["limits"])
_dg_tags = len(_DIAG["cluster"]["tags"])

_SCHEMA = {"type": "object", "required": ["name", "age", "role"], "additionalProperties": False,
           "properties": {"name": {"type": "string", "minLength": 1},
                          "age": {"type": "integer", "minimum": 18},
                          "role": {"enum": ["admin", "editor", "viewer"]}}}
_SDOC = {"name": "Mira", "age": 17, "role": "root"}


def _oracle_schema(c: Ctx):
    a = c.answer
    return first_error(
        matches(a, r"invalid|not valid|fail|does not (conform|validate|match|pass)|doesn't|violat|errors?"),
        has(a, "age", "role", ci=True),
        None if "root" in a or "enum" in a.lower() or "admin" in a else "role problem not explained",
        None if "18" in a or "minimum" in a.lower() else "age problem not explained",
    )


_ND = ['{"id":1,"ok":true}', '{"id":2,"ok":false', '{"id":3,"ok":true}', '', "{'id':4}",
       '{"id":5,"ok":true}', '{"id":6}}', '{"id":7,"tags":[1,2]}', '{"id":8,"ok":null}']
_nd_bad, _nd_ok = [], 0
for _i, _l in enumerate(_ND, 1):
    if not _l.strip():
        continue
    try:
        json.loads(_l)
        _nd_ok += 1
    except ValueError:
        _nd_bad.append(_i)


# ------------------------------------------------------------------ yaml-json
_YAML = """service: api-gw
replicas: 3
ports: [8472, 9091]
env:
  - name: LOG_LEVEL
    value: debug
  - name: REGION
    value: eu-north-2
limits: &lim
  cpu: 250m
  mem: 512Mi
sidecar:
  enabled: false
  limits: *lim
"""
_YAML_EXPECT = {
    "service": "api-gw", "replicas": 3, "ports": [8472, 9091],
    "env": [{"name": "LOG_LEVEL", "value": "debug"}, {"name": "REGION", "value": "eu-north-2"}],
    "limits": {"cpu": "250m", "mem": "512Mi"},
    "sidecar": {"enabled": False, "limits": {"cpu": "250m", "mem": "512Mi"}},
}

_INI = ("[core]\nname = demo\nmode = fast\n\n[net]\nhost = a.local\nport = 80\nhost = b.local\n"
        "broken line here\n[core]\ndebug = 1\n")
_ini_bad: dict[int, str] = {}
_secs: set = set()
_keys: set = set()
_cur = ""
for _i, _raw in enumerate(_INI.split("\n"), 1):
    _l = _raw.strip()
    if not _l or _l[0] in ";#":
        continue
    if _l.startswith("["):
        _cur = _l[1:-1]
        if _cur in _secs:
            _ini_bad[_i] = "dup-section"
        _secs.add(_cur)
        continue
    if "=" not in _l:
        _ini_bad[_i] = "malformed"
        continue
    _k = _l.split("=", 1)[0].strip()
    if (_cur, _k) in _keys:
        _ini_bad[_i] = "dup-key"
    _keys.add((_cur, _k))
assert sorted(_ini_bad) == [8, 9, 10], _ini_bad


_XML = ('<inventory><item type="tool"><name>Saw</name><price>14.75</price></item>'
        '<item type="toy"><name>Kite</name><price>8.4</price></item>'
        '<item type="tool"><name>Plane</name><price>31.2</price></item>'
        '<item type="food"><name>Jam</name><price>3.15</price></item>'
        '<item type="tool"><name>File</name><price>9.1</price></item></inventory>')
_xml_sum = sum(float(i.find("price").text) for i in ET.fromstring(_XML) if i.get("type") == "tool")
_xml_sum_s = f"{_xml_sum:.2f}"
assert _xml_sum_s == "55.05", _xml_sum_s

# ------------------------------------------------------------------ csv
_CSV = "name,age,city\nAnn,4172,Oslo\nBo,3318,Lima\n"

_COLS = ("order_id,customer,country,amount,notes\n"
         "9001,Hana Ito,JP,418.20,gift wrap\n9002,Luc Roy,FR,57.90,\n9003,\"Kim, Sun\",KR,1204.00,\"rush, fragile\"\n")
_cols_expect = _csv_text([[r[1], r[3]] for r in _rows(_COLS)])

_M1 = "id,name,note\n11,Ada,first\n12,\"Lin, Wei\",\"said \"\"hi\"\"\"\n"
_M2 = "id,name,note\n13,Grace,third\n14,Alan,\n"
_m_hdr = _rows(_M1)[0]
_merge_expect = _csv_text([_m_hdr] + _rows(_M1)[1:] + _rows(_M2)[1:])

_PIV = ("region,quarter,units\nNorth,Q1,120\nSouth,Q1,75\nNorth,Q2,90\nWest,Q3,310\nSouth,Q2,64\n"
        "North,Q1,15\nWest,Q1,41\nSouth,Q3,22\nNorth,Q3,8\nWest,Q3,19\n")
_pv = _rows(_PIV)[1:]
_regions = list(dict.fromkeys(r[0] for r in _pv))
_quarters = sorted({r[1] for r in _pv})
_pivot = {g: [sum(int(r[2]) for r in _pv if r[0] == g and r[1] == q) for q in _quarters] for g in _regions}


def _oracle_pivot(c: Ctx):
    a = c.answer
    errs = []
    for g, vals in _pivot.items():
        pat = re.escape(g) + r"[^\n]*?" + r"[^\d\n]+".join(rf"(?<![\d.]){v}(?![\d.])" if v else r"(?:0|-|\s)" for v in vals)
        if not re.search(pat, a, re.I):
            errs.append(f"{g}: expected {vals}")
    return "; ".join(errs) or None


_FW_LINES = ["GraceSan FranciscoUS", "Alan Bristol      UK", "Ada  New York     US"]
_fw_rows = [[l[:5].rstrip(), l[5:18].rstrip(), l[18:20].rstrip()] for l in _FW_LINES]
# Ada row: "Ada  " + "New York     " + "US"
assert _fw_rows[2] == ["Ada", "New York", "US"] and _fw_rows[0] == ["Grace", "San Francisco", "US"], _fw_rows
assert _fw_rows[1] == ["Alan", "Bristol", "UK"], _fw_rows


# ------------------------------------------------------------------ regex
_RX_TEXT = "Shipped 2024-03-09, invoiced 2023-11-30 and refunded 2025-01-02; draft 20240101 is ignored."
_RX_EXPECT = re.sub(r"(\d{4})-(\d{2})-(\d{2})", r"\3/\2/\1", _RX_TEXT)
assert _RX_EXPECT != _RX_TEXT


# ---------------------------------------------------------------- workflows (the account's saved workflow and its run)
_WF_NAME = "Coverage greeting"
_WF_VALUE = "hello-coverage-77"


def _workflow(c: Ctx):
    # Evidence is the account's stored workflow and run (GET /api/workflows...), whichever route the agent took
    # (editor clicks or the knife_workflow_* tools), not what the page or the answer says.
    data = c.page.evaluate("""async ([name]) => {
        const all = await (await fetch('/api/workflows')).json();
        const wf = (all.workflows || []).find(w => w.name === name);
        if (!wf) return { names: (all.workflows || []).map(w => w.name) };
        const runs = (await (await fetch(`/api/workflows/${wf.id}/runs`)).json()).runs || [];
        const ok = runs.find(r => r.status === 'success');
        const run = ok ? (await (await fetch(`/api/workflows/${wf.id}/runs/${ok.id}`)).json()).run : null;
        return { found: true, statuses: runs.map(r => r.status), run };
    }""", [_WF_NAME])
    if not data.get("found"):
        return f"no workflow named {_WF_NAME!r}; saved: {data.get('names')}"
    if not data.get("run"):
        return f"workflow saved but no successful run (runs: {data.get('statuses')})"
    import json as _json
    if _WF_VALUE not in _json.dumps(data["run"]):
        return f"the successful run's output does not carry {_WF_VALUE!r}"
    return matches(c.answer, re.escape(_WF_VALUE))


CASES = [
    Case("csv", "convert",
         "I have a file people.csv with this content:\n\n" + _CSV + "\nConvert it to JSON for me and show the result.",
         lambda c: first_error(has(c.haystack(), "4172", "3318", "Oslo", "Lima"))),

    Case("csv", "profile",
         "Here is a CSV export:\n\n" + _PROFILE + "\nProfile it for me: how many cells are missing in total, which column has the most missing "
         "values, and how many distinct non-empty cities are there? State the numbers in your reply.",
         _oracle_profile),

    Case("csv", "duplicates",
         "Check this CSV for repeated rows, treating upper and lower case as the same:\n\n" + _DUP +
         "\nCount the header as line 1. Tell me how many rows are repeats of an earlier row and list their line numbers.",
         lambda c: first_error(_near(c.answer, r"repeat|duplicate", len(_dup_lines)), _has_nums(c.answer, _dup_lines))),


    Case("csv", "compare",
         "Compare these two tables cell by cell, position by position, with the header row included. Table A:\n\n" + _LEFT +
         "\nTable B:\n\n" + _RIGHT + "\nA row that exists in only one table counts every one of its cells as different. "
         "How many cells differ in total, and which ones?",
         lambda c: first_error(_near(c.answer, r"differ|different|cells", _cmp_n), has(c.answer, "E5", "F6"))),

    Case("sql-lab", "format",
         "Please tidy up this SQL so each major clause starts on its own line, with keywords in UPPERCASE, and show me the formatted query:\n\n" + _SQL,
         _oracle_sql),

    Case("json", "lint",
         "Pretty-print this JSON with 4-space indentation and all object keys sorted alphabetically (do not reorder array items):\n\n" + _J_MIN,
         _oracle_lint),

    Case("json", "path",
         "In this JSON document, I need the sku of every line item in the SECOND order only (index 1, zero-based). List them:\n\n"
         + json.dumps(_ORDERS) + "\n",
         _oracle_path),


    Case("json", "diagram",
         "Outline the structure of this JSON document as a tree, then tell me: how many items are in cluster.servers, "
         "how many keys are in cluster.limits and how many items are in cluster.tags?\n\n" + json.dumps(_DIAG),
         lambda c: first_error(_near(c.answer, r"servers", _dg_servers), _near(c.answer, r"limits", _dg_limits), _near(c.answer, r"tags", _dg_tags))),

    Case("json", "schema",
         "Validate this JSON document against this JSON Schema and tell me whether it is valid. If not, which properties break which rules?\n\nSchema:\n"
         + json.dumps(_SCHEMA) + "\n\nDocument:\n" + json.dumps(_SDOC),
         _oracle_schema),


    Case("json", "yaml",
         "Convert this YAML to JSON, resolving the anchor/alias so the final JSON has no references. Show the JSON:\n\n" + _YAML,
         lambda c: _has_json(c.haystack(), _YAML_EXPECT)),


    Case("json", "xml",
         "Run an XPath over this XML to get the total price of all items whose type attribute is \"tool\", and tell me the number:\n\n" + _XML,
         lambda c: matches(c.answer, r"(?<![\d.])55[.,]05(?!\d)")),

    Case("csv", "columns",
         "From this CSV keep ONLY the customer and amount columns (drop everything else) and give me the resulting CSV:\n\n" + _COLS,
         lambda c: has(_norm(c.haystack()), _cols_expect.strip())),

    Case("csv", "merge",
         "Append the rows of the second CSV below the first (same header, keep a single header row) and give me the combined CSV, quoting fields properly:\n\nFirst:\n"
         + _M1 + "\nSecond:\n" + _M2,
         lambda c: has(_norm(c.haystack()), _merge_expect.strip())),

    Case("csv", "pivot",
         "Pivot this CSV: one row per region, one column per quarter, summing units. Show the resulting table with all totals:\n\n" + _PIV,
         _oracle_pivot),


    Case("regex", None,
         "Apply this regex replacement to the text: pattern `(\\d{4})-(\\d{2})-(\\d{2})` with the global flag, replacement `$3/$2/$1`. "
         "Show the exact resulting text.\n\nText: " + _RX_TEXT,
         lambda c: has(" ".join(c.haystack().split()), _RX_EXPECT)),
    Case("workflows", "editor",
         f"Build me a workflow named \"{_WF_NAME}\": a manual trigger followed by a Set node that sets the field greeting "
         f"to {_WF_VALUE}. Save it, run it once, and tell me what the greeting field came out as.", _workflow, timeout_ms=300_000),
]
