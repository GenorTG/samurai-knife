"""Puts tests/english_browser.py in every Python process tests/run_all.py starts (it sets PYTHONPATH to this folder), so a
suite that takes a server URL reads English labels too, whether or not it imports the module itself (docs/I18N.md)."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
try:
    import english_browser  # noqa: F401
except ImportError:  # a Python without Playwright (the engine suites that need no browser)
    pass
finally:
    sys.path.pop(0)
