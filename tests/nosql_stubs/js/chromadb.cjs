/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS stub that a test copies into a throwaway node_modules */
const { rec, tag } = require("__rec");

class Collection {
  constructor(name) { this.name = name; }
  _call(method, opts) { rec({ kind: "call", method, collection: this.name, options: tag(opts ?? {}) }); return {}; }
  async add(o) { return this._call("add", o); }
  async upsert(o) { return this._call("upsert", o); }
  async update(o) { return this._call("update", o); }
  async get(o) { return this._call("get", o); }
  async query(o) { return this._call("query", o); }
  async delete(o) { return this._call("delete", o); }
  async count() { this._call("count", {}); return 0; }
}
class ChromaClient {
  constructor(opts) { rec({ kind: "client", type: "ChromaClient", options: tag(opts ?? {}) }); }
  async getCollection(o) { rec({ kind: "call", method: "getCollection", collection: o.name, options: tag({}) }); return new Collection(o.name); }
  async createCollection(o) { const { name, ...rest } = o; rec({ kind: "call", method: "createCollection", collection: name, options: tag(rest) }); return new Collection(name); }
  async getOrCreateCollection(o) { const { name, ...rest } = o; rec({ kind: "call", method: "getOrCreateCollection", collection: name, options: tag(rest) }); return new Collection(name); }
}
class CloudClient extends ChromaClient {
  constructor(opts) { super(); rec({ kind: "client", type: "CloudClient", options: tag({ ...opts, apiKey: opts.apiKey === process.env.CHROMA_API_KEY ? "<from-env>" : "<literal>" }) }); }
}
exports.ChromaClient = ChromaClient;
exports.CloudClient = CloudClient;
