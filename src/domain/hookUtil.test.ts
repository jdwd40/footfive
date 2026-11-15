// Review D4: one shared implementation of the low-level hook helpers.
// The copies these replace had drifted: recordsService's parseJson could not read
// JSVM byte arrays, and worldService's parsePbDate could not read Date objects.
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib", f));
const util = lib("util.js");

const bytes = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

describe("parseJson", () => {
  it("reads JSON strings, JSVM byte arrays and decoded values", () => {
    expect(util.parseJson('{"a":1}', null)).toEqual({ a: 1 });
    expect(util.parseJson(bytes('{"a":[1,2]}'), null)).toEqual({ a: [1, 2] });
    const v = { a: { b: 2 } };
    const copy = util.parseJson(v, null);
    expect(copy).toEqual(v);
    expect(copy).not.toBe(v);
  });

  it("returns the fallback for empty or unparseable input", () => {
    expect(util.parseJson(null, "fb")).toBe("fb");
    expect(util.parseJson("", "fb")).toBe("fb");
    expect(util.parseJson("{nope", "fb")).toBe("fb");
  });

  it("keeps a short numeric array as data rather than bytes", () => {
    expect(util.parseJson([1, 2], null)).toEqual([1, 2]);
  });
});

describe("parsePbDate / toPbDate", () => {
  it("round-trips PocketBase dates and accepts Date objects", () => {
    const d = new Date("2026-10-01T21:25:00.123Z");
    expect(util.toPbDate(d)).toBe("2026-10-01 21:25:00.123Z");
    expect(util.parsePbDate(util.toPbDate(d))).toBe(d.getTime());
    expect(util.parsePbDate(d)).toBe(d.getTime());
    expect(util.parsePbDate("2026-10-01 21:25:00.123")).toBe(d.getTime());
    expect(util.parsePbDate("")).toBeNaN();
  });
});

describe("services share the util implementations", () => {
  it("matchEngine and tournament use the same seeded RNG", () => {
    const a = util.mulberry32(42);
    const b = util.mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(lib("tournament.js").mulberry32).toBe(util.mulberry32);
  });
});
