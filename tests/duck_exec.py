#!/usr/bin/env python3
"""Execution oracle helper for tests/sql_engine_e2e.py: runs jobs in DuckDB (>= 1.4, which has MERGE INTO).

stdin:  [{"setup": [sql, ...], "run": [sql, ...], "query": sql}, ...]
stdout: [{"rows": [[...], ...]} | {"error": str}, ...]    (one fresh in-memory database per job)
Run it with a python that has `duckdb` (optional dev dependency, never part of the app: KNIFE_DUCKDB_PY or ../samurai-knife-py/venv-duckdb)."""
import json
import sys

import duckdb

out = []
for job in json.load(sys.stdin):
    con = duckdb.connect()
    try:
        for sql in job["setup"] + job["run"]:
            con.execute(sql)
        out.append({"rows": [list(r) for r in con.execute(job["query"]).fetchall()]})
    except Exception as error:  # report, never abort the batch
        out.append({"error": f"{type(error).__name__}: {error}"})
    finally:
        con.close()
json.dump(out, sys.stdout, default=str)
