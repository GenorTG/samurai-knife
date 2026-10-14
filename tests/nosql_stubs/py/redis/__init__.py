"""Recording stand-in for redis-py. Each friendly method emits the command redis-py really sends (including
quirks such as incr(name) -> INCRBY name 1), so tests can compare the wire-level command with the spec."""
from _rec import rec


def _s(x):
    assert isinstance(x, (str, int, float)) and not isinstance(x, bool), f"redis-py would reject {x!r}"
    return str(x)


class Commands:
    def _emit(self, *tokens):
        raise NotImplementedError

    def execute_command(self, *args):
        return self._emit(*[_s(a) for a in args])

    def set(self, name, value, ex=None, px=None, nx=False, xx=False, keepttl=False, get=False, exat=None, pxat=None):
        t = ["SET", name, value]
        if ex is not None: t += ["EX", ex]
        if px is not None: t += ["PX", px]
        if exat is not None: t += ["EXAT", exat]
        if pxat is not None: t += ["PXAT", pxat]
        if nx: t.append("NX")
        if xx: t.append("XX")
        if keepttl: t.append("KEEPTTL")
        if get: t.append("GET")
        return self._emit(*map(_s, t))

    def get(self, name): return self._emit("GET", _s(name))
    def getdel(self, name): return self._emit("GETDEL", _s(name))
    def delete(self, *names): return self._emit("DEL", *map(_s, names))
    def unlink(self, *names): return self._emit("UNLINK", *map(_s, names))
    def exists(self, *names): return self._emit("EXISTS", *map(_s, names))
    def expire(self, name, time): return self._emit("EXPIRE", _s(name), _s(time))
    def pexpire(self, name, time): return self._emit("PEXPIRE", _s(name), _s(time))
    def expireat(self, name, when): return self._emit("EXPIREAT", _s(name), _s(when))
    def pexpireat(self, name, when): return self._emit("PEXPIREAT", _s(name), _s(when))
    def ttl(self, name): return self._emit("TTL", _s(name))
    def pttl(self, name): return self._emit("PTTL", _s(name))
    def persist(self, name): return self._emit("PERSIST", _s(name))
    def type(self, name): return self._emit("TYPE", _s(name))
    def incr(self, name, amount=1): return self.incrby(name, amount)
    def decr(self, name, amount=1): return self.decrby(name, amount)
    def incrby(self, name, amount=1): return self._emit("INCRBY", _s(name), _s(amount))
    def decrby(self, name, amount=1): return self._emit("DECRBY", _s(name), _s(amount))
    def incrbyfloat(self, name, amount=1.0): return self._emit("INCRBYFLOAT", _s(name), _s(amount))
    def append(self, key, value): return self._emit("APPEND", _s(key), _s(value))
    def strlen(self, name): return self._emit("STRLEN", _s(name))
    def setnx(self, name, value): return self._emit("SETNX", _s(name), _s(value))
    def setex(self, name, time, value): return self._emit("SETEX", _s(name), _s(time), _s(value))

    def mget(self, keys, *args):
        return self._emit("MGET", *map(_s, list(keys) + list(args)))

    def mset(self, mapping):
        t = ["MSET"]
        for k, v in mapping.items():
            t += [k, v]
        return self._emit(*map(_s, t))

    def hset(self, name, key=None, value=None, mapping=None, items=None):
        t = ["HSET", name]
        if key is not None:
            t += [key, value]
        if mapping:
            for k, v in mapping.items():
                t += [k, v]
        return self._emit(*map(_s, t))

    def hget(self, name, key): return self._emit("HGET", _s(name), _s(key))
    def hgetall(self, name): return self._emit("HGETALL", _s(name))
    def hdel(self, name, *keys): return self._emit("HDEL", _s(name), *map(_s, keys))
    def hexists(self, name, key): return self._emit("HEXISTS", _s(name), _s(key))
    def hmget(self, name, keys, *args): return self._emit("HMGET", _s(name), *map(_s, list(keys) + list(args)))
    def hincrby(self, name, key, amount=1): return self._emit("HINCRBY", _s(name), _s(key), _s(amount))
    def hkeys(self, name): return self._emit("HKEYS", _s(name))
    def hvals(self, name): return self._emit("HVALS", _s(name))
    def hlen(self, name): return self._emit("HLEN", _s(name))
    def lpush(self, name, *values): return self._emit("LPUSH", _s(name), *map(_s, values))
    def rpush(self, name, *values): return self._emit("RPUSH", _s(name), *map(_s, values))

    def lpop(self, name, count=None):
        return self._emit("LPOP", _s(name), *([] if count is None else [_s(count)]))

    def rpop(self, name, count=None):
        return self._emit("RPOP", _s(name), *([] if count is None else [_s(count)]))

    def lrange(self, name, start, end): return self._emit("LRANGE", _s(name), _s(start), _s(end))
    def ltrim(self, name, start, end): return self._emit("LTRIM", _s(name), _s(start), _s(end))
    def llen(self, name): return self._emit("LLEN", _s(name))
    def lindex(self, name, index): return self._emit("LINDEX", _s(name), _s(index))
    def lrem(self, name, count, value): return self._emit("LREM", _s(name), _s(count), _s(value))
    def sadd(self, name, *values): return self._emit("SADD", _s(name), *map(_s, values))
    def srem(self, name, *values): return self._emit("SREM", _s(name), *map(_s, values))
    def smembers(self, name): return self._emit("SMEMBERS", _s(name))
    def sismember(self, name, value): return self._emit("SISMEMBER", _s(name), _s(value))
    def scard(self, name): return self._emit("SCARD", _s(name))

    def spop(self, name, count=None):
        return self._emit("SPOP", _s(name), *([] if count is None else [_s(count)]))

    def sunion(self, keys, *args): return self._emit("SUNION", *map(_s, list(keys) + list(args)))
    def sinter(self, keys, *args): return self._emit("SINTER", *map(_s, list(keys) + list(args)))
    def sdiff(self, keys, *args): return self._emit("SDIFF", *map(_s, list(keys) + list(args)))

    def zadd(self, name, mapping):
        t = ["ZADD", name]
        for member, score in mapping.items():
            t += [score, member]
        return self._emit(*map(_s, t))

    def zrange(self, name, start, end, withscores=False):
        return self._emit("ZRANGE", _s(name), _s(start), _s(end), *(["WITHSCORES"] if withscores else []))

    def zrevrange(self, name, start, end, withscores=False):
        return self._emit("ZREVRANGE", _s(name), _s(start), _s(end), *(["WITHSCORES"] if withscores else []))

    def zrem(self, name, *values): return self._emit("ZREM", _s(name), *map(_s, values))
    def zcard(self, name): return self._emit("ZCARD", _s(name))
    def zscore(self, name, value): return self._emit("ZSCORE", _s(name), _s(value))
    def zrank(self, name, value): return self._emit("ZRANK", _s(name), _s(value))
    def zrevrank(self, name, value): return self._emit("ZREVRANK", _s(name), _s(value))
    def zincrby(self, name, amount, value): return self._emit("ZINCRBY", _s(name), _s(amount), _s(value))
    def zcount(self, name, min, max): return self._emit("ZCOUNT", _s(name), _s(min), _s(max))
    def publish(self, channel, message): return self._emit("PUBLISH", _s(channel), _s(message))
    def keys(self, pattern="*"): return self._emit("KEYS", _s(pattern))
    def rename(self, src, dst): return self._emit("RENAME", _s(src), _s(dst))
    def flushall(self, asynchronous=False): return self._emit("FLUSHALL", *(["ASYNC"] if asynchronous else []))
    def flushdb(self, asynchronous=False): return self._emit("FLUSHDB", *(["ASYNC"] if asynchronous else []))
    def dbsize(self): return self._emit("DBSIZE")
    def ping(self): return self._emit("PING")
    def info(self, section=None): return self._emit("INFO", *([] if section is None else [_s(section)]))
    def xlen(self, name): return self._emit("XLEN", _s(name))

    def xadd(self, name, fields, id="*"):
        t = ["XADD", name, id]
        for k, v in fields.items():
            t += [k, v]
        return self._emit(*map(_s, t))


class Redis(Commands):
    def __init__(self, host="localhost", port=6379, db=0, ssl=False, decode_responses=False, **kw):
        rec(kind="client", host=host, port=port, db=db, ssl=ssl, decode_responses=decode_responses)

    def _emit(self, *tokens):
        rec(kind="cmd", tokens=list(tokens))

    def pipeline(self, transaction=True):
        return Pipeline(transaction)

    def pubsub(self):
        return PubSub()


class Pipeline(Commands):
    def __init__(self, transaction):
        self.transaction, self.buffer = transaction, []

    def _emit(self, *tokens):
        self.buffer.append(list(tokens))
        return self

    def execute(self):
        rec(kind="tx" if self.transaction else "pipeline", commands=self.buffer)
        return []


class PubSub:
    def subscribe(self, *channels):
        rec(kind="cmd", tokens=["SUBSCRIBE", *map(_s, channels)])

    def psubscribe(self, *patterns):
        rec(kind="cmd", tokens=["PSUBSCRIBE", *map(_s, patterns)])

    def listen(self):
        return iter([])
