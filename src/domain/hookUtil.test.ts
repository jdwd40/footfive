// Review D4: one shared implementation of the low-level hook helpers.
// The copies these replace had drifted: worldService's parsePbDate could not read
// Date objects.
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib", f));
const util = lib("util.js");

describe("parseJson", () => {
  it("reads JSON strings and deep-copies already-decoded values", () => {
    expect(util.parseJson('{"a":1}', null)).toEqual({ a: 1 });
    const v = { a: { b: 2 } };
    const copy = util.parseJson(v, null);
    expect(copy).toEqual(v);
    expect(copy).not.toBe(v);
  });

  it("never reinterprets a numeric array as bytes", () => {
    expect(util.parseJson([1, 2], null)).toEqual([1, 2]);
    expect(util.parseJson([91, 93], null)).toEqual([91, 93]);
    expect(util.parseJson([74, 111, 115, 195, 169], null)).toEqual([74, 111, 115, 195, 169]);
  });

  it("returns the fallback for empty or unparseable input", () => {
    expect(util.parseJson(null, "fb")).toBe("fb");
    expect(util.parseJson("", "fb")).toBe("fb");
    expect(util.parseJson("{nope", "fb")).toBe("fb");
  });
});

// Codex review on PR #238: JSON fields must be read at the record boundary with
// getString(), which returns the stored text exactly. record.get() can hand back
// UTF-8 bytes in the JSVM; decoding those guessed [] / {} / "José" wrong.
describe("readJson", () => {
  const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));
  /** A record shaped like PocketBase's: get() gives bytes, getString() gives the text. */
  const pbRecord = (fields: Record<string, string | null>) => ({
    get: (k: string) => (fields[k] == null ? null : utf8(fields[k] as string)),
    getString: (k: string) => (fields[k] == null ? "null" : (fields[k] as string)),
  });

  it("reads [], {} and accented text losslessly", () => {
    const rec = pbRecord({ cards: "[]", coaching: "{}", goals: '[{"player":"José"}]' });
    expect(util.readJson(rec, "cards", null)).toEqual([]);
    expect(util.readJson(rec, "coaching", null)).toEqual({});
    expect(util.readJson(rec, "goals", null)).toEqual([{ player: "José" }]);
  });

  it("gives the fallback for an empty or JSON-null field", () => {
    expect(util.readJson(pbRecord({ a: null }), "a", "fb")).toBe("fb");
    expect(util.readJson({ getString: () => "", get: () => null }, "a", "fb")).toBe("fb");
    expect(util.readJson(null, "a", "fb")).toBe("fb");
  });

  it("keeps already-decoded values from records without JSON text", () => {
    const decoded = { cards: [], coaching: {}, goals: [{ player: "José" }] };
    const noGetString = { get: (k: string) => decoded[k as keyof typeof decoded] };
    expect(util.readJson(noGetString, "cards", null)).toEqual([]);
    expect(util.readJson(noGetString, "goals", null)).toEqual([{ player: "José" }]);
    const fake = { get: (k: string) => decoded[k as keyof typeof decoded], getString: () => "[object Object]" };
    expect(util.readJson(fake, "coaching", null)).toEqual({});
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
