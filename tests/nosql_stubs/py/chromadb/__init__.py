from _rec import rec, tag


class Collection:
    def __init__(self, name):
        self._name = name

    def _call(self, method, kwargs, result=None):
        rec(kind="call", method=method, collection=self._name, kwargs={k: tag(v) for k, v in kwargs.items()})
        return result

    def add(self, **k):
        return self._call("add", k)

    def upsert(self, **k):
        return self._call("upsert", k)

    def update(self, **k):
        return self._call("update", k)

    def get(self, **k):
        return self._call("get", k, {})

    def query(self, **k):
        return self._call("query", k, {})

    def delete(self, **k):
        return self._call("delete", k)

    def count(self):
        return self._call("count", {}, 0)

    @property
    def name(self):
        return self._name


class _Client:
    def __init__(self, kind, **kw):
        rec(kind="client", type=kind, kwargs={k: tag(v) for k, v in kw.items()})

    def get_collection(self, name, **kw):
        rec(kind="call", method="get_collection", collection=name, kwargs={k: tag(v) for k, v in kw.items()})
        return Collection(name)

    def create_collection(self, name, **kw):
        rec(kind="call", method="create_collection", collection=name, kwargs={k: tag(v) for k, v in kw.items()})
        return Collection(name)

    def get_or_create_collection(self, name, **kw):
        rec(kind="call", method="get_or_create_collection", collection=name, kwargs={k: tag(v) for k, v in kw.items()})
        return Collection(name)


def PersistentClient(path=".chroma"):
    return _Client("persistent", path=path)


def HttpClient(host="localhost", port=8000, ssl=False, **kw):
    return _Client("http", host=host, port=port, ssl=ssl)


def CloudClient(tenant=None, database=None, api_key=None, **kw):
    import os

    assert api_key == os.environ["CHROMA_API_KEY"], "snippet must read the key from the environment, not embed it"
    return _Client("cloud", tenant=tenant, database=database, api_key="<from-env>")


def Client():
    return _Client("ephemeral")
