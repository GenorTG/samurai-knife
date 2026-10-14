"""Runs a generated snippet with the stub packages first on sys.path, then prints the recorded calls."""
import runpy
import sys

stub_dir, snippet = sys.argv[1], sys.argv[2]
sys.path.insert(0, stub_dir)
import _rec  # noqa: E402

runpy.run_path(snippet, run_name="__main__")
_rec.dump()
