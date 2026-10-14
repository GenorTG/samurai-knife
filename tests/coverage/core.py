"""Coverage harness core: case format, registry derivation, driving the real widget UI.

A case file under tests/coverage/cases/<group>.py defines
    GROUP = "docs"
    CASES = [Case(...), ...]
    SKIPS = {("slug", "tab-or-None"): "why the AI cannot drive it"}
The prompt must be plain natural language: never mention slugs, tab ids or control ids.
The oracle checks the REAL page/answer against a value computed independently in Python.
"""
from __future__ import annotations

import importlib
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parents[2]
REGISTRY = ROOT / "src/lib/registry.ts"
GROUPS = ("docs", "media", "data", "css_time", "web", "db", "cv")
TURN_TIMEOUT_MS = 240_000


def parse_registry() -> tuple[list[str], dict[str, list[str]]]:
    """(all listed slugs, suite slug -> tab ids) from src/lib/registry.ts."""
    listed: list[str] = []
    suites: dict[str, list[str]] = {}
    current = ""
    for line in REGISTRY.read_text().split("export const SLUG_ALIASES")[0].splitlines():
        m = re.match(r'^    slug:\s*"([^"]+)"', line)
        if m:
            current = m.group(1)
            listed.append(current)
            continue
        t = re.match(r'^\s+\{ id: "([^"]+)", label:', line)
        if t and current:
            suites.setdefault(current, []).append(t.group(1))
    return listed, suites


def all_targets() -> list[tuple[str, str | None]]:
    listed, suites = parse_registry()
    out: list[tuple[str, str | None]] = []
    for slug in listed:
        if slug in suites:
            out += [(slug, tab) for tab in suites[slug]]
        else:
            out.append((slug, None))
    return out


class Ctx:
    """What an oracle sees after the agent finished: the live page, the answer and the transcript."""

    def __init__(self, page, messages: list[dict]):
        self.page = page
        self.messages = messages
        last = next((m for m in reversed(messages) if m["role"] == "assistant" and not m.get("tool_calls")), None)
        self.answer: str = (last or {}).get("content") or ""

    def page_text(self) -> str:
        return self.page.evaluate("(document.querySelector('main') || document.body).innerText")

    def values(self) -> list[str]:
        """Values of every input/textarea/select on the page (outputs are often readonly fields)."""
        return self.page.evaluate(
            "Array.from(document.querySelectorAll('main input, main textarea, main select')).map(e => e.value).filter(Boolean)"
        )

    def haystack(self) -> str:
        """Everything observable: page text, field values and the agent's final answer."""
        return "\n".join([self.page_text(), *self.values(), self.answer])

    def page_only(self) -> str:
        return "\n".join([self.page_text(), *self.values()])

    def url(self) -> str:
        return self.page.url


@dataclass
class Case:
    slug: str
    tab: str | None
    prompt: str
    oracle: Callable[[Ctx], str | None]  # None = pass, else failure reason
    note: str = ""
    # Max wall time for this case in ms (default TURN_TIMEOUT_MS).
    timeout_ms: int = TURN_TIMEOUT_MS
    # If True the oracle only checks the final answer text, not the page (output-only math, etc.).
    answer_only: bool = False

    @property
    def key(self) -> str:
        return f"{self.slug}:{self.tab}" if self.tab else self.slug


def has(hay: str, *needles: str, ci: bool = False) -> str | None:
    """Oracle helper: pass when every needle is present; else name the missing ones."""
    h = hay.lower() if ci else hay
    missing = [n for n in needles if (n.lower() if ci else n) not in h]
    return None if not missing else f"missing in output: {missing[:3]}"


def load_group(group: str):
    return importlib.import_module(f"tests.coverage.cases.{group}")


def load_cases(groups: tuple[str, ...] = GROUPS) -> tuple[list[Case], dict[tuple[str, str | None], str]]:
    cases: list[Case] = []
    skips: dict[tuple[str, str | None], str] = {}
    for g in groups:
        try:
            mod = load_group(g)
        except ModuleNotFoundError as exc:
            if exc.name and exc.name.endswith(f"cases.{g}"):
                continue
            raise
        for c in mod.CASES:
            c.group = g  # type: ignore[attr-defined]
            cases.append(c)
        skips.update(getattr(mod, "SKIPS", {}))
    return cases, skips


def group_of(case: Case) -> str:
    return getattr(case, "group", "?")



# ------------------------------------------------------------------ runner

def _storage_key(page) -> str:
    return page.evaluate("fetch('/api/account').then(r => r.json()).then(a => `sk.agent.chat.v1.${a.id}:${encodeURIComponent(a.provider?.baseUrl ?? '')}:${encodeURIComponent(a.provider?.model ?? '')}`)")


def _stored(page, key: str) -> list[dict]:
    return json.loads(page.evaluate("k => localStorage.getItem(k) || '[]'", key))


def _clip(text: str, n: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[:n] + "…"


def run_case(browser, base: str, case: Case) -> dict:
    """Drive the real widget with the case prompt from the home page; return one result record."""
    rec: dict = {"key": case.key, "group": group_of(case), "pass": False, "reason": "", "rounds": 0,
                 "tool_calls": 0, "calls": [], "first_wrong_step": None, "wall_s": 0.0, "answer": "", "console_errors": []}
    t0 = time.time()
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    page.on("console", lambda m: rec["console_errors"].append(_clip(m.text, 160)) if m.type == "error" else None)
    try:
        page.goto(base + "/", wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_selector("button[aria-label='Open assistant']", timeout=60_000)
        key = _storage_key(page)
        page.locator("button[aria-label='Open assistant']").click()
        composer = page.locator("textarea[aria-label='Message the assistant']")
        composer.wait_for(timeout=30_000)
        composer.fill(case.prompt)
        composer.press("Enter")
        try:
            page.wait_for_function(
                """k => { const m = JSON.parse(localStorage.getItem(k) || '[]');
                   if (!m.some(x => x.role === 'user')) return false;
                   const l = m[m.length - 1];
                   return (l.role === 'assistant' && !l.tool_calls) || l.role === 'notice'; }""",
                arg=key, timeout=case.timeout_ms)
        except Exception:
            rec["reason"] = f"timeout after {case.timeout_ms // 1000}s without a final answer"
        msgs = _stored(page, key)
        names = {c["id"]: c["function"]["name"] for m in msgs if m["role"] == "assistant" for c in m.get("tool_calls", [])}
        rec["rounds"] = sum(1 for m in msgs if m["role"] == "assistant")
        rec["calls"] = [n for m in msgs if m["role"] == "assistant" for n in (c["function"]["name"] for c in m.get("tool_calls", []))]
        rec["tool_calls"] = len(rec["calls"])
        for m in msgs:
            if m["role"] != "tool":
                continue
            try:
                body = json.loads(m["content"])
            except ValueError:
                continue
            if isinstance(body, dict) and (body.get("ok") is False or body.get("error")):
                rec["first_wrong_step"] = {"tool": names.get(m["tool_call_id"], "?"), "error": _clip(body.get("error", "failed"), 200)}
                break
        notices = [m["content"] for m in msgs if m["role"] == "notice" and m.get("level") == "error"]
        if notices:
            rec["reason"] = rec["reason"] or _clip(notices[-1], 200)
        c = Ctx(page, msgs)
        rec["trace"] = [
            {"role": m["role"], "text": _clip(m.get("content") or json.dumps([(x["function"]["name"], x["function"]["arguments"]) for x in m.get("tool_calls", [])]), 500)}
            for m in msgs
        ]
        rec["answer"] = _clip(c.answer, 300)
        if not rec["reason"]:
            try:
                verdict = case.oracle(c)
            except Exception as exc:  # oracle bugs must not look like app bugs
                verdict = f"oracle error: {type(exc).__name__}: {_clip(str(exc), 120)}"
            rec["pass"] = verdict is None
            rec["reason"] = verdict or ""
    except Exception as exc:
        rec["reason"] = f"harness error: {type(exc).__name__}: {_clip(str(exc), 160)}"
    finally:
        rec["wall_s"] = round(time.time() - t0, 1)
        ctx.close()
    return rec


def used(ctx: Ctx, tool: str) -> bool:
    return any(c["function"]["name"] == tool for m in ctx.messages if m["role"] == "assistant" for c in m.get("tool_calls", []))


def matches(hay: str, pattern: str) -> str | None:
    return None if re.search(pattern, hay, re.I | re.S) else f"no match for /{pattern}/"


def first_error(*checks: str | None) -> str | None:
    return next((c for c in checks if c), None)
