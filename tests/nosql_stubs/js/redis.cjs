/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS stub that a test copies into a throwaway node_modules */
const { rec } = require("__rec");

const s = (x) => {
  if (typeof x !== "string" && typeof x !== "number") throw new Error("node-redis argument must be string or number, got " + typeof x);
  return String(x);
};
const list = (v) => (Array.isArray(v) ? v : [v]);

class Commands {
  sendCommand(args) { return this._emit(args.map(s)); }
  set(key, value, opts = {}) {
    const t = ["SET", key, value];
    for (const [k, v] of Object.entries(opts)) { t.push(k); if (v !== true) t.push(v); }
    return this._emit(t.map(s));
  }
  get(k) { return this._emit(["GET", k].map(s)); }
  del(k) { return this._emit(["DEL", ...list(k)].map(s)); }
  exists(k) { return this._emit(["EXISTS", ...list(k)].map(s)); }
  expire(k, n) { return this._emit(["EXPIRE", k, n].map(s)); }
  ttl(k) { return this._emit(["TTL", k].map(s)); }
  incr(k) { return this._emit(["INCR", k].map(s)); }
  decr(k) { return this._emit(["DECR", k].map(s)); }
  incrBy(k, n) { return this._emit(["INCRBY", k, n].map(s)); }
  hSet(k, a, b) {
    const t = ["HSET", k];
    if (typeof a === "object") for (const [f, v] of Object.entries(a)) t.push(f, v); else t.push(a, b);
    return this._emit(t.map(s));
  }
  hGet(k, f) { return this._emit(["HGET", k, f].map(s)); }
  hGetAll(k) { return this._emit(["HGETALL", k].map(s)); }
  hDel(k, f) { return this._emit(["HDEL", k, ...list(f)].map(s)); }
  lPush(k, v) { return this._emit(["LPUSH", k, ...list(v)].map(s)); }
  rPush(k, v) { return this._emit(["RPUSH", k, ...list(v)].map(s)); }
  lRange(k, a, b) { return this._emit(["LRANGE", k, a, b].map(s)); }
  lLen(k) { return this._emit(["LLEN", k].map(s)); }
  sAdd(k, m) { return this._emit(["SADD", k, ...list(m)].map(s)); }
  sRem(k, m) { return this._emit(["SREM", k, ...list(m)].map(s)); }
  sMembers(k) { return this._emit(["SMEMBERS", k].map(s)); }
  sCard(k) { return this._emit(["SCARD", k].map(s)); }
  sIsMember(k, m) { return this._emit(["SISMEMBER", k, m].map(s)); }
  zAdd(k, m) { const t = ["ZADD", k]; for (const e of list(m)) t.push(e.score, e.value); return this._emit(t.map(s)); }
  publish(c, m) { return this._emit(["PUBLISH", c, m].map(s)); }
  keys(p) { return this._emit(["KEYS", p].map(s)); }
}

class Client extends Commands {
  constructor(opts) { super(); this.url = opts?.url; }
  _emit(tokens) { rec({ kind: "cmd", tokens }); return Promise.resolve(null); }
  on() { return this; }
  async connect() { rec({ kind: "client", url: this.url }); }
  async quit() {}
  duplicate() { return new Client({ url: this.url }); }
  async subscribe(c) { rec({ kind: "cmd", tokens: ["SUBSCRIBE", ...list(c).map(s)] }); }
  async pSubscribe(c) { rec({ kind: "cmd", tokens: ["PSUBSCRIBE", ...list(c).map(s)] }); }
  multi() { return new Multi(); }
}
class Multi {
  constructor() { this.cmds = []; }
  addCommand(args) { this.cmds.push(args.map(s)); return this; }
  async exec() { rec({ kind: "tx", commands: this.cmds }); return []; }
  async execAsPipeline() { rec({ kind: "pipeline", commands: this.cmds }); return []; }
}
exports.createClient = (opts) => new Client(opts);
