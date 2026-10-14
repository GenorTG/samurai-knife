#!/usr/bin/env python3
"""knife_mongo_* / knife_chroma_* / knife_redis_* through the real HTTP surfaces.

Checks: every tool definition from GET /api/agent/tools is a valid draft-07 JSON Schema (validated with ajv from the
repo's node_modules) and OpenAI-function shaped; POST /api/agent/tool and POST /api/mcp (tools/list + tools/call, JSON-RPC
over SSE) list and run the six NoSQL tools; compiled Python is re-checked with py_compile and JS with node --check.

Usage: python3 tests/nosql_tools_e2e.py [base_url]    (default http://127.0.0.1:3273; any scratch server, no provider needed)
"""
import json
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3273").rstrip("/")
ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node") or "node"
TOOLS = ["knife_mongo_compile", "knife_mongo_validate", "knife_chroma_compile", "knife_chroma_validate", "knife_redis_compile", "knife_redis_explain"]
FAILS: list[str] = []
PASSED = 0


def check(cond, message):
    global PASSED
    if cond:
        PASSED += 1
    else:
        FAILS.append(message)
        print("FAIL", message)


def http(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"Content-Type": "application/json", "Origin": BASE, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode()


def agent_tool(name, args):
    status, text = http("POST", "/api/agent/tool", {"name": name, "args": args})
    payload = json.loads(text)
    return status, payload


def result_of(name, args):
    status, payload = agent_tool(name, args)
    check(status == 200 and payload.get("ok") is True, f"{name} {json.dumps(args)[:80]}: HTTP {status} {str(payload)[:200]}")
    return json.loads(payload["content"]) if payload.get("ok") else {}


def mcp(method, params, rpc_id=1):
    status, text = http("POST", "/api/mcp", {"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params}, {"Accept": "application/json, text/event-stream"})
    check(status == 200, f"mcp {method}: HTTP {status}")
    data = [line[6:] for line in text.split("\n") if line.startswith("data: ")]
    return json.loads(data[0]) if data else {}


def py_ok(code):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "s.py"
        path.write_text(code)
        return subprocess.run([sys.executable, "-I", "-m", "py_compile", str(path)], capture_output=True).returncode == 0


def js_ok(code, module=True):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / ("s.mjs" if module else "s.cjs")
        path.write_text(code)
        return subprocess.run([NODE, "--check", str(path)], capture_output=True).returncode == 0


def snippet(result, prefix):
    return next((s["code"] for s in result.get("snippets", []) if s["label"].startswith(prefix)), "")


def main():
    # ---------------------------------------------------------------- definitions
    status, text = http("GET", "/api/agent/tools")
    check(status == 200, f"GET /api/agent/tools -> {status}")
    defs = json.loads(text)["tools"]
    names = [d["function"]["name"] for d in defs]
    check(len(names) == len(set(names)), "tool names are unique")
    for name in TOOLS:
        check(name in names, f"{name} is listed by /api/agent/tools")
    mine = [d for d in defs if d["function"]["name"] in TOOLS]
    for d in defs:
        fn = d["function"]
        check(d["type"] == "function" and 0 < len(fn["name"]) <= 64 and fn["description"] and fn["parameters"].get("type") == "object", f"{fn['name']}: function-calling shape")
    for d in mine:
        check(len(d["function"]["description"]) < 2600, f"{d['function']['name']}: description stays compact ({len(d['function']['description'])} chars)")
        check(len(json.dumps(d["function"]["parameters"])) < 1200, f"{d['function']['name']}: parameter schema stays small")
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "defs.json").write_text(json.dumps([d["function"]["parameters"] for d in defs]))
        script = (
            "const Ajv=require('ajv');const ajv=new Ajv({strict:false,validateSchema:true});"
            "const defs=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));"
            "let bad=0;defs.forEach((s,i)=>{try{ajv.compile(s)}catch(e){bad++;console.log('schema '+i+': '+e.message)}});"
            "process.exit(bad?1:0)"
        )
        proc = subprocess.run([NODE, "-e", script, str(Path(tmp) / "defs.json")], cwd=ROOT, capture_output=True, text=True)
        check(proc.returncode == 0, f"every tool schema is valid draft-07 (ajv): {proc.stdout[-300:]}{proc.stderr[-300:]}")
        schema_draft = [d["function"]["parameters"].get("$schema", "") for d in defs]
        check(all("draft-07" in s for s in schema_draft), f"all schemas declare draft-07: {set(schema_draft)}")

    # ------------------------------------------------------------ /api/agent/tool
    r = result_of("knife_mongo_compile", {"spec": {"op": "find", "collection": "users", "filter": {"age": {"$gte": 18}}, "sort": {"name": 1}, "limit": 10}})
    check(r.get("ok") is True and not r["errors"], "mongo compile ok")
    check('db.users.find({ age: { $gte: 18 } }).sort({ name: 1 }).limit(10);' in snippet(r, "mongosh"), "mongo compile: mongosh code")
    check('sort=[("name", 1)]' in snippet(r, "PyMongo") and 'limit=10' in snippet(r, "PyMongo"), "mongo compile: PyMongo code")
    check(py_ok(snippet(r, "PyMongo")) and js_ok(snippet(r, "Node.js")) and js_ok(snippet(r, "mongosh"), module=False), "mongo compile: snippets pass py_compile / node --check")
    check(isinstance(r.get("explain"), list) and any("age is greater than or equal to 18" in line for line in r["explain"]), "mongo compile: explain")

    r = result_of("knife_mongo_compile", {"specText": '{op: "findOne", collection: "orders", filter: {_id: ObjectId("507f1f77bcf86cd799439011")}}', "compact": True})
    check(r.get("ok") is True and 'db.orders.findOne({ _id: ObjectId("507f1f77bcf86cd799439011") });' in snippet(r, "mongosh"), "mongo compile: mongosh syntax input")

    r = result_of("knife_mongo_compile", {"specText": '{"op":"insertOne","collection":"c","document":{"big":9007199254740993}}', "compact": True})
    check('NumberLong("9007199254740993")' in snippet(r, "mongosh"), "mongo compile: 64-bit integers stay exact through specText")

    r = result_of("knife_mongo_compile", {"spec": {"op": "find", "collection": "c", "filter": {"age": {"$gtt": 5}}}})
    check(r.get("ok") is False and r["snippets"] == [] and any(e["path"] == "filter.age.$gtt" and "$gt" in e["message"] for e in r["errors"]), "mongo compile: invalid spec names the field")

    r = result_of("knife_mongo_validate", {"spec": {"op": "aggregate", "collection": "c", "pipeline": [{"$group": {"n": {"$sum": 1}}}]}})
    check(r.get("ok") is False and any(e["path"] == "pipeline[0].$group" for e in r["errors"]), "mongo validate: $group without _id")
    r = result_of("knife_mongo_validate", {"spec": {"op": "aggregate", "collection": "c", "pipeline": [{"$limit": 3}, {"$sort": {"a": 1}}]}})
    check(r.get("ok") is True and any(w["path"] == "pipeline[0]" for w in r["warnings"]), "mongo validate: order warning")

    r = result_of("knife_chroma_compile", {"spec": {"op": "query", "collection": "docs", "query_texts": ["pets"], "n_results": 3, "where": {"$and": [{"year": {"$gte": 2023}}, {"topic": "dogs"}]}}})
    check(r.get("ok") is True, "chroma compile ok")
    check('where={"$and": [{"year": {"$gte": 2023}}, {"topic": "dogs"}]}' in snippet(r, "Python"), "chroma compile: python where")
    check("whereDocument" not in snippet(r, "JavaScript") and "nResults: 3" in snippet(r, "JavaScript"), "chroma compile: JS names")
    check(py_ok(snippet(r, "Python")) and js_ok(snippet(r, "JavaScript")), "chroma compile: snippets pass syntax oracles")
    r = result_of("knife_chroma_compile", {"spec": {"op": "get", "collection": "docs", "where": {"a": 1, "b": 2}}})
    check(r.get("ok") is False and any(e["path"] == "where" and "exactly one" in e["message"] for e in r["errors"]), "chroma compile: multi-key where rejected")
    r = result_of("knife_chroma_validate", {"spec": {"op": "add", "collection": "docs", "ids": ["a", "a"], "documents": ["x", "y"]}})
    check(r.get("ok") is False and any(e["path"] == "ids[1]" for e in r["errors"]), "chroma validate: duplicate ids")
    r = result_of("knife_chroma_validate", {"specText": '{"op":"count","collection":"docs"}'})
    check(r.get("ok") is True, "chroma validate: specText")

    r = result_of("knife_redis_compile", {"spec": {"ops": [{"command": "SET", "args": ["k", "v w", "EX", 60]}, {"command": "GET", "args": ["k"]}]}})
    check(r.get("ok") is True and snippet(r, "redis-cli") == 'SET k "v w" EX 60\nGET k\n', "redis compile: redis-cli lines")
    check('r.set("k", "v w", ex=60)' in snippet(r, "redis-py") and 'client.set("k", "v w", { EX: 60 })' in snippet(r, "node-redis"), "redis compile: py + node")
    check(py_ok(snippet(r, "redis-py")) and js_ok(snippet(r, "node-redis")), "redis compile: snippets pass syntax oracles")
    r = result_of("knife_redis_compile", {"specText": "SET a 1\nKEYS *"})
    check(r.get("ok") is True and any("KEYS" in w["message"] for w in r["warnings"]), "redis compile: redis-cli lines input + KEYS warning")
    r = result_of("knife_redis_compile", {"spec": {"ops": [{"command": "SET", "args": ["k", "v", "EXX", 5]}]}})
    check(r.get("ok") is False and any(e["path"] == "ops[0].args[2]" for e in r["errors"]), "redis compile: bad option")
    r = result_of("knife_redis_explain", {"spec": {"ops": [{"command": "KEYS", "args": ["user:*"]}]}})
    check(any("Complexity: O(N)" in s for s in r.get("steps", [])) and r["warnings"], "redis explain: complexity + warning")

    # tool errors are reported, never crash
    status, payload = agent_tool("knife_mongo_compile", {})
    check(status == 200 and payload.get("ok") is False and "spec" in payload.get("error", ""), f"empty args -> readable error: {payload}")
    status, payload = agent_tool("knife_mongo_compile", {"spec": {}, "bogus": 1})
    check(payload.get("ok") is False, "unknown argument rejected")
    status, payload = agent_tool("knife_mongo_compile", {"specText": "{op: find"})
    check(status == 200 and payload.get("ok") is True and json.loads(payload["content"])["ok"] is False, "unparseable specText -> ok:false report")

    # ---------------------------------------------------------------------- MCP
    listed = mcp("tools/list", {})
    mcp_names = [t["name"] for t in listed["result"]["tools"]]
    for name in TOOLS:
        check(name in mcp_names, f"{name} is listed by /api/mcp")
    for t in listed["result"]["tools"]:
        if t["name"] in TOOLS:
            check(t["inputSchema"].get("type") == "object" and t["description"], f"{t['name']}: mcp inputSchema + description")
    called = mcp("tools/call", {"name": "knife_mongo_compile", "arguments": {"spec": {"op": "countDocuments", "collection": "users", "filter": {"status": "active"}}, "compact": True}}, 2)
    body = json.loads(called["result"]["content"][0]["text"])
    check(called["result"].get("isError") in (None, False) and body["ok"] and 'db.users.countDocuments({ status: "active" });' in snippet(body, "mongosh"), "mcp tools/call mongo compile")
    called = mcp("tools/call", {"name": "knife_redis_explain", "arguments": {"specText": "FLUSHALL"}}, 3)
    body = json.loads(called["result"]["content"][0]["text"])
    check(any("EVERY database" in w["message"] for w in body["warnings"]), "mcp tools/call redis explain warning")
    called = mcp("tools/call", {"name": "knife_chroma_validate", "arguments": {"spec": {"op": "get", "collection": "abc", "where_document": {"$eq": "x"}}}}, 4)
    body = json.loads(called["result"]["content"][0]["text"])
    check(body["ok"] is False and any(e["path"] == "where_document.$eq" for e in body["errors"]), "mcp tools/call chroma validate")
    called = mcp("tools/call", {"name": "knife_mongo_compile", "arguments": {}}, 5)
    check(called["result"].get("isError") is True, "mcp tools/call with bad args -> isError")

    print(f"{PASSED} checks passed, {len(FAILS)} failed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
