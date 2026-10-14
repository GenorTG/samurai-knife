// Recording helpers shared by the JavaScript client stubs. Calls are tagged to JSON and printed at exit.
const CALLS = [];

function tag(v) {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return { $long: v.toString() };
  if (typeof v === "number") {
    if (Number.isNaN(v)) return { $double: "NaN" };
    if (v === Infinity) return { $double: "Infinity" };
    if (v === -Infinity) return { $double: "-Infinity" };
    return v;
  }
  if (v === undefined) return { $undefined: true };
  const kind = Object.prototype.toString.call(v); // vm contexts have their own Date/RegExp: instanceof would miss them
  if (kind === "[object Date]") return { $date: v.getTime() };
  if (kind === "[object RegExp]") return { $regex: [v.source.replace(/\\\//g, "/"), [...v.flags].sort().join("")] };
  if (typeof v._tag === "function") return v._tag();
  if (Array.isArray(v)) return v.map(tag);
  if (typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tag(x)]));
  throw new TypeError(`cannot tag ${typeof v}`);
}

process.on("exit", () => process.stdout.write(`@@CALLS@@${JSON.stringify(CALLS)}\n`));
module.exports = { CALLS, rec: (entry) => CALLS.push(entry), tag };
