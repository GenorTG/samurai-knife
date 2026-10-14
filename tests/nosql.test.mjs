// Known-answer tests for src/lib/nosql/{mongo,chroma,redis}.ts. Expected strings are written by hand from the
// official client syntaxes, never copied from the generator's output.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/nosql.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import * as chroma from "../src/lib/nosql/chroma.ts";
import { parseJsonLossless } from "../src/lib/nosql/common.ts";
import * as mongo from "../src/lib/nosql/mongo.ts";
import * as redis from "../src/lib/nosql/redis.ts";

const C = { compact: true };
const snippet = (result, label) => result.snippets.find((s) => s.label.startsWith(label))?.code;
const errors = (issues) => issues.filter((i) => i.severity === "error");
const find = (issues, severity, path) => issues.find((i) => i.severity === severity && i.path === path);

/* ================================================================== MongoDB */

test("mongo: find compiles to mongosh, PyMongo and Node.js with exact wrapped layout", () => {
  const spec = { op: "find", database: "shop", collection: "users", filter: { status: "active", age: { $gte: 18 } }, projection: { name: 1, _id: 0 }, sort: { createdAt: -1 }, limit: 20 };
  const r = mongo.compile(spec);
  assert.equal(r.ok, true);
  assert.equal(snippet(r, "mongosh"), 'db = db.getSiblingDB("shop");\n\ndb.users.find(\n  { status: "active", age: { $gte: 18 } },\n  { name: 1, _id: 0 },\n).sort({ createdAt: -1 }).limit(20);\n');
  assert.equal(
    snippet(r, "PyMongo"),
    'from pymongo import MongoClient\n\nclient = MongoClient("mongodb://localhost:27017")\ncoll = client["shop"]["users"]\n\ndocs = list(coll.find(\n    {"status": "active", "age": {"$gte": 18}},\n    {"name": 1, "_id": 0},\n    limit=20,\n    sort=[("createdAt", -1)],\n))\nfor doc in docs:\n    print(doc)\n',
  );
  assert.equal(
    snippet(r, "Node.js"),
    'import { MongoClient } from "mongodb";\n\nconst client = new MongoClient("mongodb://localhost:27017");\ntry {\n  await client.connect();\n  const coll = client.db("shop").collection("users");\n\n  const docs = await coll.find(\n    { status: "active", age: { $gte: 18 } },\n    { projection: { name: 1, _id: 0 }, sort: { createdAt: -1 }, limit: 20 },\n  ).toArray();\n  console.log(docs);\n} finally {\n  await client.close();\n}\n',
  );
  // compact mode: one statement per line, no wrapping
  assert.ok(snippet(mongo.compile(spec, C), "mongosh").includes('db.users.find({ status: "active", age: { $gte: 18 } }, { name: 1, _id: 0 }).sort({ createdAt: -1 }).limit(20);'));
});

test("mongo: a lone object argument hugs the parentheses when it must wrap", () => {
  const r = mongo.compile({ op: "findOne", collection: "orders", filter: { _id: { $oid: "507f1f77bcf86cd799439011" }, at: { $gte: { $date: "2025-01-02T03:04:05.678Z" } }, status: "shipped" } });
  assert.equal(snippet(r, "mongosh"), 'db.orders.findOne({\n  _id: ObjectId("507f1f77bcf86cd799439011"),\n  at: { $gte: ISODate("2025-01-02T03:04:05.678Z") },\n  status: "shipped",\n});\n');
});

test("mongo: ObjectId and dates map to each language's constructor", () => {
  const r = mongo.compile({ op: "findOne", collection: "orders", filter: { _id: { $oid: "507f1f77bcf86cd799439011" }, at: { $gte: { $date: "2025-01-02T03:04:05.678Z" } } } }, C);
  assert.match(snippet(r, "mongosh"), /^db\.orders\.findOne\(\{ _id: ObjectId\("507f1f77bcf86cd799439011"\), at: \{ \$gte: ISODate\("2025-01-02T03:04:05.678Z"\) \} \}\);\n$/);
  const py = snippet(r, "PyMongo");
  assert.ok(py.includes("import datetime\n"));
  assert.ok(py.includes("from bson import ObjectId"));
  assert.ok(py.includes('{"_id": ObjectId("507f1f77bcf86cd799439011"), "at": {"$gte": datetime.datetime(2025, 1, 2, 3, 4, 5, 678000, tzinfo=datetime.timezone.utc)}}'));
  const node = snippet(r, "Node.js");
  assert.ok(node.startsWith('import { MongoClient, ObjectId } from "mongodb";'));
  assert.ok(node.includes('new ObjectId("507f1f77bcf86cd799439011")'));
  assert.ok(node.includes('new Date("2025-01-02T03:04:05.678Z")'));
});

test("mongo: $numberLong, $numberDecimal and big integers", () => {
  const r = mongo.compile({ op: "insertOne", collection: "c", document: { a: { $numberLong: "9007199254740993" }, d: { $numberDecimal: "10.99" }, n: 7 } }, C);
  assert.ok(snippet(r, "mongosh").includes('{ a: NumberLong("9007199254740993"), d: NumberDecimal("10.99"), n: 7 }'));
  assert.ok(snippet(r, "PyMongo").includes('{"a": Int64(9007199254740993), "d": Decimal128("10.99"), "n": 7}'));
  assert.ok(snippet(r, "PyMongo").includes("from bson import Decimal128, Int64"));
  assert.ok(snippet(r, "Node.js").includes('{ a: Long.fromString("9007199254740993"), d: Decimal128.fromString("10.99"), n: 7 }'));
  // JSON.parse would round 9007199254740993 to ...992; the lossless parser keeps it exact
  const parsed = mongo.parseSpecText('{"op":"insertOne","collection":"c","document":{"big":9007199254740993}}');
  assert.equal(parsed.spec.document.big, 9007199254740993n);
  assert.ok(snippet(mongo.compile(parsed.spec, C), "mongosh").includes('NumberLong("9007199254740993")'));
});

test("mongo: plain integers above 32 bits get an info about double vs int64", () => {
  const r = mongo.compile({ op: "find", collection: "c", filter: { n: 3000000000 }, limit: 1 }, C);
  assert.ok(find(r.issues, "info", "filter.n"));
});

test("mongo: regex values per language", () => {
  const r = mongo.compile({ op: "find", collection: "c", filter: { name: { $regularExpression: { pattern: "^a/b", options: "i" } } }, limit: 1 }, C);
  assert.ok(snippet(r, "mongosh").includes("name: /^a\\/b/i"));
  assert.ok(snippet(r, "PyMongo").includes('Regex("^a/b", "i")'));
  assert.ok(snippet(r, "Node.js").includes("name: /^a\\/b/i"));
});

test("mongo: aggregate with $group compiles and explains", () => {
  const spec = { op: "aggregate", collection: "orders", pipeline: [{ $match: { status: "paid" } }, { $group: { _id: "$customerId", total: { $sum: "$amount" } } }, { $sort: { total: -1 } }, { $limit: 3 }] };
  const r = mongo.compile(spec, C);
  assert.equal(r.ok, true);
  assert.equal(snippet(r, "mongosh"), 'db.orders.aggregate([{ $match: { status: "paid" } }, { $group: { _id: "$customerId", total: { $sum: "$amount" } } }, { $sort: { total: -1 } }, { $limit: 3 }]);\n');
  assert.deepEqual(mongo.explain(spec), [
    "Work in collection orders.",
    'Stage 1: Keep only documents where status equals "paid".',
    'Stage 2: Group documents by "$customerId"; compute total = sum of "$amount".',
    "Stage 3: Sort by total descending.",
    "Stage 4: Keep only the first 3 documents.",
  ]);
});

test("mongo: updateOne passes options to every language", () => {
  const r = mongo.compile({ op: "updateOne", collection: "users", filter: { email: "a@b.c" }, update: { $set: { status: "on" }, $inc: { n: 1 } }, options: { upsert: true } }, C);
  assert.ok(snippet(r, "mongosh").includes('db.users.updateOne({ email: "a@b.c" }, { $set: { status: "on" }, $inc: { n: 1 } }, { upsert: true });'));
  assert.ok(snippet(r, "PyMongo").includes('result = coll.update_one({"email": "a@b.c"}, {"$set": {"status": "on"}, "$inc": {"n": 1}}, upsert=True)'));
  assert.ok(snippet(r, "Node.js").includes('await coll.updateOne({ email: "a@b.c" }, { $set: { status: "on" }, $inc: { n: 1 } }, { upsert: true });'));
});

test("mongo: insertMany ordered:false and arrayFilters kwarg names", () => {
  const ins = mongo.compile({ op: "insertMany", collection: "c", documents: [{ a: 1 }, { a: 2 }], options: { ordered: false } }, C);
  assert.ok(snippet(ins, "PyMongo").includes("coll.insert_many([{\"a\": 1}, {\"a\": 2}], ordered=False)"));
  assert.ok(snippet(ins, "Node.js").includes("insertMany([{ a: 1 }, { a: 2 }], { ordered: false })"));
  const upd = mongo.compile({ op: "updateMany", collection: "c", filter: {}, update: { $set: { "items.$[e].q": 0 } }, options: { arrayFilters: [{ "e.sku": "A" }] } }, C);
  assert.ok(snippet(upd, "PyMongo").includes('array_filters=[{"e.sku": "A"}]'));
});

test("mongo: createIndex keys become tuples in PyMongo, options keep server spelling", () => {
  const r = mongo.compile({ op: "createIndex", collection: "s", keys: { createdAt: 1, k: -1 }, options: { expireAfterSeconds: 3600 } }, C);
  assert.equal(r.ok, false); // TTL needs a single-field index
  assert.ok(find(r.issues, "error", "options.expireAfterSeconds"));
  const ok = mongo.compile({ op: "createIndex", collection: "s", keys: { createdAt: 1 }, options: { expireAfterSeconds: 3600, name: "ttl" } }, C);
  assert.ok(snippet(ok, "mongosh").includes('db.s.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600, name: "ttl" });'));
  assert.ok(snippet(ok, "PyMongo").includes('coll.create_index([("createdAt", 1)], expireAfterSeconds=3600, name="ttl")'));
});

test("mongo: escaping of quotes, backslashes, newlines and unicode", () => {
  const value = 'He said "hi"\\ \n tab\t é 😀';
  const r = mongo.compile({ op: "insertOne", collection: "c", document: { v: value } }, C);
  assert.ok(snippet(r, "mongosh").includes('{ v: "He said \\"hi\\"\\\\ \\n tab\\t é 😀" }'));
  assert.ok(snippet(r, "PyMongo").includes('{"v": "He said \\"hi\\"\\\\ \\n tab\\t é 😀"}'));
});

test("mongo: collection names that are not identifiers use getCollection", () => {
  const r = mongo.compile({ op: "countDocuments", collection: "my-coll" }, C);
  assert.equal(snippet(r, "mongosh"), 'db.getCollection("my-coll").countDocuments({});\n');
});

test("mongo: unknown operator names the full path and suggests the fix", () => {
  const r = mongo.compile({ op: "find", collection: "c", filter: { age: { $gtt: 5 } } }, C);
  assert.equal(r.ok, false);
  const e = find(r.issues, "error", "filter.age.$gtt");
  assert.match(e.message, /Unknown query operator \$gtt\. Did you mean \$gt\?/);
});

test("mongo: update operator in a filter gets a placement hint", () => {
  const r = mongo.validate({ op: "find", collection: "c", filter: { $set: { a: 1 } } });
  assert.match(find(r.issues, "error", "filter.$set").message, /update operator/);
});

test("mongo: field-level operator used at the top level", () => {
  const r = mongo.validate({ op: "find", collection: "c", filter: { $gt: 5 } });
  assert.match(find(r.issues, "error", "filter.$gt").message, /must be applied to a field/);
});

test("mongo: mixing operators and plain keys in one condition", () => {
  const r = mongo.validate({ op: "find", collection: "c", filter: { a: { $gt: 1, b: 2 } } });
  assert.ok(find(r.issues, "error", "filter.a"));
});

test("mongo: $in needs an array, $size a non-negative integer, $type a known alias", () => {
  const r = mongo.validate({ op: "find", collection: "c", filter: { a: { $in: 5 }, b: { $size: -1 }, c: { $type: "strng" } } });
  assert.ok(find(r.issues, "error", "filter.a.$in"));
  assert.ok(find(r.issues, "error", "filter.b.$size"));
  assert.match(find(r.issues, "error", "filter.c.$type").message, /Did you mean string\?/);
});

test("mongo: a 24-hex _id string is flagged as a probable ObjectId", () => {
  const r = mongo.validate({ op: "find", collection: "c", filter: { _id: "507f1f77bcf86cd799439011" } });
  assert.ok(find(r.issues, "warning", "filter._id"));
});

test("mongo: projection cannot mix inclusion and exclusion", () => {
  const r = mongo.validate({ op: "find", collection: "c", projection: { a: 1, b: 0 } });
  assert.ok(find(r.issues, "error", "projection"));
  assert.equal(mongo.validate({ op: "find", collection: "c", projection: { a: 1, _id: 0 } }).ok, true);
});

test("mongo: sort direction must be 1 or -1", () => {
  const r = mongo.validate({ op: "find", collection: "c", sort: { a: 2 } });
  assert.ok(find(r.issues, "error", "sort.a"));
});

test("mongo: $group without _id and unknown accumulator", () => {
  const a = mongo.validate({ op: "aggregate", collection: "c", pipeline: [{ $group: { n: { $sum: 1 } } }] });
  assert.ok(find(a.issues, "error", "pipeline[0].$group"));
  const b = mongo.validate({ op: "aggregate", collection: "c", pipeline: [{ $group: { _id: null, n: { $summ: 1 } } }] });
  assert.match(find(b.issues, "error", "pipeline[0].$group.n.$summ").message, /Did you mean \$sum\?/);
});

test("mongo: unknown stage suggests the right one", () => {
  const r = mongo.validate({ op: "aggregate", collection: "c", pipeline: [{ $mach: {} }] });
  assert.match(find(r.issues, "error", "pipeline[0].$mach").message, /Did you mean \$match\?/);
});

test("mongo: stage order warnings ($limit before $sort, late $match)", () => {
  const a = mongo.validate({ op: "aggregate", collection: "c", pipeline: [{ $limit: 5 }, { $sort: { a: 1 } }] });
  assert.ok(find(a.issues, "warning", "pipeline[0]"));
  const b = mongo.validate({ op: "aggregate", collection: "c", pipeline: [{ $group: { _id: "$a", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }] });
  assert.ok(find(b.issues, "warning", "pipeline[1]"));
  const c = mongo.validate({ op: "aggregate", collection: "c", pipeline: [{ $match: { a: 1 } }, { $group: { _id: "$a" } }] });
  assert.equal(c.issues.filter((i) => i.severity === "warning").length, 0);
});

test("mongo: $out must be last, $geoNear first, $where not allowed in $match, $text first", () => {
  const out = mongo.validate({ op: "aggregate", collection: "c", pipeline: [{ $out: "x" }, { $limit: 1 }] });
  assert.ok(find(out.issues, "error", "pipeline[0].$out"));
  const geo = mongo.validate({ op: "aggregate", collection: "c", pipeline: [{ $match: {} }, { $geoNear: { near: { type: "Point", coordinates: [0, 0] }, distanceField: "d" } }] });
  assert.ok(find(geo.issues, "error", "pipeline[1].$geoNear"));
  const where = mongo.validate({ op: "aggregate", collection: "c", pipeline: [{ $match: { $where: "this.a" } }] });
  assert.ok(find(where.issues, "error", "pipeline[0].$match.$where"));
  const text = mongo.validate({ op: "aggregate", collection: "c", pipeline: [{ $match: { a: 1 } }, { $match: { $text: { $search: "x" } } }] });
  assert.ok(find(text.issues, "error", "pipeline[1].$match.$text"));
});

test("mongo: expression variables and operators inside stages are checked", () => {
  const r = mongo.validate({ op: "aggregate", collection: "c", pipeline: [{ $addFields: { x: "$$ROOTT", y: { $sumn: [1, 2] } } }] });
  assert.match(find(r.issues, "error", "pipeline[0].$addFields.x").message, /not a system variable/);
  assert.match(find(r.issues, "error", "pipeline[0].$addFields.y.$sumn").message, /Did you mean \$sum\?/);
  assert.equal(mongo.validate({ op: "aggregate", collection: "c", pipeline: [{ $addFields: { x: { $map: { input: "$a", as: "e", in: { $add: ["$$e", 1] } } } } }] }).ok, true);
});

test("mongo: update must use operators; conflicts and arrayFilters are checked", () => {
  const plain = mongo.validate({ op: "updateOne", collection: "c", filter: {}, update: { a: 1 } });
  assert.ok(find(plain.issues, "error", "update.a"));
  const conflict = mongo.validate({ op: "updateOne", collection: "c", filter: { a: 1 }, update: { $set: { a: 1 }, $inc: { a: 1 } } });
  assert.ok(find(conflict.issues, "error", "update.$inc.a"));
  const noFilters = mongo.validate({ op: "updateOne", collection: "c", filter: { a: 1 }, update: { $set: { "i.$[x].q": 1 } } });
  assert.ok(find(noFilters.issues, "error", "options.arrayFilters"));
  const unknown = mongo.validate({ op: "updateOne", collection: "c", filter: { a: 1 }, update: { $sett: { a: 1 } } });
  assert.match(find(unknown.issues, "error", "update.$sett").message, /Did you mean \$set\?/);
});

test("mongo: replaceOne rejects operators; insertMany rejects duplicate _id; deleteMany {} warns", () => {
  assert.ok(find(mongo.validate({ op: "replaceOne", collection: "c", filter: { a: 1 }, replacement: { $set: { a: 2 } } }).issues, "error", "replacement.$set"));
  assert.ok(find(mongo.validate({ op: "insertMany", collection: "c", documents: [{ _id: 1 }, { _id: 1 }] }).issues, "error", "documents[1]._id"));
  assert.ok(find(mongo.validate({ op: "deleteMany", collection: "c", filter: {} }).issues, "warning", "filter"));
});

test("mongo: countDocuments rejects $near and $where", () => {
  const r = mongo.validate({ op: "countDocuments", collection: "c", filter: { loc: { $near: { $geometry: { type: "Point", coordinates: [0, 0] } } }, $where: "1" } });
  assert.ok(find(r.issues, "error", "filter.loc.$near"));
  assert.ok(find(r.issues, "error", "filter.$where"));
});

test("mongo: structural errors name the field and suggest near misses", () => {
  assert.match(mongo.validate({ op: "fnd", collection: "c" }).issues[0].message, /Did you mean find\?/);
  const extra = mongo.validate({ op: "find", collection: "c", limt: 5 });
  assert.equal(extra.issues[0].path, "limt");
  assert.match(extra.issues[0].fix, /Did you mean "limit"\?/);
  const missing = mongo.validate({ op: "find" });
  assert.equal(missing.issues[0].path, "collection");
  assert.equal(mongo.validate({ op: "find", collection: "c", limit: -1 }).issues[0].path, "limit");
});

test("mongo: bad Extended JSON wrappers are rejected with their path", () => {
  const r = mongo.validate({ op: "find", collection: "c", filter: { _id: { $oid: "xyz" } } });
  assert.ok(find(r.issues, "error", "filter._id"));
  assert.ok(find(mongo.validate({ op: "find", collection: "c", filter: { a: { $date: "not a date" } } }).issues, "error", "filter.a"));
});

test("mongo: mongosh syntax is parsed into Extended JSON", () => {
  const parsed = mongo.parseSpecText('{op: "find", collection: "orders", filter: {_id: ObjectId("507f1f77bcf86cd799439011"), at: {$gte: ISODate("2025-01-01T00:00:00Z")}, n: NumberLong(5), r: /^x/i}}');
  assert.equal(parsed.convertedFromShell, true);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.spec.filter._id)), { $oid: "507f1f77bcf86cd799439011" });
  assert.equal(mongo.compile(parsed.spec, C).ok, true);
  assert.equal(mongo.parseSpecText("{op: find").issues[0].severity, "error");
});

test("mongo: shell <-> Extended JSON conversion (relaxed and canonical)", () => {
  const text = 'ObjectId("507f1f77bcf86cd799439011")';
  assert.equal(mongo.convertValueText(text, "relaxed").text, '{\n  "$oid": "507f1f77bcf86cd799439011"\n}');
  assert.equal(mongo.convertValueText('{a: NumberInt(5), d: ISODate("2019-08-11T17:54:14.692Z")}', "canonical").text, '{\n  "a": {\n    "$numberInt": "5"\n  },\n  "d": {\n    "$date": {\n      "$numberLong": "1565546054692"\n    }\n  }\n}');
  assert.equal(mongo.convertValueText('{"d": {"$date": {"$numberLong": "1565546054692"}}}', "relaxed").text, '{\n  "d": {\n    "$date": "2019-08-11T17:54:14.692Z"\n  }\n}');
  assert.equal(mongo.convertValueText('{"n": {"$numberLong": "50"}}', "shell").text, '{ n: NumberLong("50") }');
  assert.equal(mongo.convertValueText("ObjectId(", "relaxed").ok, false);
});

test("mongo: every gallery example compiles without errors", () => {
  for (const ex of mongo.MONGO_EXAMPLES) {
    const r = mongo.compile(ex.spec, C);
    assert.equal(r.ok, true, `${ex.id}: ${JSON.stringify(errors(r.issues))}`);
    assert.equal(r.snippets.length, 4);
  }
  assert.ok(mongo.MONGO_EXAMPLES.length >= 12);
});

test("mongo/chroma: a __proto__ field is refused instead of silently dropped", () => {
  const spec = mongo.parseSpecText('{"op":"insertOne","collection":"c","document":{"a":{"__proto__":1}}}').spec;
  assert.equal(mongo.validate(spec).issues[0].path, "document.a.__proto__");
  assert.equal(chroma.validate(JSON.parse('{"op":"add","collection":"abc","ids":["a"],"documents":["d"],"metadatas":[{"__proto__":"x"}]}')).issues[0].path, "metadatas[0].__proto__");
});

test("mongo: lossless JSON parser", () => {
  assert.equal(parseJsonLossless("[1, 2.5, -3, 9007199254740993, true, null, \"x\"]").value[3], 9007199254740993n);
  assert.equal(parseJsonLossless("{").ok, false);
  assert.equal(parseJsonLossless('{"a":1,}').ok, false);
});

/* ==================================================================== Chroma */

test("chroma: add documents with metadata (Python + JS exact)", () => {
  const spec = { op: "add", collection: "articles", ids: ["a1", "a2"], documents: ["Cats sleep.", "Dogs walk."], metadatas: [{ topic: "cats", year: 2022 }, { topic: "dogs", year: 2023 }] };
  const r = chroma.compile(spec);
  assert.equal(r.ok, true);
  assert.equal(
    snippet(r, "Python"),
    'import chromadb\n\nclient = chromadb.PersistentClient(path="./chroma")\ncollection = client.get_collection(name="articles")\ncollection.add(\n    ids=["a1", "a2"],\n    documents=["Cats sleep.", "Dogs walk."],\n    metadatas=[\n        {"topic": "cats", "year": 2022},\n        {"topic": "dogs", "year": 2023},\n    ],\n)\n',
  );
  assert.equal(
    snippet(r, "JavaScript"),
    'import { ChromaClient } from "chromadb";\n\n// The JS client talks to a Chroma server; start one with: npx chroma run --path ./chroma\nconst client = new ChromaClient({ host: "localhost", port: 8000, ssl: false });\nconst collection = await client.getCollection({ name: "articles" });\nawait collection.add({\n  ids: ["a1", "a2"],\n  documents: ["Cats sleep.", "Dogs walk."],\n  metadatas: [{ topic: "cats", year: 2022 }, { topic: "dogs", year: 2023 }],\n});\n',
  );
});

test("chroma: query uses camelCase keys in JS and snake_case in Python", () => {
  const r = chroma.compile({ op: "query", collection: "c", query_texts: ["q"], n_results: 3, where: { year: { $gte: 2020 } }, where_document: { $contains: "x" }, include: ["documents", "distances"] });
  assert.ok(snippet(r, "Python").includes('collection.query(\n    query_texts=["q"],\n    n_results=3,\n    where={"year": {"$gte": 2020}},\n    where_document={"$contains": "x"},\n    include=["documents", "distances"],\n)'));
  assert.ok(snippet(r, "JavaScript").includes('queryTexts: ["q"]') && snippet(r, "JavaScript").includes("nResults: 3") && snippet(r, "JavaScript").includes('whereDocument: { $contains: "x" }'));
});

test("chroma: create collection with cosine config, none/openai embedding functions", () => {
  const cosine = chroma.compile({ op: "get_or_create_collection", collection: "docs", configuration: { hnsw: { space: "cosine" } } }, C);
  assert.ok(snippet(cosine, "Python").includes('client.get_or_create_collection(name="docs", configuration={"hnsw": {"space": "cosine"}})'));
  assert.ok(snippet(cosine, "JavaScript").includes('client.getOrCreateCollection({ name: "docs", configuration: { hnsw: { space: "cosine" } } })'));
  const none = chroma.compile({ op: "create_collection", collection: "docs", embedding_function: "none" }, C);
  assert.ok(snippet(none, "Python").includes("embedding_function=None"));
  assert.ok(snippet(none, "JavaScript").includes("embeddingFunction: null"));
  const oa = chroma.compile({ op: "create_collection", collection: "docs", embedding_function: "openai" }, C);
  assert.ok(snippet(oa, "Python").includes("from chromadb.utils.embedding_functions import OpenAIEmbeddingFunction"));
  assert.ok(snippet(oa, "JavaScript").includes('import { OpenAIEmbeddingFunction } from "@chroma-core/openai";'));
});

test("chroma: client choice (Http, Cloud, ephemeral)", () => {
  const http = chroma.compile({ op: "count", collection: "docs", client: { type: "http", host: "db.local", port: 9000, ssl: true } }, C);
  assert.ok(snippet(http, "Python").includes('chromadb.HttpClient(host="db.local", port=9000, ssl=True)'));
  assert.ok(snippet(http, "JavaScript").includes('new ChromaClient({ host: "db.local", port: 9000, ssl: true })'));
  const cloud = chroma.compile({ op: "count", collection: "docs", client: { type: "cloud", tenant: "t", database: "d" } }, C);
  assert.ok(snippet(cloud, "Python").includes('chromadb.CloudClient(tenant="t", database="d", api_key=os.environ["CHROMA_API_KEY"])'));
  assert.ok(snippet(cloud, "Python").startsWith("import os\nimport chromadb"));
  assert.ok(snippet(cloud, "JavaScript").includes('new CloudClient({ tenant: "t", database: "d", apiKey: process.env.CHROMA_API_KEY })'));
  const eph = chroma.compile({ op: "count", collection: "docs", client: { type: "ephemeral" } }, C);
  assert.ok(snippet(eph, "Python").includes("chromadb.Client()"));
});

test("chroma: get / delete / count shapes", () => {
  const g = chroma.compile({ op: "get", collection: "c", ids: ["a"], limit: 5, offset: 10 });
  assert.ok(snippet(g, "Python").includes('results = collection.get(ids=["a"], limit=5, offset=10)'));
  const d = chroma.compile({ op: "delete", collection: "c", where: { year: { $lt: 2000 } } }, C);
  assert.ok(snippet(d, "Python").includes('collection.delete(where={"year": {"$lt": 2000}})'));
  assert.ok(find(d.issues, "warning", "op"));
  assert.ok(snippet(chroma.compile({ op: "count", collection: "c" }, C), "Python").includes("print(collection.count())"));
});

test("chroma: where needs one condition per object (no implicit AND)", () => {
  const r = chroma.validate({ op: "get", collection: "c", where: { a: 1, b: 2 } });
  assert.ok(find(r.issues, "error", "where"));
  assert.match(find(r.issues, "error", "where").fix, /\$and/);
});

test("chroma: $and / $or need at least two conditions", () => {
  const r = chroma.validate({ op: "get", collection: "c", where: { $and: [{ a: 1 }] } });
  assert.match(find(r.issues, "error", "where.$and").message, /at least 2/);
  assert.equal(chroma.validate({ op: "get", collection: "c", where: { $or: [{ a: 1 }, { b: { $gt: 2 } }] } }).ok, true);
});

test("chroma: unknown where operator suggests the right one", () => {
  const r = chroma.validate({ op: "get", collection: "c", where: { a: { $gtt: 1 } } });
  assert.match(find(r.issues, "error", "where.a.$gtt").message, /Did you mean \$gt\?/);
});

test("chroma: where operator operand types", () => {
  assert.ok(find(chroma.validate({ op: "get", collection: "c", where: { a: { $gt: "x" } } }).issues, "error", "where.a.$gt"));
  assert.ok(find(chroma.validate({ op: "get", collection: "c", where: { a: { $in: [] } } }).issues, "error", "where.a.$in"));
  assert.ok(find(chroma.validate({ op: "get", collection: "c", where: { a: { $in: [1, "x"] } } }).issues, "error", "where.a.$in"));
  assert.ok(find(chroma.validate({ op: "get", collection: "c", where: { a: { $eq: [1] } } }).issues, "error", "where.a.$eq"));
  assert.ok(find(chroma.validate({ op: "get", collection: "c", where: { a: { $gt: 1, $lt: 5 } } }).issues, "error", "where.a"));
  assert.equal(chroma.validate({ op: "get", collection: "c", where: { tags: { $contains: "x" } } }).ok, true);
});

test("chroma: document operators do not belong in where (and vice versa)", () => {
  assert.match(find(chroma.validate({ op: "get", collection: "c", where: { a: { $regex: "x" } } }).issues, "error", "where.a.$regex").message, /where_document/);
  assert.match(find(chroma.validate({ op: "get", collection: "c", where_document: { $eq: "x" } }).issues, "error", "where_document.$eq").message, /where, not where_document/);
  assert.ok(find(chroma.validate({ op: "get", collection: "c", where_document: { $contains: "" } }).issues, "error", "where_document.$contains"));
  assert.ok(find(chroma.validate({ op: "get", collection: "c", where_document: { $and: [{ $contains: "a" }] } }).issues, "error", "where_document.$and"));
  assert.equal(chroma.validate({ op: "get", collection: "c", where_document: { $or: [{ $regex: "^a" }, { $not_contains: "b" }] } }).ok, true);
});

test("chroma: metadata values must be scalar or same-type arrays", () => {
  const meta = (m) => chroma.validate({ op: "add", collection: "c", ids: ["a"], documents: ["d"], metadatas: [m] });
  assert.ok(find(meta({ a: { b: 1 } }).issues, "error", "metadatas[0].a"));
  assert.ok(find(meta({ a: null }).issues, "error", "metadatas[0].a"));
  assert.ok(find(meta({ a: [] }).issues, "error", "metadatas[0].a"));
  assert.ok(find(meta({ a: [1, "x"] }).issues, "error", "metadatas[0].a"));
  assert.ok(find(meta({ a: [[1]] }).issues, "error", "metadatas[0].a"));
  assert.ok(find(meta({ "chroma:x": 1 }).issues, "error", "metadatas[0].chroma:x"));
  assert.equal(meta({ a: ["x", "y"], b: [1, 2], c: 1.5, d: true }).ok, true);
});

test("chroma: record lists must have equal length and unique string ids", () => {
  const len = chroma.validate({ op: "add", collection: "c", ids: ["a", "b", "c"], documents: ["1", "2"] });
  assert.match(find(len.issues, "error", "documents").message, /2 items but ids has 3/);
  const dup = chroma.validate({ op: "add", collection: "c", ids: ["a", "a"], documents: ["1", "2"] });
  assert.ok(find(dup.issues, "error", "ids[1]"));
  assert.ok(find(chroma.validate({ op: "add", collection: "c", ids: [1], documents: ["x"] }).issues, "error", "ids[0]"));
  const dims = chroma.validate({ op: "add", collection: "c", ids: ["a", "b"], embeddings: [[1, 2], [1, 2, 3]] });
  assert.ok(find(dims.issues, "error", "embeddings[1]"));
});

test("chroma: add needs documents or embeddings; update needs something to change", () => {
  assert.ok(find(chroma.validate({ op: "add", collection: "c", ids: ["a"] }).issues, "error", "documents"));
  assert.ok(find(chroma.validate({ op: "update", collection: "c", ids: ["a"] }).issues, "error", "documents"));
  assert.equal(chroma.validate({ op: "update", collection: "c", ids: ["a"], metadatas: [{ k: 1 }] }).ok, true);
});

test("chroma: query needs exactly one of query_texts / query_embeddings", () => {
  assert.ok(find(chroma.validate({ op: "query", collection: "c" }).issues, "error", "query_texts"));
  assert.ok(find(chroma.validate({ op: "query", collection: "c", query_texts: ["a"], query_embeddings: [[1]] }).issues, "error", "query_embeddings"));
  assert.ok(find(chroma.validate({ op: "query", collection: "c", query_texts: ["a"], n_results: 0 }).issues, "error", "n_results"));
});

test("chroma: delete needs a selector; include values are checked per operation", () => {
  assert.ok(find(chroma.validate({ op: "delete", collection: "c" }).issues, "error", "ids"));
  assert.match(find(chroma.validate({ op: "get", collection: "c", include: ["distances"] }).issues, "error", "include[0]").message, /only returned by query/);
  assert.match(find(chroma.validate({ op: "query", collection: "c", query_texts: ["a"], include: ["document"] }).issues, "error", "include[0]").message, /Did you mean documents\?/);
});

test("chroma: collection names follow the documented rules", () => {
  const name = (n) => chroma.validate({ op: "create_collection", collection: n }).issues.filter((i) => i.path === "collection" && i.severity === "error");
  assert.equal(name("ab").length, 1);
  assert.equal(name("a..b").length, 1);
  assert.equal(name("192.168.1.1").length, 1);
  assert.equal(name("-abc").length, 1);
  assert.equal(name("my coll").length >= 1, true);
  assert.equal(name("my_collection-1.v2").length, 0);
});

test("chroma: configuration and client validation", () => {
  assert.ok(find(chroma.validate({ op: "create_collection", collection: "abc", configuration: { hnsw: { space: "euclid" } } }).issues, "error", "configuration.hnsw.space"));
  assert.ok(chroma.validate({ op: "count", collection: "abc", client: { type: "postgres" } }).issues.some((i) => i.path === "client.type"));
  assert.ok(find(chroma.validate({ op: "count", collection: "abc", client: { type: "http", port: 70000 } }).issues, "error", "client.port"));
});

test("chroma: structural errors name the field", () => {
  assert.match(chroma.validate({ op: "qurey", collection: "c" }).issues[0].message, /Did you mean query\?/);
  const extra = chroma.validate({ op: "query", collection: "c", query_text: ["a"] });
  assert.equal(extra.issues[0].path, "query_text");
  assert.match(extra.issues[0].fix, /query_texts/);
  assert.equal(chroma.validate({ op: "get" }).issues[0].path, "collection");
});

test("chroma: large integers warn for the JS client but stay exact in Python", () => {
  const r = chroma.compile({ op: "add", collection: "c", ids: ["a"], documents: ["d"], metadatas: [{ n: 9007199254740993n }] }, C);
  assert.ok(snippet(r, "Python").includes('"n": 9007199254740993'));
  assert.ok(r.issues.some((i) => i.severity === "warning" && i.path.startsWith("metadatas")));
});

test("chroma: strings with quotes, backslashes, newlines and unicode round-trip into both languages", () => {
  const doc = 'q"uote \\ back\nnew é 日本 😀';
  const r = chroma.compile({ op: "add", collection: "c", ids: ["a"], documents: [doc] }, C);
  assert.ok(snippet(r, "Python").includes('documents=["q\\"uote \\\\ back\\nnew é 日本 😀"]'));
  assert.ok(snippet(r, "JavaScript").includes('documents: ["q\\"uote \\\\ back\\nnew é 日本 😀"]'));
});

test("chroma: explain describes the steps in plain English", () => {
  assert.deepEqual(chroma.explain({ op: "query", collection: "c", query_texts: ["q"], n_results: 3, where: { $and: [{ a: 1 }, { b: { $gt: 2 } }] }, where_document: { $contains: "x" } }), [
    "Connect with a PersistentClient.",
    'Open the collection "c".',
    "Embed 1 query text.",
    'For each query, return the 3 nearest records, only among records where (metadata "a" equals 1) AND (metadata "b" is greater than 2) AND the document contains the text "x".',
    "Results come back grouped per query: documents, metadatas, distances (ids always).",
  ]);
});

test("chroma: every gallery example compiles without errors", () => {
  for (const ex of chroma.CHROMA_EXAMPLES) {
    const r = chroma.compile(ex.spec, C);
    assert.equal(r.ok, true, `${ex.id}: ${JSON.stringify(errors(r.issues))}`);
  }
  assert.ok(chroma.CHROMA_EXAMPLES.length >= 12);
});

test("chroma: upsert/update render the same list arguments as add", () => {
  const up = chroma.compile({ op: "upsert", collection: "c", ids: ["a"], embeddings: [[0.1, 0.2]], documents: ["x"] }, C);
  assert.ok(snippet(up, "Python").includes('collection.upsert(ids=["a"], documents=["x"], embeddings=[[0.1, 0.2]])') || snippet(up, "Python").includes('collection.upsert(ids=["a"], embeddings=[[0.1, 0.2]], documents=["x"])'));
  const upd = chroma.compile({ op: "update", collection: "c", ids: ["a"], metadatas: [{ k: 1 }] }, C);
  assert.ok(snippet(upd, "JavaScript").includes('await collection.update({ ids: ["a"], metadatas: [{ k: 1 }] });'));
});

test("chroma: query_embeddings become queryEmbeddings in JS", () => {
  const r = chroma.compile({ op: "query", collection: "c", query_embeddings: [[1, 2, 3]], n_results: 2 }, C);
  assert.ok(snippet(r, "Python").includes("collection.query(query_embeddings=[[1, 2, 3]], n_results=2)"));
  assert.ok(snippet(r, "JavaScript").includes("await collection.query({ queryEmbeddings: [[1, 2, 3]], nResults: 2 });"));
});

test("chroma: array-metadata $contains filters compile and explain", () => {
  const spec = { op: "get", collection: "movies", where: { $and: [{ genres: { $contains: "action" } }, { year: { $gte: 2021 } }] } };
  const r = chroma.compile(spec, C);
  assert.ok(snippet(r, "Python").includes('collection.get(where={"$and": [{"genres": {"$contains": "action"}}, {"year": {"$gte": 2021}}]})'));
  assert.deepEqual(chroma.explain(spec).slice(2), ['Fetch records where (metadata "genres" contains "action") AND (metadata "year" is at least 2021) (no similarity ranking).']);
});

test("chroma: explain for add and create", () => {
  assert.deepEqual(chroma.explain({ op: "add", collection: "c", ids: ["a", "b"], documents: ["x", "y"], metadatas: [{ k: 1 }, { k: 2 }] }), [
    "Connect with a PersistentClient.",
    'Open the collection "c".',
    'Add 2 records (ids: ["a", "b"]).',
    "Embed the documents with the collection's embedding function.",
    "Attach the metadata to each record.",
  ]);
  assert.match(chroma.explain({ op: "create_collection", collection: "abc", configuration: { hnsw: { space: "ip" } } })[2], /"ip" distance/);
});

test("chroma: empty metadata warns, null entries are tolerated, strings are not coerced", () => {
  const empty = chroma.validate({ op: "add", collection: "c", ids: ["a"], documents: ["x"], metadatas: [{}] });
  assert.ok(find(empty.issues, "warning", "metadatas[0]"));
  assert.equal(chroma.validate({ op: "add", collection: "c", ids: ["a", "b"], documents: ["x", "y"], metadatas: [null, { k: 1 }] }).ok, true);
  assert.ok(find(chroma.validate({ op: "add", collection: "c", ids: ["a"], documents: [5] }).issues, "error", "documents[0]"));
});

test("chroma: where_document and include render in get", () => {
  const r = chroma.compile({ op: "get", collection: "c", where_document: { $contains: "sleep" }, include: ["documents"] }, C);
  assert.ok(snippet(r, "Python").includes('collection.get(where_document={"$contains": "sleep"}, include=["documents"])'));
  assert.ok(snippet(r, "JavaScript").includes('whereDocument: { $contains: "sleep" }, include: ["documents"]'));
});

/* ===================================================================== Redis */

test("redis: SET with EX in all three clients", () => {
  const r = redis.compile({ ops: [{ command: "SET", args: ["user:1", "Ada Lovelace", "EX", 60] }] }, C);
  assert.equal(r.ok, true);
  assert.equal(snippet(r, "redis-cli"), 'SET user:1 "Ada Lovelace" EX 60\n');
  assert.equal(snippet(r, "redis-py"), 'import redis\n\nr = redis.Redis(host="localhost", port=6379, db=0, decode_responses=True)\n\nprint(r.set("user:1", "Ada Lovelace", ex=60))\n');
  assert.equal(snippet(r, "node-redis"), 'import { createClient } from "redis";\n\nconst client = createClient({ url: "redis://localhost:6379" });\nclient.on("error", (error) => console.error("Redis error", error));\ntry {\n  await client.connect();\n  console.log(await client.set("user:1", "Ada Lovelace", { EX: 60 }));\n} finally {\n  await client.quit();\n}\n');
});

test("redis: lowercase options are canonicalised", () => {
  const r = redis.compile({ ops: [{ command: "set", args: ["k", "v", "ex", "10", "nx"] }] }, C);
  assert.equal(snippet(r, "redis-cli"), "SET k v EX 10 NX\n");
  assert.ok(snippet(r, "redis-py").includes('r.set("k", "v", ex=10, nx=True)'));
  assert.ok(snippet(r, "node-redis").includes('client.set("k", "v", { EX: 10, NX: true })'));
});

test("redis: hashes and sorted sets map to client-library idioms", () => {
  const r = redis.compile({ ops: [{ command: "HSET", args: ["u", "name", "Ada", "age", 36] }, { command: "ZADD", args: ["z", 1, "a", 2.5, "b"] }, { command: "ZRANGE", args: ["z", 0, -1, "WITHSCORES"] }] }, C);
  const py = snippet(r, "redis-py");
  assert.ok(py.includes('print(r.hset("u", mapping={"name": "Ada", "age": 36}))'));
  assert.ok(py.includes('print(r.zadd("z", {"a": 1, "b": 2.5}))'));
  assert.ok(py.includes('print(r.zrange("z", 0, -1, withscores=True))'));
  const node = snippet(r, "node-redis");
  assert.ok(node.includes('client.hSet("u", { "name": "Ada", "age": "36" })'));
  assert.ok(node.includes('client.zAdd("z", [{ score: 1, value: "a" }, { score: 2.5, value: "b" }])'));
  assert.ok(node.includes('client.sendCommand(["ZRANGE", "z", "0", "-1", "WITHSCORES"])'));
});

test("redis: commands without a friendly wrapper use execute_command / sendCommand", () => {
  const r = redis.compile({ ops: [{ command: "SCAN", args: [0, "MATCH", "user:*", "COUNT", 100] }] }, C);
  assert.ok(snippet(r, "redis-py").includes('r.execute_command("SCAN", 0, "MATCH", "user:*", "COUNT", 100)'));
  assert.ok(snippet(r, "node-redis").includes('client.sendCommand(["SCAN", "0", "MATCH", "user:*", "COUNT", "100"])'));
  const sub = redis.compile({ ops: [{ command: "CLIENT", args: ["SETNAME", "worker"] }] }, C);
  assert.equal(snippet(sub, "redis-cli"), "CLIENT SETNAME worker\n");
  assert.ok(snippet(sub, "redis-py").includes('r.execute_command("CLIENT", "SETNAME", "worker")'));
});

test("redis: transaction and pipeline modes", () => {
  const tx = redis.compile({ mode: "transaction", ops: [{ command: "DECRBY", args: ["a", 5] }, { command: "INCRBY", args: ["b", 5] }] }, C);
  assert.equal(snippet(tx, "redis-cli"), "MULTI\nDECRBY a 5\nINCRBY b 5\nEXEC\n");
  assert.ok(snippet(tx, "redis-py").includes("pipe = r.pipeline(transaction=True)\npipe.decrby(\"a\", 5)\npipe.incrby(\"b\", 5)\nprint(pipe.execute())"));
  assert.ok(snippet(tx, "node-redis").includes('.multi()\n    .addCommand(["DECRBY", "a", "5"])\n    .addCommand(["INCRBY", "b", "5"])\n    .exec();'));
  const pl = redis.compile({ mode: "pipeline", ops: [{ command: "GET", args: ["a"] }] }, C);
  assert.ok(snippet(pl, "redis-py").includes("r.pipeline(transaction=False)"));
  assert.ok(snippet(pl, "node-redis").includes(".execAsPipeline();"));
});

test("redis: connection settings (db, tls, host)", () => {
  const r = redis.compile({ connection: { host: "cache.internal", port: 6380, db: 3, tls: true }, ops: [{ command: "PING" }] }, C);
  assert.equal(snippet(r, "redis-cli"), "SELECT 3\nPING\n");
  assert.ok(snippet(r, "redis-py").includes('redis.Redis(host="cache.internal", port=6380, db=3, ssl=True, decode_responses=True)'));
  assert.ok(snippet(r, "node-redis").includes('createClient({ url: "rediss://cache.internal:6380/3" })'));
});

test("redis: redis-cli quoting for spaces, quotes, newlines and unicode", () => {
  const r = redis.compile({ ops: [{ command: "SET", args: ["k", 'a "b" \\ c\nd'] }, { command: "SET", args: ["k2", "żółć"] }, { command: "SET", args: ["k3", ""] }] }, C);
  assert.equal(snippet(r, "redis-cli"), 'SET k "a \\"b\\" \\\\ c\\nd"\nSET k2 "\\xc5\\xbc\\xc3\\xb3\\xc5\\x82\\xc4\\x87"\nSET k3 ""\n');
});

test("redis: splitCommandLine matches sdssplitargs", () => {
  assert.deepEqual(redis.splitCommandLine('SET k "a b" \'c d\''), ["SET", "k", "a b", "c d"]);
  assert.deepEqual(redis.splitCommandLine('SET k "x\\ny\\x41"'), ["SET", "k", "x\ny" + "A"]);
  assert.equal(redis.splitCommandLine('SET k "unterminated'), null);
  assert.equal(redis.splitCommandLine('SET "a"b c'), null);
  assert.deepEqual(redis.splitCommandLine("  "), []);
});

test("redis: lines and bare arrays are accepted as input", () => {
  assert.equal(redis.compile(["SET a 1", "GET a"], C).ok, true);
  const parsed = redis.parseCommandLines('# comment\nSET a "x y"\n\nGET a\n');
  assert.deepEqual(parsed.spec.ops, [{ command: "SET", args: ["a", "x y"] }, { command: "GET", args: ["a"] }]);
  assert.equal(redis.parseCommandLines('SET a "x').spec, undefined);
});

test("redis: arity errors state how many arguments are needed", () => {
  const few = redis.validate({ ops: [{ command: "SET", args: ["k"] }] });
  assert.match(find(few.issues, "error", "ops[0].args").message, /needs at least 2 arguments, got 1/);
  const exact = redis.validate({ ops: [{ command: "GET", args: ["a", "b"] }] });
  assert.match(find(exact.issues, "error", "ops[0].args").message, /exactly 1 argument, got 2/);
});

test("redis: unknown command / sub-command suggestions", () => {
  assert.match(find(redis.validate({ ops: [{ command: "STE", args: ["a", "b"] }] }).issues, "error", "ops[0].command").message, /Did you mean SET\?/);
  assert.match(find(redis.validate({ ops: [{ command: "HGETALLL", args: ["a"] }] }).issues, "error", "ops[0].command").message, /Did you mean HGETALL\?/);
  assert.match(find(redis.validate({ ops: [{ command: "CLIENT", args: ["SETNMAE", "x"] }] }).issues, "error", "ops[0].args[0]").message, /Did you mean SETNAME\?/);
});

test("redis: option spelling and value types are checked against the grammar", () => {
  assert.match(find(redis.validate({ ops: [{ command: "SET", args: ["k", "v", "EXX", "5"] }] }).issues, "error", "ops[0].args[2]").message, /Unexpected argument "EXX"/);
  assert.match(find(redis.validate({ ops: [{ command: "EXPIRE", args: ["k", "abc"] }] }).issues, "error", "ops[0].args[1]").message, /not a valid integer for seconds/);
  assert.match(find(redis.validate({ ops: [{ command: "ZADD", args: ["z", "x", "m"] }] }).issues, "error", "ops[0].args[1]").message, /not a valid number for score/);
  assert.match(find(redis.validate({ ops: [{ command: "SET", args: ["k", "v", "EX"] }] }).issues, "error", "ops[0].args[2]").message, /EX needs a value/);
  assert.equal(redis.validate({ ops: [{ command: "BLPOP", args: ["a", "b", "0"] }] }).ok, true);
  assert.equal(redis.validate({ ops: [{ command: "SORT", args: ["l", "BY", "w_*", "LIMIT", "0", "5", "DESC", "ALPHA"] }] }).ok, true);
  assert.equal(redis.validate({ ops: [{ command: "SET", args: ["k", "v", "EX", "5", "NX", "GET"] }] }).ok, true);
  assert.ok(find(redis.validate({ ops: [{ command: "ZUNIONSTORE", args: ["out", "3", "a", "b"] }] }).issues, "error", "ops[0].args[1]"));
});

test("redis: arguments must be strings or numbers", () => {
  assert.ok(find(redis.validate({ ops: [{ command: "SET", args: ["k", true] }] }).issues, "error", "ops[0].args[1]"));
  assert.ok(find(redis.validate({ ops: [{ command: "SET", args: ["k", { a: 1 }] }] }).issues, "error", "ops[0].args[1]"));
  assert.ok(find(redis.validate({ ops: [{ command: "SET", args: ["k", null] }] }).issues, "error", "ops[0].args[1]"));
});

test("redis: pitfalls (KEYS, FLUSHALL, SMEMBERS, deprecated, LRANGE 0 -1)", () => {
  assert.ok(find(redis.validate({ ops: [{ command: "KEYS", args: ["*"] }] }).issues, "warning", "ops[0].command"));
  assert.ok(find(redis.validate({ ops: [{ command: "KEYS", args: ["*"] }] }).issues, "warning", "ops[0].args[0]"));
  assert.match(find(redis.validate({ ops: [{ command: "FLUSHALL" }] }).issues, "warning", "ops[0].command").message, /EVERY database/);
  assert.ok(find(redis.validate({ ops: [{ command: "SMEMBERS", args: ["s"] }] }).issues, "warning", "ops[0].command"));
  assert.match(find(redis.validate({ ops: [{ command: "GETSET", args: ["k", "v"] }] }).issues, "warning", "ops[0].command").message, /deprecated/);
  assert.ok(find(redis.validate({ ops: [{ command: "LRANGE", args: ["l", 0, -1] }] }).issues, "warning", "ops[0].args"));
});

test("redis: blocking commands in pipelines and subscribe in transactions", () => {
  assert.ok(find(redis.validate({ mode: "pipeline", ops: [{ command: "BLPOP", args: ["l", 0] }] }).issues, "warning", "ops[0].command"));
  assert.ok(find(redis.validate({ mode: "transaction", ops: [{ command: "SUBSCRIBE", args: ["ch"] }] }).issues, "error", "ops[0].command"));
});

test("redis: hand-written MULTI/EXEC is rejected in favour of mode", () => {
  const r = redis.validate({ ops: [{ command: "MULTI" }, { command: "SET", args: ["a", 1] }, { command: "EXEC" }] });
  assert.equal(r.ok, false);
  assert.match(find(r.issues, "error", "ops[0].command").fix, /transaction/);
});

test("redis: explain lists summary and complexity", () => {
  const lines = redis.explain({ mode: "transaction", ops: [{ command: "KEYS", args: ["user:*"] }] });
  assert.match(lines[0], /MULTI\/EXEC/);
  assert.match(lines[1], /^1\. KEYS user:\*: Returns all key names that match a pattern\. Complexity: O\(N\)/);
  assert.match(lines[2], /Warning: KEYS walks every key/);
});

test("redis: syntax strings come from the official table", () => {
  const set = redis.REDIS_COMMANDS.find((c) => c.name === "SET");
  assert.match(redis.syntaxOf(set), /^SET key value \[NX \| XX/);
  assert.equal(set.arity, -3);
  assert.equal(redis.REDIS_COMMANDS.find((c) => c.name === "GET").complexity, "O(1)");
  assert.equal(redis.syntaxOf(redis.REDIS_COMMANDS.find((c) => c.name === "EXPIRE")), "EXPIRE key seconds [NX | XX | GT | LT]");
});

test("redis: table covers every core data-structure group with 80+ commands", () => {
  const groups = new Set(redis.REDIS_COMMANDS.map((c) => c.group));
  for (const g of ["string", "hash", "list", "set", "sorted-set", "stream", "generic", "pubsub", "transactions"]) assert.ok(groups.has(g), g);
  assert.ok(redis.REDIS_COMMANDS.length >= 300);
  for (const name of ["SET", "GET", "HSET", "LPUSH", "SADD", "ZADD", "XADD", "EXPIRE", "PUBLISH", "MULTI", "KEYS", "FLUSHALL", "BLPOP", "SCAN"]) assert.ok(redis.REDIS_COMMANDS.some((c) => c.name === name), name);
  for (const c of redis.REDIS_COMMANDS) assert.ok(typeof c.arity === "number" && c.summary, c.name);
});

test("redis: every gallery example compiles without errors", () => {
  for (const ex of redis.REDIS_EXAMPLES) {
    const r = redis.compile(ex.spec, C);
    assert.equal(r.ok, true, `${ex.id}: ${JSON.stringify(errors(r.issues))}`);
    assert.equal(r.snippets.length, 3);
  }
  assert.ok(redis.REDIS_EXAMPLES.length >= 12);
});

test("redis: XADD maps to a field dictionary in redis-py", () => {
  const r = redis.compile({ ops: [{ command: "XADD", args: ["events", "*", "type", "login", "user", "ada"] }] });
  assert.ok(snippet(r, "redis-py").includes('r.xadd("events", {"type": "login", "user": "ada"})'));
  assert.ok(snippet(r, "node-redis").includes('client.sendCommand(["XADD", "events", "*", "type", "login", "user", "ada"])'));
});

test("redis: MSET/MGET/LPUSH/LPOP friendly forms and duplicate-field fallback", () => {
  const r = redis.compile({ ops: [{ command: "MSET", args: ["a", 1, "b", 2] }, { command: "MGET", args: ["a", "b"] }, { command: "LPUSH", args: ["l", "x", "y"] }, { command: "LPOP", args: ["l", 2] }] });
  const py = snippet(r, "redis-py");
  assert.ok(py.includes('r.mset({"a": 1, "b": 2})') && py.includes('r.mget(["a", "b"])') && py.includes('r.lpush("l", "x", "y")') && py.includes('r.lpop("l", 2)'));
  const dup = redis.compile({ ops: [{ command: "HSET", args: ["h", "f", "1", "f", "2"] }] });
  assert.ok(snippet(dup, "redis-py").includes('r.execute_command("HSET", "h", "f", "1", "f", "2")'));
});

test("redis: options a friendly wrapper cannot express fall back to the generic call", () => {
  const r = redis.compile({ ops: [{ command: "EXPIRE", args: ["k", 60, "NX"] }] });
  assert.equal(snippet(r, "redis-cli"), "EXPIRE k 60 NX\n");
  assert.ok(snippet(r, "redis-py").includes('r.execute_command("EXPIRE", "k", 60, "NX")'));
  assert.ok(snippet(r, "node-redis").includes('client.sendCommand(["EXPIRE", "k", "60", "NX"])'));
});

test("redis: SUBSCRIBE gets dedicated pub/sub code", () => {
  const r = redis.compile({ ops: [{ command: "SUBSCRIBE", args: ["a", "b"] }] });
  assert.ok(snippet(r, "redis-py").includes('pubsub.subscribe("a", "b")'));
  assert.ok(snippet(r, "node-redis").includes('await subscriber.subscribe(["a", "b"], (message, channel) => console.log(channel, message));'));
});

test("redis: SELECT conflicts with connection.db, CONFIG needs a sub-command", () => {
  assert.ok(find(redis.validate({ connection: { db: 2 }, ops: [{ command: "SELECT", args: [1] }] }).issues, "warning", "ops[0].command"));
  assert.match(find(redis.validate({ ops: [{ command: "CONFIG" }] }).issues, "error", "ops[0].command").message, /needs a sub-command/);
});

test("redis: float arguments are kept as numbers (INCRBYFLOAT) and big numbers stay strings in the CLI", () => {
  const r = redis.compile({ ops: [{ command: "INCRBYFLOAT", args: ["price", 1.5] }] });
  assert.ok(snippet(r, "redis-py").includes('r.incrbyfloat("price", 1.5)'));
  assert.equal(snippet(r, "redis-cli"), "INCRBYFLOAT price 1.5\n");
});

test("redis: deprecated commands name their replacement in the table", () => {
  const getset = redis.REDIS_COMMANDS.find((c) => c.name === "GETSET");
  assert.ok(getset.deprecated);
  assert.match(getset.replacedBy, /SET/);
});

test("redis: structural errors name the field", () => {
  assert.equal(redis.validate({ ops: [] }).issues[0].path, "ops");
  assert.equal(redis.validate({ ops: [{ commnd: "GET" }] }).issues.some((i) => i.path === "ops[0].commnd" || i.path === "ops[0].command"), true);
  assert.equal(redis.validate({ mode: "burst", ops: [{ command: "PING" }] }).issues[0].path, "mode");
  assert.equal(redis.validate("nope").ok, false);
});
