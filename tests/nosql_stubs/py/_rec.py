"""Recording helpers shared by the Python client stubs (pymongo, bson, chromadb, redis).

The stubs never talk to a server: every call a generated snippet makes is appended to CALLS in a tagged,
JSON-friendly form, and the runner prints it so tests/nosql_snippets_e2e.py can compare it with the spec."""
import datetime
import json
import math
import uuid

CALLS = []


def rec(**kw):
    CALLS.append(kw)


def tag(v):
    if v is None or isinstance(v, (bool, str)):
        return v
    if hasattr(v, "_tag"):
        return v._tag()
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        if math.isnan(v):
            return {"$double": "NaN"}
        if math.isinf(v):
            return {"$double": "Infinity" if v > 0 else "-Infinity"}
        return v
    if isinstance(v, datetime.datetime):
        assert v.tzinfo is not None, "naive datetime would be read as local time by PyMongo"
        delta = v - datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
        return {"$date": (delta.days * 86400 + delta.seconds) * 1000 + delta.microseconds // 1000}
    if isinstance(v, uuid.UUID):
        return {"$uuid": str(v)}
    if isinstance(v, (list, tuple)):
        return [tag(x) for x in v]
    if isinstance(v, dict):
        for key in v:
            assert isinstance(key, str), f"non-string key {key!r}"
        return {k: tag(x) for k, x in v.items()}
    raise TypeError(f"cannot tag {type(v)!r}")


def dump():
    print("@@CALLS@@" + json.dumps(CALLS, ensure_ascii=True))
