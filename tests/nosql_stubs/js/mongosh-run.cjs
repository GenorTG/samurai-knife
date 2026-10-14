/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS stub that a test copies into a throwaway node_modules */
// Evaluates a generated mongosh snippet with recording stand-ins for `db`, ObjectId(), ISODate(), ...
const fs = require("node:fs");
const vm = require("node:vm");
const { rec, tag } = require("./rec.cjs");
const types = require("./types.cjs");

function collection(dbName, name) {
  const call = (method, args, result) => { const entry = { kind: "call", method, db: dbName, coll: name, args: args.map(tag), chain: {} }; rec(entry); return [entry, result]; };
  const plain = (method, result) => (...a) => call(method, a, result)[1];
  return {
    find: (...a) => {
      const [entry] = call("find", a, null);
      const cursor = {
        sort: (s) => ((entry.chain.sort = tag(s)), cursor),
        skip: (n) => ((entry.chain.skip = n), cursor),
        limit: (n) => ((entry.chain.limit = n), cursor),
        next: () => ((entry.chain.next = true), null),
        toArray: async () => [],
      };
      return cursor;
    },
    findOne: plain("findOne", null),
    aggregate: plain("aggregate", { toArray: async () => [] }),
    insertOne: plain("insertOne", {}),
    insertMany: plain("insertMany", {}),
    updateOne: plain("updateOne", {}),
    updateMany: plain("updateMany", {}),
    replaceOne: plain("replaceOne", {}),
    deleteOne: plain("deleteOne", {}),
    deleteMany: plain("deleteMany", {}),
    countDocuments: plain("countDocuments", 0),
    distinct: plain("distinct", []),
    createIndex: plain("createIndex", "index_name"),
  };
}

function database(name) {
  const base = { getSiblingDB: (n) => database(n), getCollection: (c) => collection(name, c) };
  return new Proxy(base, { get: (target, prop) => (prop in target ? target[prop] : typeof prop === "string" ? collection(name, prop) : undefined) });
}

const sandbox = {
  db: database("test"),
  ObjectId: (hex) => new types.ObjectId(hex),
  ISODate: (s) => new Date(s),
  NumberLong: (s) => new types.Long(String(s)),
  NumberInt: (n) => n,
  NumberDecimal: (s) => new types.Decimal128(s),
  Double: (n) => n,
  Timestamp: (o) => new types.Timestamp(o),
  BinData: (sub, b64) => new types.Binary(b64, sub),
  UUID: (s) => new types.UUID(s),
  MinKey: () => new types.MinKey(),
  MaxKey: () => new types.MaxKey(),
  BSONRegExp: (p, o) => new types.BSONRegExp(p, o),
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(process.argv[2], "utf8"), sandbox, { filename: "mongosh-snippet.js" });
