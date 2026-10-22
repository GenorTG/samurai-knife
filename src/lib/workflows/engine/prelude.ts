/**
 * JavaScript run inside the sandbox before expressions and Code nodes (docs/WORKFLOWS.md "Model"): the `$…` helpers over
 * the injected `__data`, and `DateTime`, a small Luxon-shaped date type so the usual n8n habits (`$now.toFormat(…)`,
 * `.minus({ days: 1 })`, `.toISO()`) work. Time zone: one fixed offset (`__data.meta.tzOffset`, minutes, the workflow
 * zone's offset at the run's start), so a date across a DST change is off by the change.
 */
export const SANDBOX_PRELUDE = String.raw`
(() => {
  const D = globalThis.__data;
  const OFFSET = (D.meta && D.meta.tzOffset) || 0;
  const UNITS = { years: "y", year: "y", months: "M", month: "M", weeks: "w", week: "w", days: "d", day: "d",
    hours: "h", hour: "h", minutes: "m", minute: "m", seconds: "s", second: "s", milliseconds: "ms", millisecond: "ms" };
  const pad = (n, w = 2) => String(Math.abs(Math.trunc(n))).padStart(w, "0");
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  class DateTime {
    constructor(ms) { this.ts = ms; this.isValid = Number.isFinite(ms); }
    static now() { return new DateTime(D.meta.now); }
    static fromMillis(ms) { return new DateTime(Number(ms)); }
    static fromSeconds(s) { return new DateTime(Number(s) * 1000); }
    static fromJSDate(d) { return new DateTime(d.getTime()); }
    static fromISO(text) {
      const s = String(text);
      const local = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(s);
      const ms = Date.parse(local && s.length === 10 ? s + "T00:00:00Z" : local ? s + "Z" : s);
      return new DateTime(local ? ms - OFFSET * 60000 : ms);
    }
    static fromFormat(text) { return DateTime.fromISO(text); }
    get _l() { return new Date(this.ts + OFFSET * 60000); }
    get year() { return this._l.getUTCFullYear(); }
    get month() { return this._l.getUTCMonth() + 1; }
    get day() { return this._l.getUTCDate(); }
    get hour() { return this._l.getUTCHours(); }
    get minute() { return this._l.getUTCMinutes(); }
    get second() { return this._l.getUTCSeconds(); }
    get millisecond() { return this._l.getUTCMilliseconds(); }
    get weekday() { return this._l.getUTCDay() || 7; }
    get monthLong() { return MONTHS[this.month - 1]; }
    get weekdayLong() { return DAYS[this._l.getUTCDay()]; }
    get offset() { return OFFSET; }
    toMillis() { return this.ts; }
    toSeconds() { return this.ts / 1000; }
    valueOf() { return this.ts; }
    toJSDate() { return new Date(this.ts); }
    toISO() {
      if (!this.isValid) return null;
      const l = this._l, o = OFFSET;
      const zone = o === 0 ? "Z" : (o > 0 ? "+" : "-") + pad(Math.floor(Math.abs(o) / 60)) + ":" + pad(Math.abs(o) % 60);
      return l.toISOString().slice(0, 23) + zone;
    }
    toISODate() { return this.isValid ? this._l.toISOString().slice(0, 10) : null; }
    toString() { return this.toISO(); }
    toJSON() { return this.toISO(); }
    toFormat(fmt) {
      const l = this._l;
      const map = {
        yyyy: l.getUTCFullYear(), yy: pad(l.getUTCFullYear() % 100), MMMM: MONTHS[l.getUTCMonth()], MMM: MONTHS[l.getUTCMonth()].slice(0, 3),
        MM: pad(l.getUTCMonth() + 1), M: l.getUTCMonth() + 1, dd: pad(l.getUTCDate()), d: l.getUTCDate(),
        EEEE: DAYS[l.getUTCDay()], EEE: DAYS[l.getUTCDay()].slice(0, 3), HH: pad(l.getUTCHours()), H: l.getUTCHours(),
        hh: pad(l.getUTCHours() % 12 || 12), h: l.getUTCHours() % 12 || 12, mm: pad(l.getUTCMinutes()), m: l.getUTCMinutes(),
        ss: pad(l.getUTCSeconds()), s: l.getUTCSeconds(), SSS: pad(l.getUTCMilliseconds(), 3), a: l.getUTCHours() < 12 ? "AM" : "PM",
      };
      return String(fmt).replace(/'([^']*)'|yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|H|hh|h|mm|m|ss|s|SSS|a/g, (t, lit) => lit !== undefined ? lit : String(map[t]));
    }
    _shift(obj, sign) {
      const l = this._l;
      for (const [k, v] of Object.entries(obj || {})) {
        const n = Number(v) * sign, u = UNITS[k];
        if (u === "y") l.setUTCFullYear(l.getUTCFullYear() + n);
        else if (u === "M") l.setUTCMonth(l.getUTCMonth() + n);
        else if (u === "w") l.setUTCDate(l.getUTCDate() + 7 * n);
        else if (u === "d") l.setUTCDate(l.getUTCDate() + n);
        else if (u === "h") l.setTime(l.getTime() + n * 3600000);
        else if (u === "m") l.setTime(l.getTime() + n * 60000);
        else if (u === "s") l.setTime(l.getTime() + n * 1000);
        else if (u === "ms") l.setTime(l.getTime() + n);
      }
      return new DateTime(l.getTime() - OFFSET * 60000);
    }
    plus(obj) { return this._shift(typeof obj === "number" ? { milliseconds: obj } : obj, 1); }
    minus(obj) { return this._shift(typeof obj === "number" ? { milliseconds: obj } : obj, -1); }
    startOf(unit) {
      const l = this._l, u = UNITS[unit] || UNITS[unit + "s"];
      if (u === "y") { l.setUTCMonth(0, 1); }
      if (u === "y" || u === "M") l.setUTCDate(1);
      if (u === "w") l.setUTCDate(l.getUTCDate() - ((l.getUTCDay() || 7) - 1));
      if (["y", "M", "w", "d"].includes(u)) l.setUTCHours(0, 0, 0, 0);
      if (u === "h") l.setUTCMinutes(0, 0, 0);
      if (u === "m") l.setUTCSeconds(0, 0);
      if (u === "s") l.setUTCMilliseconds(0);
      return new DateTime(l.getTime() - OFFSET * 60000);
    }
    endOf(unit) { const u = UNITS[unit] || UNITS[unit + "s"]; const key = { y: "years", M: "months", w: "weeks", d: "days", h: "hours", m: "minutes", s: "seconds" }[u]; return this.startOf(unit).plus({ [key]: 1 }).minus({ milliseconds: 1 }); }
    set(obj) {
      const l = this._l;
      if (obj.year !== undefined) l.setUTCFullYear(obj.year);
      if (obj.month !== undefined) l.setUTCMonth(obj.month - 1);
      if (obj.day !== undefined) l.setUTCDate(obj.day);
      if (obj.hour !== undefined) l.setUTCHours(obj.hour);
      if (obj.minute !== undefined) l.setUTCMinutes(obj.minute);
      if (obj.second !== undefined) l.setUTCSeconds(obj.second);
      return new DateTime(l.getTime() - OFFSET * 60000);
    }
    diff(other, unit = "milliseconds") {
      const ms = this.ts - (other instanceof DateTime ? other.ts : Number(other));
      const div = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[UNITS[unit] || "ms"] || 1;
      const value = ms / div;
      return { [unit]: value, as: () => value, toMillis: () => ms };
    }
    equals(other) { return other instanceof DateTime && other.ts === this.ts; }
    hasSame(other, unit) { return this.startOf(unit).ts === other.startOf(unit).ts; }
    setZone() { return this; }
    toLocal() { return this; }
    toUTC() { return this; }
  }
  globalThis.DateTime = DateTime;
  const items = D.items || [];
  const nodes = D.nodes || {};
  const pick = (list, i) => list[Math.min(i, list.length - 1)];
  const nodeView = (name, i) => {
    const out = nodes[name];
    if (!out) throw new Error("Node '" + name + "' has not run in this execution (or its output was not passed in).");
    const list = out.items;
    return {
      all: () => list, first: () => list[0], last: () => list[list.length - 1],
      get item() { return pick(list, i); }, itemMatching: (k) => pick(list, k), isExecuted: true,
      get json() { const it = pick(list, i); return it ? it.json : undefined; },
      get binary() { const it = pick(list, i); return it ? it.binary : undefined; },
      params: out.params || {},
    };
  };
  globalThis.__scope = (i) => {
    const item = items[i] || { json: {} };
    return {
      $json: item.json, $binary: item.binary || {}, $itemIndex: i, $runIndex: D.meta.runIndex || 0,
      $input: { all: () => items, first: () => items[0], last: () => items[items.length - 1], item, params: D.meta.params || {} },
      $: (name) => nodeView(name, i),
      $node: new Proxy({}, { get: (_, name) => nodeView(String(name), i) }),
      $items: (name) => (name === undefined ? items : nodeView(name, i).all()),
      $now: DateTime.now(), $today: DateTime.now().startOf("day"),
      $workflow: D.meta.workflow, $execution: D.meta.execution, $vars: D.meta.vars || {}, $prevNode: D.meta.prevNode || {},
      $if: (c, a, b) => (c ? a : b), $ifEmpty: (v, d) => (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && v && !Object.keys(v).length) ? d : v),
      $min: Math.min, $max: Math.max,
    };
  };
})();
`;
