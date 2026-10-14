from types import SimpleNamespace

from _rec import rec, tag


class Collection:
    def __init__(self, db, name):
        self._db, self._name = db, name

    def _call(self, method, args, kwargs, result=None):
        rec(kind="call", method=method, db=self._db, coll=self._name, args=[tag(a) for a in args], kwargs={k: tag(v) for k, v in kwargs.items()})
        return result

    def find(self, *a, **k):
        return self._call("find", a, k, [])

    def find_one(self, *a, **k):
        return self._call("find_one", a, k, None)

    def aggregate(self, *a, **k):
        return self._call("aggregate", a, k, [])

    def insert_one(self, *a, **k):
        return self._call("insert_one", a, k, SimpleNamespace(inserted_id=None))

    def insert_many(self, *a, **k):
        return self._call("insert_many", a, k, SimpleNamespace(inserted_ids=[]))

    def update_one(self, *a, **k):
        return self._call("update_one", a, k, SimpleNamespace(matched_count=0, modified_count=0, upserted_id=None))

    def update_many(self, *a, **k):
        return self._call("update_many", a, k, SimpleNamespace(matched_count=0, modified_count=0, upserted_id=None))

    def replace_one(self, *a, **k):
        return self._call("replace_one", a, k, SimpleNamespace(matched_count=0, modified_count=0))

    def delete_one(self, *a, **k):
        return self._call("delete_one", a, k, SimpleNamespace(deleted_count=0))

    def delete_many(self, *a, **k):
        return self._call("delete_many", a, k, SimpleNamespace(deleted_count=0))

    def count_documents(self, *a, **k):
        return self._call("count_documents", a, k, 0)

    def distinct(self, *a, **k):
        return self._call("distinct", a, k, [])

    def create_index(self, *a, **k):
        return self._call("create_index", a, k, "index_name")


class Database:
    def __init__(self, name):
        self._name = name

    def __getitem__(self, coll):
        return Collection(self._name, coll)


class MongoClient:
    def __init__(self, uri="mongodb://localhost:27017", **kw):
        rec(kind="client", uri=uri)

    def __getitem__(self, db):
        return Database(db)
