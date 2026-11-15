/**
 * Shared low-level helpers for the PocketBase hooks (review D4).
 *
 * One implementation of each: the copies that used to live in every service
 * had drifted apart (Date handling in parsePbDate, JSVM byte arrays in JSON fields).
 * Pure ES5, no PocketBase globals, so Node tests can require it directly.
 */

/** A Date (or anything `new Date` accepts) as PocketBase's "YYYY-MM-DD HH:MM:SS.mmmZ". */
function toPbDate(d) {
  var x = d instanceof Date ? d : new Date(d);
  return x.toISOString().replace("T", " ").replace("Z", "") + "Z";
}

/**
 * Epoch ms from a PocketBase date string, ISO string or Date; NaN when empty.
 * A string without a zone is UTC (that is how PocketBase stores dates).
 */
function parsePbDate(v) {
  if (v == null || v === "") return NaN;
  if (Object.prototype.toString.call(v) === "[object Date]") return v.getTime();
  var s = String(v).trim().replace(" ", "T");
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += "Z";
  return new Date(s).getTime();
}

/**
 * A JSON value as plain JS: JSON text is parsed, already-decoded arrays and
 * objects are deep-copied. Returns `fallback` when empty or unparseable.
 * It never guesses that a numeric array is raw bytes: that guess turned [] and
 * {} into [91,93] / [123,125] and decoded UTF-8 as Latin-1. Read record fields
 * with readJson instead, which gets the stored text losslessly.
 */
function parseJson(val, fallback) {
  if (val == null || val === "") return fallback;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch (_) {
      return fallback;
    }
  }
  try {
    return JSON.parse(JSON.stringify(val));
  } catch (_) {
    return fallback;
  }
}

/**
 * A record's JSON field as plain JS, read at the record boundary.
 * record.getString() returns the stored JSON text exactly (the JSVM can hand
 * json fields back from record.get() as byte arrays). An empty or JSON-null
 * field gives `fallback`. Records without getString, or whose getString is not
 * JSON (test fakes), fall back to parseJson(record.get(key)).
 */
function readJson(rec, key, fallback) {
  if (rec == null) return fallback;
  if (typeof rec.getString === "function") {
    var s = null;
    try {
      s = rec.getString(key);
    } catch (_) {}
    if (typeof s === "string") {
      if (s === "" || s === "null") return fallback;
      try {
        return JSON.parse(s);
      } catch (_) {}
    }
  }
  return parseJson(typeof rec.get === "function" ? rec.get(key) : undefined, fallback);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Deterministic PRNG: returns a function yielding floats in [0, 1). */
function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = {
  toPbDate: toPbDate,
  parsePbDate: parsePbDate,
  parseJson: parseJson,
  readJson: readJson,
  clamp: clamp,
  mulberry32: mulberry32,
};
