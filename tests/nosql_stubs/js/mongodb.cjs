/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS stub that a test copies into a throwaway node_modules */
const { rec, tag } = require("__rec");
const types = require("__types");

class Collection {
  constructor(db, name) { this.db = db; this.name = name; }
  _call(method, args, result) { rec({ kind: "call", method, db: this.db, coll: this.name, args: args.map(tag) }); return result; }
  find(...a) { return this._call("find", a, { toArray: async () => [] }); }
  findOne(...a) { return this._call("findOne", a, null); }
  aggregate(...a) { return this._call("aggregate", a, { toArray: async () => [] }); }
  async insertOne(...a) { return this._call("insertOne", a, { insertedId: null }); }
  async insertMany(...a) { return this._call("insertMany", a, { insertedIds: {} }); }
  async updateOne(...a) { return this._call("updateOne", a, { matchedCount: 0, modifiedCount: 0, upsertedId: null }); }
  async updateMany(...a) { return this._call("updateMany", a, { matchedCount: 0, modifiedCount: 0, upsertedId: null }); }
  async replaceOne(...a) { return this._call("replaceOne", a, { matchedCount: 0, modifiedCount: 0 }); }
  async deleteOne(...a) { return this._call("deleteOne", a, { deletedCount: 0 }); }
  async deleteMany(...a) { return this._call("deleteMany", a, { deletedCount: 0 }); }
  async countDocuments(...a) { return this._call("countDocuments", a, 0); }
  async distinct(...a) { return this._call("distinct", a, []); }
  async createIndex(...a) { return this._call("createIndex", a, "index_name"); }
}
class MongoClient {
  constructor(uri) { rec({ kind: "client", uri }); }
  async connect() {}
  async close() {}
  db(name) { return { collection: (coll) => new Collection(name, coll) }; }
}
// explicit assignments: Node's CJS named-export detection cannot see through spreads or loops
exports.MongoClient = MongoClient;
exports.ObjectId = types.ObjectId;
exports.Long = types.Long;
exports.Decimal128 = types.Decimal128;
exports.Int32 = types.Int32;
exports.Double = types.Double;
exports.Timestamp = types.Timestamp;
exports.Binary = types.Binary;
exports.UUID = types.UUID;
exports.MinKey = types.MinKey;
exports.MaxKey = types.MaxKey;
exports.BSONRegExp = types.BSONRegExp;
