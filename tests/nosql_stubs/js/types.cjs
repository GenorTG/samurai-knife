// Stand-ins for the BSON classes the Node driver re-exports; each knows how to tag itself.
class ObjectId { constructor(hex) { if (typeof hex !== "string" || hex.length !== 24) throw new Error("bad ObjectId " + hex); this.hex = hex; } _tag() { return { $oid: this.hex }; } }
class Long { constructor(s) { this.s = s; } static fromString(s) { if (typeof s !== "string") throw new Error("Long.fromString needs a string"); return new Long(s); } _tag() { return { $long: this.s }; } }
class Decimal128 { constructor(s) { this.s = s; } static fromString(s) { return new Decimal128(s); } _tag() { return { $decimal: this.s }; } }
class Int32 { constructor(n) { this.n = n; } _tag() { return this.n; } }
class Double { constructor(n) { this.n = n; } _tag() { return this.n; } }
class Timestamp { constructor({ t, i }) { this.t = t; this.i = i; } _tag() { return { $ts: [this.t, this.i] }; } }
class Binary { constructor(b64, sub) { this.b64 = b64; this.sub = sub; } static createFromBase64(b64, sub) { return new Binary(Buffer.from(b64, "base64").toString("base64"), sub); } _tag() { return { $bin: [this.b64, this.sub] }; } }
class UUID { constructor(s) { this.s = String(s).toLowerCase(); } _tag() { return { $uuid: this.s }; } }
class MinKey { _tag() { return { $minKey: 1 }; } }
class MaxKey { _tag() { return { $maxKey: 1 }; } }
class BSONRegExp { constructor(p, o = "") { this.p = p; this.o = [...o].sort().join(""); } _tag() { return { $regex: [this.p, this.o] }; } }
module.exports = { ObjectId, Long, Decimal128, Int32, Double, Timestamp, Binary, UUID, MinKey, MaxKey, BSONRegExp };
