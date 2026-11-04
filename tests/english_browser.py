"""Polish-first (docs/I18N.md) for the Playwright suites: headless Chromium sends NO Accept-Language unless a locale is
set, and a visitor without a language choice gets Polish, so a suite that reads English labels would see Polish pages.
Importing this module gives every new context (and `browser.new_page()`) `locale="en-US"` when the suite set neither a
locale nor its own Accept-Language header, which is what Firefox already sends. A suite that wants another language
passes `locale=` (or `extra_http_headers={"Accept-Language": ...}`, or the `knife_lang` cookie) as before.

Imported by tests/scratch_server.py, so every suite that starts a scratch server gets it; suites that take a URL import
it themselves.
"""
from __future__ import annotations

from typing import Any

from playwright.sync_api import Browser

_PATCHED = "_knife_english_default"


def _with_english(kwargs: dict[str, Any]) -> dict[str, Any]:
    headers = {k.lower() for k in (kwargs.get("extra_http_headers") or {})}
    if kwargs.get("locale") is None and "accept-language" not in headers:
        kwargs["locale"] = "en-US"
    return kwargs


if not getattr(Browser, _PATCHED, False):
    _new_context = Browser.new_context
    _new_page = Browser.new_page

    def new_context(self: Browser, *args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        return _new_context(self, *args, **_with_english(kwargs))

    def new_page(self: Browser, *args: Any, **kwargs: Any):  # type: ignore[no-untyped-def]
        return _new_page(self, *args, **_with_english(kwargs))

    Browser.new_context = new_context  # type: ignore[method-assign]
    Browser.new_page = new_page  # type: ignore[method-assign]
    setattr(Browser, _PATCHED, True)
