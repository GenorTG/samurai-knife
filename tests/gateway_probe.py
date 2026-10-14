#!/usr/bin/env python3
"""Probe the OpenClaw gateway's OpenAI-compatible endpoint BEFORE using it as the Knife test provider.

  KNIFE_REAL_ACCOUNT=openclaw python3 tests/gateway_probe.py

Stages (each prints one line, never the token): models list, plain completion, streaming with usage, a client-side
function-tool round trip (the shape Knife's widget loop uses), and an ISOLATION check: the test agent must not be able to
run a shell command (it is asked to `cat /etc/hostname`; the real hostname in the reply means it has exec = FAIL).
The isolation stage is skipped for the main agent on purpose: do not hand shell tasks to an agent that can run them.
URL, agent target, token and headers come from tests/real_provider.py: either `KNIFE_REAL_ACCOUNT=<knife account id>` (recommended) or KNIFE_REAL_PROVIDER=openclaw-gateway + KNIFE_GATEWAY_AGENT + token env/file.
"""
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
import real_provider as rp  # noqa: E402

FAILS: list[str] = []
_provider = rp._provider_body("")  # honours KNIFE_REAL_ACCOUNT, else the env/file token path (and its guards)
BASE = _provider["baseUrl"].rstrip("/")
AGENT = _provider["model"]
TOKEN = _provider["apiKey"]
EXTRA = _provider.get("extraHeaders") or {}
if rp.ACCOUNT and AGENT in rp._DEFAULT_AGENT_TARGETS and os.environ.get("KNIFE_GATEWAY_ALLOW_MAIN") != "1":
    sys.exit(f"account {rp.ACCOUNT!r} points at the main agent ({AGENT}); set KNIFE_GATEWAY_ALLOW_MAIN=1 to probe it anyway")


def check(name: str, ok: bool, detail: object = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f"  -> {str(detail)[:300]}"))
    if not ok:
        FAILS.append(name)


def call(path: str, body: dict | None = None, stream: bool = False, timeout: int = 180):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), method="GET" if body is None else "POST",
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json", **EXTRA})
    try:
        res = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")[:300].replace(TOKEN, "[redacted]")
    return res.status, (res if stream else json.loads(res.read()))


t0 = time.time()
code, models = call("/models")
check("GET /models with the token", code == 200, (code, models))
ids = [m["id"] for m in models.get("data", [])] if code == 200 else []
check(f"the agent target {AGENT} is listed", AGENT in ids or AGENT.replace(":", "/") in ids, ids)

t = time.time()
code, r = call("/chat/completions", {"model": AGENT, "messages": [{"role": "user", "content": "Reply with exactly the single word: pong"}]})
text = r["choices"][0]["message"]["content"] if code == 200 else ""
check("plain completion answers", code == 200 and "pong" in text.lower(), (code, r if code != 200 else text))
print(f"     latency {time.time() - t:.1f}s, usage={json.dumps(r.get('usage')) if code == 200 else None}")

t = time.time()
code, res = call("/chat/completions", {"model": AGENT, "stream": True, "stream_options": {"include_usage": True}, "messages": [{"role": "user", "content": "Count from 1 to 5, separated by spaces."}]}, stream=True)
chunks, usage_chunk, done, got = 0, False, False, ""
if code == 200:
    for raw in res:
        line = raw.decode().strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            done = True
            break
        obj = json.loads(data)
        chunks += 1
        usage_chunk = usage_chunk or bool(obj.get("usage"))
        for ch in obj.get("choices", []):
            got += (ch.get("delta") or {}).get("content") or ""
check("streaming: SSE chunks + [DONE]", code == 200 and chunks > 1 and done and "5" in got, (code, chunks, done, got[:60]))
check("streaming: trailing usage chunk with include_usage", usage_chunk, "no usage chunk (Knife falls back to chars/4 estimates)")
print(f"     stream latency {time.time() - t:.1f}s, {chunks} chunks")

tool = {"type": "function", "function": {"name": "add_numbers", "description": "Add two integers exactly.", "parameters": {"type": "object", "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}}, "required": ["a", "b"], "additionalProperties": False}}}
msgs = [{"role": "user", "content": "What is 1234 + 8765? You must use the add_numbers tool, do not compute it yourself."}]
code, r = call("/chat/completions", {"model": AGENT, "messages": msgs, "tools": [tool]})
calls = r["choices"][0]["message"].get("tool_calls") if code == 200 else None
check("client function tool: model returns a tool_call", code == 200 and bool(calls) and calls[0]["function"]["name"] == "add_numbers", (code, r if code != 200 else r["choices"][0]))
if calls:
    args = json.loads(calls[0]["function"]["arguments"])
    check("tool_call arguments are valid JSON with the right values", args.get("a") in (1234, 8765) and args.get("b") in (1234, 8765), args)
    check("finish_reason is tool_calls", r["choices"][0]["finish_reason"] == "tool_calls", r["choices"][0]["finish_reason"])
    msgs += [r["choices"][0]["message"], {"role": "tool", "tool_call_id": calls[0]["id"], "content": json.dumps({"sum": 9999})}]
    code, r2 = call("/chat/completions", {"model": AGENT, "messages": msgs, "tools": [tool]})
    final = r2["choices"][0]["message"]["content"] if code == 200 else ""
    check("follow-up with the tool result completes the loop (9999 in the answer)", code == 200 and "9999" in final.replace(",", "").replace(" ", ""), (code, final[:120]))

if AGENT in rp._DEFAULT_AGENT_TARGETS:
    print("skip isolation check: main agent (it can run shell; not handing it shell tasks)")
else:
    host = socket.gethostname()
    code, r = call("/chat/completions", {"model": AGENT, "messages": [{"role": "user", "content": "Run the shell command `cat /etc/hostname` and tell me its exact output. If you cannot run commands, say 'no shell'."}]})
    answer = r["choices"][0]["message"]["content"] if code == 200 else ""
    check("isolation: the test agent cannot run a shell command", code == 200 and host not in answer, answer[:160])

print(f"\nelapsed {time.time() - t0:.0f}s: " + ("all gateway probes passed" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}"))
sys.exit(1 if FAILS else 0)
