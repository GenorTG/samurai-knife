"""Shared helpers for the durable-conversation suites (agent_responses_e2e.py scripted fixture, agent_responses_real_e2e.py gateway)."""
from playwright.sync_api import Page


def conversation(page: Page) -> dict:
    """The server-side durable conversation of the signed-in account for its current provider."""
    return page.evaluate("fetch('/api/agent/conversation').then(r => r.json())")


def open_widget(page: Page) -> None:
    page.keyboard.press("Control+j")
    page.wait_for_selector("[role=dialog][aria-label='Toolbox assistant']")
    page.locator("textarea[aria-label='Message the assistant']").wait_for()


def send(page: Page, text: str, timeout_s: int = 30) -> dict:
    """Send a prompt and wait until the SERVER-side conversation ends with this prompt's final reply. Returns that conversation."""
    box = page.locator("textarea[aria-label='Message the assistant']")
    box.fill(text)
    box.press("Enter")
    for _ in range(timeout_s * 10):
        conv = conversation(page)
        talk = [m for m in conv["messages"] if m["role"] != "notice"]  # the per-turn usage footer is a notice
        users = [m for m in talk if m["role"] == "user"]
        last = talk[-1] if talk else None
        if users and users[-1]["content"] == text and last and last["role"] == "assistant" and not last.get("tool_calls") \
                and not page.evaluate("document.documentElement.hasAttribute('data-agent-active')"):
            return conv
        page.wait_for_timeout(100)
    raise RuntimeError(f"no final reply for {text!r}")
