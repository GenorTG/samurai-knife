import base64

from _rec import tag  # noqa: F401


class ObjectId:
    def __init__(self, oid):
        assert isinstance(oid, str) and len(oid) == 24, oid
        self.oid = oid

    def _tag(self):
        return {"$oid": self.oid}


class Int64(int):
    def _tag(self):
        return {"$long": str(int(self))}


class Decimal128:
    def __init__(self, value):
        assert isinstance(value, str), value
        self.value = value

    def _tag(self):
        return {"$decimal": self.value}


class Regex:
    def __init__(self, pattern, flags=0):
        assert isinstance(pattern, str) and isinstance(flags, str), (pattern, flags)
        self.pattern, self.flags = pattern, "".join(sorted(flags))

    def _tag(self):
        return {"$regex": [self.pattern, self.flags]}


class Timestamp:
    def __init__(self, time, inc):
        assert isinstance(time, int) and isinstance(inc, int)
        self.time, self.inc = time, inc

    def _tag(self):
        return {"$ts": [self.time, self.inc]}


class Binary(bytes):
    def __new__(cls, data, subtype=0):
        obj = super().__new__(cls, data)
        obj.subtype = subtype
        return obj

    def _tag(self):
        return {"$bin": [base64.b64encode(bytes(self)).decode(), self.subtype]}


class MinKey:
    def _tag(self):
        return {"$minKey": 1}


class MaxKey:
    def _tag(self):
        return {"$maxKey": 1}
