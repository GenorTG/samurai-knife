#!/usr/bin/env python3
"""Independent oracles for the NoSQL lab's generated code (src/lib/nosql/*).

The libraries are written in TypeScript; this suite judges their output with tools that share no code with them:

  syntax    every Python snippet -> `python3 -I -m py_compile` + ast.parse; every JS/Node/mongosh snippet ->
            `node --check`; every redis-cli line -> a Python port of Redis' own sdssplitargs tokenizer.
  semantics every snippet is then EXECUTED against recording stand-ins for pymongo/bson, the mongodb Node driver,
            mongosh globals, chromadb (Python + JS), redis-py and node-redis (tests/nosql_stubs/*); the calls it
            makes are normalised and compared with what the spec asked for, computed here independently.
  invalid   invalid specs must be rejected with an error naming the exact field path.

Usage: python3 tests/nosql_snippets_e2e.py [--store mongo|chroma|redis] [-v]
No server, no database, no network, no extra packages.
"""
import ast
import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import nosql_corpus as C  # noqa: E402

STUBS_PY = HERE / "nosql_stubs" / "py"
STUBS_JS = HERE / "nosql_stubs" / "js"
NODE = shutil.which("node") or "node"
NODE_FLAGS = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--import", str(HERE / "ts-resolve.mjs")]

failures: list[str] = []
counts: dict[str, int] = {}


def ok(kind: str) -> None:
    counts[kind] = counts.get(kind, 0) + 1


def fail(where: str, message: str) -> None:
    failures.append(f"{where}: {message}")


KEY_SENTINEL = "chroma-key-sentinel"


def run(cmd, **kw):
    env = {**os.environ, "CHROMA_API_KEY": KEY_SENTINEL}
    return subprocess.run(cmd, capture_output=True, text=True, env=env, **kw)


# ------------------------------------------------------------------ syntax oracles


def check_python_syntax(where: str, code: str, tmp: Path) -> bool:
    path = tmp / "snippet_syntax.py"
    path.write_text(code, encoding="utf8")
    proc = run([sys.executable, "-I", "-m", "py_compile", str(path)])
    if proc.returncode != 0:
        fail(where, f"py_compile failed: {proc.stderr.strip()[-300:]}\n{code}")
        return False
    try:
        ast.parse(code)
    except SyntaxError as exc:
        fail(where, f"ast.parse failed: {exc}\n{code}")
        return False
    ok("py_compile")
    return True


def check_js_syntax(where: str, code: str, tmp: Path, module: bool) -> bool:
    path = tmp / ("snippet_syntax.mjs" if module else "snippet_syntax.cjs")
    path.write_text(code, encoding="utf8")
    proc = run([NODE, "--check", str(path)])
    if proc.returncode != 0:
        fail(where, f"node --check failed: {proc.stderr.strip()[-300:]}\n{code}")
        return False
    ok("node --check")
    return True


def sdssplitargs(line: str):
    """Port of sdssplitargs() from redis/src/sds.c: how redis-cli splits an input line into byte strings (returned
    UTF-8 decoded for comparison). None = unbalanced quotes."""
    out, i, n = [], 0, len(line)
    ishex = lambda c: c in "0123456789abcdefABCDEF"  # noqa: E731
    space = " \n\r\t\v\f"
    while True:
        while i < n and line[i] in space:
            i += 1
        if i >= n:
            return out
        cur, inq, insq, done = bytearray(), False, False, False
        while not done:
            c = line[i] if i < n else ""
            if inq:
                if c == "":
                    return None
                if c == "\\" and i + 3 < n and line[i + 1] == "x" and ishex(line[i + 2]) and ishex(line[i + 3]):
                    cur.append(int(line[i + 2 : i + 4], 16))
                    i += 3
                elif c == "\\" and i + 1 < n:
                    i += 1
                    e = line[i]
                    cur += {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "a": "\a"}.get(e, e).encode()
                elif c == '"':
                    if i + 1 < n and line[i + 1] not in space:
                        return None
                    done = True
                else:
                    cur += c.encode()
            elif insq:
                if c == "":
                    return None
                if c == "\\" and i + 1 < n and line[i + 1] == "'":
                    i += 1
                    cur += b"'"
                elif c == "'":
                    if i + 1 < n and line[i + 1] not in space:
                        return None
                    done = True
                else:
                    cur += c.encode()
            else:
                if c == "" or c in space:
                    done = True
                    i -= 1
                elif c == '"':
                    inq = True
                elif c == "'":
                    insq = True
                else:
                    cur += c.encode()
            i += 1
        out.append(cur.decode("utf8"))


# ------------------------------------------------------------- execution harnesses


def parse_calls(proc, where: str):
    if proc.returncode != 0:
        fail(where, f"snippet crashed: {proc.stderr.strip()[-400:]}")
        return None
    for line in proc.stdout.split("\n"):  # not splitlines(): U+2028 inside JSON would split
        if line.startswith("@@CALLS@@"):
            return json.loads(line[len("@@CALLS@@") :])
    fail(where, f"no call record in output: {proc.stdout[-200:]}")
    return None


def exec_python(where: str, code: str, tmp: Path):
    path = tmp / "snippet_run.py"
    path.write_text(code, encoding="utf8")
    return parse_calls(run([sys.executable, "-I", str(STUBS_PY / "run.py"), str(STUBS_PY), str(path)], cwd=tmp), where)


def node_project(tmp: Path) -> Path:
    proj = tmp / "nodeproj"
    if proj.exists():
        return proj
    for name, source in (("mongodb", "mongodb.cjs"), ("chromadb", "chromadb.cjs"), ("redis", "redis.cjs"), ("__rec", "rec.cjs"), ("__types", "types.cjs"), ("@chroma-core/openai", "chroma-openai.cjs")):
        folder = proj / "node_modules" / name
        folder.mkdir(parents=True)
        shutil.copy(STUBS_JS / source, folder / "index.cjs")
        (folder / "package.json").write_text(json.dumps({"name": name, "main": "index.cjs"}))
    return proj


def exec_node(where: str, code: str, tmp: Path):
    proj = node_project(tmp)
    path = proj / "snippet.mjs"
    path.write_text(code, encoding="utf8")
    return parse_calls(run([NODE, str(path)], cwd=proj), where)


def exec_mongosh(where: str, code: str, tmp: Path):
    path = tmp / "snippet_mongosh.js"
    path.write_text(code, encoding="utf8")
    return parse_calls(run([NODE, str(STUBS_JS / "mongosh-run.cjs"), str(path)], cwd=tmp), where)


# ---------------------------------------------------------------- shared helpers


def clean(value):
    """Normalises 'not given': drops None entries and empty dicts at the top level and one level down (options,
    kwargs, client) -- never inside documents, where null is a real value that must survive."""
    if not isinstance(value, dict):
        return value
    out = {}
    for key, item in value.items():
        if item is None:
            continue
        if key in ("options", "kwargs", "client", "conn") and isinstance(item, dict):
            item = {k: v for k, v in item.items() if v is not None}
        if item == {} and key in ("options", "kwargs"):
            continue
        out[key] = item
    return out


def compare(where: str, label: str, actual, expected) -> None:
    a, e = clean(actual), clean(expected)
    if a != e:
        fail(where, f"{label} differs\n   expected: {json.dumps(e, ensure_ascii=False)[:600]}\n   actual:   {json.dumps(a, ensure_ascii=False)[:600]}")
    else:
        ok(f"semantic:{label}")


def pairs(value):
    """sort / hint / keys given as an object or as [[k, d], ...] -> [[k, d], ...]."""
    if value is None:
        return None
    if isinstance(value, dict):
        return [[k, v] for k, v in value.items()]
    return [list(p) for p in value]


def has_big_int(value) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return abs(value) > 2**53 - 1
    if isinstance(value, dict):
        return any(has_big_int(v) for v in value.values())
    if isinstance(value, list):
        return any(has_big_int(v) for v in value)
    return False


# ----------------------------------------------------------------------- MongoDB

TYPED = {"$oid", "$date", "$numberLong", "$numberInt", "$numberDouble", "$numberDecimal", "$regularExpression", "$timestamp", "$binary", "$uuid", "$minKey", "$maxKey"}
EPOCH = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)


def date_ms(value) -> int:
    if isinstance(value, dict):
        return int(value["$numberLong"])
    text = value.replace("Z", "+00:00") if value.endswith("Z") else value
    delta = datetime.datetime.fromisoformat(text) - EPOCH
    return (delta.days * 86400 + delta.seconds) * 1000 + delta.microseconds // 1000


def etag(v):
    """Extended JSON v2 value -> the tagged form the stubs produce (written from the EJSON spec table)."""
    if isinstance(v, dict):
        keys = list(v)
        if len(keys) == 1 and keys[0] in TYPED:
            k, x = keys[0], v[keys[0]]
            return {
                "$oid": lambda: {"$oid": x.lower()},
                "$date": lambda: {"$date": date_ms(x)},
                "$numberLong": lambda: {"$long": x},
                "$numberInt": lambda: int(x),
                "$numberDouble": lambda: (float(x) if x not in ("Infinity", "-Infinity", "NaN") else {"$double": x}),
                "$numberDecimal": lambda: {"$decimal": x},
                "$regularExpression": lambda: {"$regex": [x["pattern"], "".join(sorted(x.get("options", "")))]},
                "$timestamp": lambda: {"$ts": [x["t"], x["i"]]},
                "$binary": lambda: {"$bin": [x["base64"], int(x["subType"], 16)]},
                "$uuid": lambda: {"$uuid": x.lower()},
                "$minKey": lambda: {"$minKey": 1},
                "$maxKey": lambda: {"$maxKey": 1},
            }[k]()
        return {k: etag(x) for k, x in v.items()}
    if isinstance(v, list):
        return [etag(x) for x in v]
    if isinstance(v, bool) or v is None or isinstance(v, (str, float)):
        return v
    if isinstance(v, int):
        return {"$long": str(v)} if abs(v) > 2**53 - 1 else v
    raise TypeError(type(v))


def mongo_expected(spec: dict) -> dict:
    s = etag(spec)
    op = s["op"]
    out = {"method": op, "coll": s["collection"], "options": s.get("options")}
    if op in ("find", "findOne"):
        out.update(filter=s.get("filter") or {}, projection=s.get("projection"), sort=pairs(s.get("sort")), skip=s.get("skip"))
        if op == "find":
            out["limit"] = s.get("limit")
    elif op == "aggregate":
        out["pipeline"] = s["pipeline"]
    elif op == "insertOne":
        out["document"] = s["document"]
    elif op == "insertMany":
        out["documents"] = s["documents"]
    elif op in ("updateOne", "updateMany"):
        out.update(filter=s["filter"], update=s["update"])
    elif op == "replaceOne":
        out.update(filter=s["filter"], replacement=s["replacement"])
    elif op in ("deleteOne", "deleteMany"):
        out["filter"] = s["filter"]
    elif op == "countDocuments":
        out["filter"] = s.get("filter") or {}
    elif op == "distinct":
        out.update(field=s["field"], filter=s.get("filter"))
    elif op == "createIndex":
        out["keys"] = pairs(s["keys"])
    if isinstance(out.get("options"), dict) and "hint" in out["options"] and isinstance(out["options"]["hint"], dict):
        out["options"] = {**out["options"], "hint": pairs(out["options"]["hint"])}
    return out


PY_METHODS = {"find_one": "findOne", "insert_one": "insertOne", "insert_many": "insertMany", "update_one": "updateOne", "update_many": "updateMany", "replace_one": "replaceOne", "delete_one": "deleteOne", "delete_many": "deleteMany", "count_documents": "countDocuments", "create_index": "createIndex"}
PY_KW = {"max_time_ms": "maxTimeMS", "allow_disk_use": "allowDiskUse", "batch_size": "batchSize", "array_filters": "arrayFilters", "bypass_document_validation": "bypassDocumentValidation", "no_cursor_timeout": "noCursorTimeout"}


def fix_hint(options: dict) -> dict:
    if "hint" in options and isinstance(options["hint"], list):
        options = {**options, "hint": [list(p) for p in options["hint"]]}
    return options


def pymongo_normalise(calls) -> dict:
    call = next(c for c in calls if c["kind"] == "call")
    method, a, k = call["method"], call["args"], dict(call["kwargs"])
    name = PY_METHODS.get(method, method)
    out = {"method": name, "coll": call["coll"], "_db": call["db"]}
    if name in ("find", "findOne"):
        out.update(filter=a[0] if a else {}, projection=a[1] if len(a) > 1 else None, sort=pairs(k.pop("sort", None)), skip=k.pop("skip", None))
        if name == "find":
            out["limit"] = k.pop("limit", None)
    elif name == "aggregate":
        out["pipeline"] = a[0]
    elif name == "insertOne":
        out["document"] = a[0]
    elif name == "insertMany":
        out["documents"] = a[0]
    elif name in ("updateOne", "updateMany"):
        out.update(filter=a[0], update=a[1])
    elif name == "replaceOne":
        out.update(filter=a[0], replacement=a[1])
    elif name in ("deleteOne", "deleteMany"):
        out["filter"] = a[0]
    elif name == "countDocuments":
        out["filter"] = a[0] if a else {}
    elif name == "distinct":
        out.update(field=a[0], filter=a[1] if len(a) > 1 else None)
    elif name == "createIndex":
        out["keys"] = pairs(a[0])
    out["options"] = fix_hint({PY_KW.get(key, key): v for key, v in k.items()})
    return out


def node_mongo_normalise(calls) -> dict:
    call = next(c for c in calls if c["kind"] == "call")
    name, a = call["method"], call["args"]
    out = {"method": name, "coll": call["coll"], "_db": call["db"]}
    if name in ("find", "findOne"):
        opts = dict(a[1]) if len(a) > 1 else {}
        out.update(filter=a[0], projection=opts.pop("projection", None), sort=pairs(opts.pop("sort", None)), skip=opts.pop("skip", None))
        if name == "find":
            out["limit"] = opts.pop("limit", None)
        out["options"] = opts
    elif name == "aggregate":
        out.update(pipeline=a[0], options=a[1] if len(a) > 1 else {})
    elif name in ("insertOne", "insertMany"):
        out.update({"document" if name == "insertOne" else "documents": a[0], "options": a[1] if len(a) > 1 else {}})
    elif name in ("updateOne", "updateMany"):
        out.update(filter=a[0], update=a[1], options=a[2] if len(a) > 2 else {})
    elif name == "replaceOne":
        out.update(filter=a[0], replacement=a[1], options=a[2] if len(a) > 2 else {})
    elif name in ("deleteOne", "deleteMany", "countDocuments"):
        out.update(filter=a[0], options=a[1] if len(a) > 1 else {})
    elif name == "distinct":
        out.update(field=a[0], filter=a[1] if len(a) > 1 else None, options=a[2] if len(a) > 2 else {})
    elif name == "createIndex":
        out.update(keys=pairs(a[0]), options=a[1] if len(a) > 1 else {})
    out["options"] = fix_hint(out.get("options") or {})
    if isinstance(out["options"].get("hint"), dict):
        out["options"]["hint"] = pairs(out["options"]["hint"])
    return out


def mongosh_normalise(calls) -> dict:
    call = next(c for c in calls if c["kind"] == "call")
    name, a, chain = call["method"], call["args"], call.get("chain") or {}
    out = {"method": name, "coll": call["coll"], "_db": call["db"]}
    if name == "find" and chain.get("next"):
        name = out["method"] = "findOne"
        out.update(filter=a[0], projection=a[1] if len(a) > 1 else None, sort=pairs(chain.get("sort")), skip=chain.get("skip"))
        assert chain.get("limit") == 1, "findOne via cursor must limit(1)"
        out["options"] = {}
        return out
    if name in ("find", "findOne"):
        out.update(filter=a[0], projection=(a[1] or None) if len(a) > 1 else None, options=a[2] if len(a) > 2 else {})  # `{}` placeholder = no projection
        if name == "find":
            out.update(sort=pairs(chain.get("sort")), skip=chain.get("skip"), limit=chain.get("limit"))
    elif name == "aggregate":
        out.update(pipeline=a[0], options=a[1] if len(a) > 1 else {})
    elif name in ("insertOne", "insertMany"):
        out.update({"document" if name == "insertOne" else "documents": a[0], "options": a[1] if len(a) > 1 else {}})
    elif name in ("updateOne", "updateMany"):
        out.update(filter=a[0], update=a[1], options=a[2] if len(a) > 2 else {})
    elif name == "replaceOne":
        out.update(filter=a[0], replacement=a[1], options=a[2] if len(a) > 2 else {})
    elif name in ("deleteOne", "deleteMany", "countDocuments"):
        out.update(filter=a[0], options=a[1] if len(a) > 1 else {})
    elif name == "distinct":
        out.update(field=a[0], filter=a[1] if len(a) > 1 else None, options=a[2] if len(a) > 2 else {})
    elif name == "createIndex":
        out.update(keys=pairs(a[0]), options=a[1] if len(a) > 1 else {})
    out["options"] = fix_hint(out.get("options") or {})
    if isinstance(out["options"].get("hint"), dict):
        out["options"]["hint"] = pairs(out["options"]["hint"])
    return out


def compare_mongo(where: str, spec: dict, calls, normalise) -> None:
    if calls is None:
        return
    actual = normalise(calls)
    db = actual.pop("_db")
    if spec.get("database"):
        if db != spec["database"]:
            fail(where, f"database {db!r} != {spec['database']!r}")
    elif db not in ("mydb", "test"):
        fail(where, f"unexpected default database {db!r}")
    expected = mongo_expected(spec)
    # findOne with options: only the keys the spec used are compared
    compare(where, "mongo-call", actual, expected)


# ------------------------------------------------------------------------ Chroma

CHROMA_FIELDS = ["ids", "documents", "embeddings", "metadatas", "where", "where_document", "limit", "offset", "include", "query_texts", "query_embeddings", "n_results"]
JS_TO_SNAKE = {"queryTexts": "query_texts", "queryEmbeddings": "query_embeddings", "nResults": "n_results", "whereDocument": "where_document", "embeddingFunction": "embedding_function"}
JS_METHOD = {"getCollection": "get_collection", "createCollection": "create_collection", "getOrCreateCollection": "get_or_create_collection"}


def chroma_expected(spec: dict, lang: str) -> dict:
    op = spec["op"]
    client = spec.get("client") or {}
    ctype = client.get("type", "persistent")
    if lang == "js":
        cexp = {"type": "cloud", "tenant": client.get("tenant"), "database": client.get("database")} if ctype == "cloud" else {"type": "http", "host": client.get("host", "localhost") if ctype == "http" else "localhost", "port": client.get("port", 8000) if ctype == "http" else 8000, "ssl": bool(client.get("ssl")) if ctype == "http" else False}
    else:
        cexp = {"persistent": {"type": "persistent", "path": client.get("path", "./chroma")}, "http": {"type": "http", "host": client.get("host", "localhost"), "port": client.get("port", 8000), "ssl": bool(client.get("ssl"))}, "cloud": {"type": "cloud", "tenant": client.get("tenant"), "database": client.get("database")}, "ephemeral": {"type": "ephemeral"}}[ctype]
        if ctype == "http" and not client.get("ssl"):
            cexp["ssl"] = False
    kwargs = {f: spec[f] for f in CHROMA_FIELDS if f in spec}
    if op in ("create_collection", "get_or_create_collection"):
        for f in ("metadata", "configuration"):
            if f in spec:
                kwargs[f] = spec[f]
        ef = spec.get("embedding_function")
        if ef == "none":
            kwargs["embedding_function"] = None
        elif ef == "openai":
            kwargs["embedding_function"] = {"$ef": {"kind": "openai", "model": "text-embedding-3-small"}}
    return {"client": cexp, "method": op, "collection": spec["collection"], "kwargs": kwargs}


def chroma_py_normalise(calls) -> dict:
    client = next(c for c in calls if c["kind"] == "client")
    cc = next(c for c in calls if c["kind"] == "call" and c["method"] in ("get_collection", "create_collection", "get_or_create_collection"))
    kw = client["kwargs"]
    cexp = {"type": client["type"], **{k: v for k, v in kw.items() if k in ("path", "host", "port", "ssl", "tenant", "database")}}
    if cc["method"] in ("create_collection", "get_or_create_collection"):
        return {"client": cexp, "method": cc["method"], "collection": cc["collection"], "kwargs": cc["kwargs"]}
    call = next(c for c in calls if c["kind"] == "call" and c is not cc)
    return {"client": cexp, "method": call["method"], "collection": call["collection"], "kwargs": call["kwargs"]}


def chroma_js_normalise(calls) -> dict:
    client = [c for c in calls if c["kind"] == "client"][-1]
    opts = client["options"]
    if client["type"] == "CloudClient":
        cexp = {"type": "cloud", "tenant": opts.get("tenant"), "database": opts.get("database")}
        assert opts.get("apiKey") == "<from-env>", "cloud snippet must read the API key from the environment"
    else:
        cexp = {"type": "http", "host": opts.get("host"), "port": opts.get("port"), "ssl": opts.get("ssl")}
    cc = next(c for c in calls if c["kind"] == "call" and c["method"] in JS_METHOD)
    snake = lambda d: {JS_TO_SNAKE.get(k, k): v for k, v in d.items()}  # noqa: E731
    if cc["method"] in ("createCollection", "getOrCreateCollection"):
        return {"client": cexp, "method": JS_METHOD[cc["method"]], "collection": cc["collection"], "kwargs": snake(cc["options"])}
    call = next(c for c in calls if c["kind"] == "call" and c is not cc)
    return {"client": cexp, "method": call["method"], "collection": call["collection"], "kwargs": snake(call["options"])}


# ------------------------------------------------------------------------- Redis

SET_VALUE_OPTS = {"EX", "PX", "EXAT", "PXAT"}


def norm_tokens(tokens):
    t = [str(x) for x in tokens]
    head = t[0].upper()
    if head == "INCR" and len(t) == 2:
        return ["INCRBY", t[1], "1"]
    if head == "DECR" and len(t) == 2:
        return ["DECRBY", t[1], "1"]
    if head == "SET" and len(t) >= 3:
        groups, i = [], 3
        while i < len(t):
            if t[i].upper() in SET_VALUE_OPTS and i + 1 < len(t):
                groups.append([t[i].upper(), t[i + 1]])
                i += 2
            else:
                groups.append([t[i].upper()])
                i += 1
        return t[:3] + [x for g in sorted(groups) for x in g]
    return t


def redis_ops(spec):
    if isinstance(spec, list):
        return [sdssplitargs(line) for line in spec]
    out = []
    for op in spec["ops"]:
        words = op["command"].split()
        out.append([w.upper() if i == 0 else w for i, w in enumerate(words)] + [str(a) for a in op.get("args", [])])
    return out


def redis_expected(entry) -> dict:
    spec = entry["spec"]
    conn = {} if isinstance(spec, list) else spec.get("connection", {})
    mode = "sequential" if isinstance(spec, list) else spec.get("mode", "sequential")
    commands = entry.get("tokens") or redis_ops(spec)
    return {"conn": {"host": conn.get("host", "localhost"), "port": conn.get("port", 6379), "db": conn.get("db", 0), "tls": bool(conn.get("tls", False))}, "mode": mode, "commands": [norm_tokens(c) for c in commands]}


def redis_normalise(calls, lang: str) -> dict:
    client = next(c for c in calls if c["kind"] == "client")
    if lang == "py":
        conn = {"host": client["host"], "port": client["port"], "db": client["db"], "tls": bool(client["ssl"])}
    else:
        url = client["url"]
        scheme, rest = url.split("://")
        hostport, _, db = rest.partition("/")
        host, port = hostport.rsplit(":", 1)
        conn = {"host": host, "port": int(port), "db": int(db) if db else 0, "tls": scheme == "rediss"}
    batch = [c for c in calls if c["kind"] in ("tx", "pipeline")]
    if batch:
        return {"conn": conn, "mode": "transaction" if batch[0]["kind"] == "tx" else "pipeline", "commands": [norm_tokens(c) for c in batch[0]["commands"]]}
    return {"conn": conn, "mode": "sequential", "commands": [norm_tokens(c["tokens"]) for c in calls if c["kind"] == "cmd"]}


# --------------------------------------------------------------------- per entry


def label_of(snippets: dict, prefix: str):
    for label, snip in snippets.items():
        if label.startswith(prefix):
            return label, snip["code"]
    raise KeyError(prefix)


def check_mongo(entry, result, tmp: Path, variant: str) -> None:
    spec = entry["spec"] if "spec" in entry else json.loads(entry["specText"])
    snippets = result["snippets"] if variant == "wrapped" else result["compact"]
    where = f"mongo/{entry['id']}[{variant}]"
    _, shell = label_of(snippets, "mongosh")
    _, py = label_of(snippets, "PyMongo")
    _, node = label_of(snippets, "Node.js")
    _, ejson = label_of(snippets, "Extended JSON")
    if check_js_syntax(where + "/mongosh", shell, tmp, module=False):
        compare_mongo(where + "/mongosh", spec, exec_mongosh(where + "/mongosh", shell, tmp), mongosh_normalise)
    if check_python_syntax(where + "/pymongo", py, tmp):
        compare_mongo(where + "/pymongo", spec, exec_python(where + "/pymongo", py, tmp), pymongo_normalise)
    if check_js_syntax(where + "/node", node, tmp, module=True):
        compare_mongo(where + "/node", spec, exec_node(where + "/node", node, tmp), node_mongo_normalise)
    try:
        json.loads(ejson)
        ok("json.loads")
    except ValueError as exc:
        fail(where + "/extended-json", f"not valid JSON: {exc}")


def check_chroma(entry, result, tmp: Path, variant: str) -> None:
    spec = entry["spec"] if "spec" in entry else json.loads(entry["specText"])
    snippets = result["snippets"] if variant == "wrapped" else result["compact"]
    where = f"chroma/{entry['id']}[{variant}]"
    _, py = label_of(snippets, "Python")
    _, js = label_of(snippets, "JavaScript")
    if check_python_syntax(where + "/python", py, tmp):
        calls = exec_python(where + "/python", py, tmp)
        if calls is not None:
            compare(where + "/python", "chroma-call", chroma_py_normalise(calls), chroma_expected(spec, "py"))
    if check_js_syntax(where + "/js", js, tmp, module=True):
        calls = exec_node(where + "/js", js, tmp)
        if calls is not None and not has_big_int(spec):  # JS numbers cannot hold >2^53: the library warns instead
            compare(where + "/js", "chroma-call", chroma_js_normalise(calls), chroma_expected(spec, "js"))


def check_redis(entry, result, tmp: Path, variant: str) -> None:
    snippets = result["snippets"] if variant == "wrapped" else result["compact"]
    where = f"redis/{entry['id']}[{variant}]"
    spec = entry["spec"]
    _, cli = label_of(snippets, "redis-cli")
    _, py = label_of(snippets, "redis-py")
    _, js = label_of(snippets, "node-redis")
    expected = redis_expected(entry)
    mode = expected["mode"]
    # redis-cli: tokenise each line exactly as redis-cli does, compare with the spec's commands
    lines = [ln for ln in cli.split("\n") if ln]
    tokens = []
    for ln in lines:
        parts = sdssplitargs(ln)
        if parts is None:
            fail(where + "/cli", f"unbalanced quotes in line: {ln!r}")
            return
        tokens.append(parts)
    want = [t if not t else [t[0].upper(), *t[1:]] for t in (entry.get("tokens") or redis_ops(spec))]
    if mode == "transaction":
        want = [["MULTI"], *want, ["EXEC"]]
    if expected["conn"]["db"]:
        want = [["SELECT", str(expected["conn"]["db"])], *want]
    if tokens != want:
        fail(where + "/cli", f"tokens differ\n   expected: {want}\n   actual:   {tokens}")
    else:
        ok("redis-cli tokens")
    if check_python_syntax(where + "/redis-py", py, tmp):
        calls = exec_python(where + "/redis-py", py, tmp)
        if calls is not None:
            compare(where + "/redis-py", "redis-call", redis_normalise(calls, "py"), expected)
    if check_js_syntax(where + "/node-redis", js, tmp, module=True):
        calls = exec_node(where + "/node-redis", js, tmp)
        if calls is not None:
            compare(where + "/node-redis", "redis-call", redis_normalise(calls, "js"), expected)


CHECKERS = {"mongo": check_mongo, "chroma": check_chroma, "redis": check_redis}


def check_invalid(entry, result) -> None:
    where = f"{entry['store']}/invalid/{entry['id']}"
    if result["ok"]:
        fail(where, "invalid spec was accepted")
        return
    errs = [i for i in result["issues"] if i["severity"] == "error"]
    named = [i for i in errs if i["path"] == entry["path"]]
    if not named:
        fail(where, f"no error names the field {entry['path']!r}; got {[(i['path'], i['message']) for i in errs]}")
        return
    if not any(entry["contains"].lower() in (i["message"] + " " + (i.get("fix") or "")).lower() for i in named):
        fail(where, f"error at {entry['path']!r} does not mention {entry['contains']!r}: {[i['message'] for i in named]}")
        return
    ok("invalid-rejected")


def main() -> int:
    only = None
    verbose = "-v" in sys.argv
    if "--store" in sys.argv:
        only = sys.argv[sys.argv.index("--store") + 1]
    tmp = Path(tempfile.mkdtemp(prefix="nosql-oracle-"))
    try:
        entries = []
        for store, valid, invalid in (("mongo", C.MONGO, C.MONGO_INVALID), ("chroma", C.CHROMA, C.CHROMA_INVALID), ("redis", C.REDIS, C.REDIS_INVALID)):
            if only and only != store:
                continue
            entries += [{**e, "store": store, "kind": "valid"} for e in valid]
            entries += [{**e, "store": store, "kind": "invalid"} for e in invalid]
        (tmp / "in.json").write_text(json.dumps(entries))
        proc = run([NODE, *NODE_FLAGS, str(HERE / "nosql_dump.mjs"), str(tmp / "in.json"), str(tmp / "out.json")], cwd=ROOT)
        if proc.returncode != 0:
            print("dump failed:", proc.stderr[-1500:])
            return 2
        results = json.loads((tmp / "out.json").read_text())
        for entry, result in zip(entries, results):
            if entry["kind"] == "invalid":
                check_invalid(entry, result)
                continue
            where = f"{entry['store']}/{entry['id']}"
            errs = [i for i in result["issues"] if i["severity"] == "error"]
            if not result["ok"]:
                fail(where, f"valid spec rejected: {[(i['path'], i['message']) for i in errs]}")
                continue
            if "spec" not in entry and "specText" in entry:
                entry = {**entry, "spec": json.loads(entry["specText"])}
            for variant in ("wrapped", "compact"):
                CHECKERS[entry["store"]](entry, result, tmp, variant)
            if verbose:
                print("checked", where)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    per_store = {s: sum(1 for e in C.__dict__[s.upper()]) for s in ("mongo", "chroma", "redis")}
    print(f"specs: valid {per_store}, invalid mongo={len(C.MONGO_INVALID)} chroma={len(C.CHROMA_INVALID)} redis={len(C.REDIS_INVALID)}")
    print("checks passed:", ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    if failures:
        print(f"\n{len(failures)} FAILURES")
        for line in failures[:40]:
            print(" -", line)
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
