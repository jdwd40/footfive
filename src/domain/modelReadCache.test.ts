/** #228: reuse parsed kickoff models without retaining a stale fixture version or changing prices. */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const lib = (name: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + name));
const world = lib("worldService.js"), odds = lib("odds.js"), engine = lib("matchEngine.js");
const { TEAMS } = lib("teams.js"), { defaultStarters } = lib("tournament.js");
const fixture = (raw: string) => ({ id: "same-fixture", raw, getString() { return this.raw; }, get() { return this.raw; } });
const model = (nonce: string, lh = 0.02) => JSON.stringify({ lh, la: 0.01, nonce });
const team = (i: number, ai: boolean) => {
  const t = TEAMS[i];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players), ai };
};

describe("kickoff model reads cached by exact current JSON", () => {
  it("avoids reparsing an unchanged model but still observes the raw field on every call", () => {
    const fx = fixture(model("read-each-call"));
    const read = vi.spyOn(fx, "getString"), parse = vi.spyOn(JSON, "parse");
    try {
      const first = world.modelOf(fx);
      expect(world.modelOf(fx)).toBe(first);
      expect(read).toHaveBeenCalledTimes(2);
      expect(parse).toHaveBeenCalledTimes(1);
    } finally { read.mockRestore(); parse.mockRestore(); }
  });

  it("observes replacement JSON on the same fixture and cannot leak another fixture's model", () => {
    const fx = fixture(model("version", 0.01));
    const first = world.modelOf(fx);
    fx.raw = model("version", 0.06);
    const changed = world.modelOf(fx);
    expect(changed.lh).toBe(0.06);
    expect(changed).not.toBe(first);
    expect(world.modelOf(fixture(model("different-fixture", 0.03))).lh).toBe(0.03);
    fx.raw = model("version", 0.01);
    expect(world.modelOf(fx)).toBe(first);
    // Equal JSON contents may share a snapshot across fixture ids; alternate source encodings stay separate.
    const other = { ...fx, id: "other-fixture" };
    expect(world.modelOf(other)).toBe(first);
    other.raw = JSON.stringify(JSON.parse(fx.raw), null, 2);
    expect(world.modelOf(other)).toEqual(first);
    expect(world.modelOf(other)).not.toBe(first);
  });

  it("bounds retained source snapshots and reads the right value after eviction", () => {
    const fx = fixture(model("eviction-original")), first = world.modelOf(fx);
    for (let i = 0; i < 128; i++) world.modelOf(fixture(model("eviction-" + i)));
    const again = world.modelOf(fx);
    expect(again).toEqual(first);
    expect(again).not.toBe(first);
  });

  it("preserves malformed, missing, native-object and byte-array compatibility without caching mutable native objects", () => {
    for (const raw of ["", "null", "not-json", "{}", "0", '"a string"']) expect(world.modelOf(fixture(raw))).toBeNull();
    const native = { lh: 0.025, la: 0.01 };
    const fx = { get() { return native; } };
    const first = world.modelOf(fx);
    expect(first).toEqual(native);
    expect(first).not.toBe(native);
    native.lh = 0.07;
    expect(world.modelOf(fx).lh).toBe(0.07);
    expect(first.lh).toBe(0.025);
    const bytes = [...Buffer.from(JSON.stringify(native))];
    expect(world.modelOf({ getString() { throw new Error("no string"); }, get() { return bytes; } })).toEqual(native);
    expect(world.modelOf({ getString() { return "invalid"; }, get() { return native; } })).toEqual(native);
  });

  it("keeps legacy, AI and both-manager prices equal to fresh reads without semantic mutation", () => {
    const pub = { ph: "second_half", sc: [0, 1], cs: ["attack", "balanced"] };
    for (const [homeAI, awayAI] of [[true, true], [false, true], [true, false], [false, false]]) {
      const st = engine.createMatch({ fixtureId: "read-prices", seed: 1, kickoffAt: 0, home: team(0, homeAI), away: team(5, awayAI) });
      const raw = JSON.stringify(engine.inPlayModel(st)), fx = fixture(raw), cached = world.modelOf(fx);
      const fresh = JSON.parse(raw);
      for (const cs of [["balanced", "balanced"], ["attack", "balanced"], ["defend", "attack"]]) {
        expect(odds.marketProbs(world.modelOf(fx), { ...pub, cs }, 75)).toEqual(odds.marketProbs(fresh, { ...pub, cs }, 75));
      }
      expect(JSON.stringify(cached)).toBe(raw); // nonenumerable odds memoization never changes semantic model fields
      expect(world.modelOf(fx)).toBe(cached);
    }
    const fx = fixture(model("legacy-prices"));
    expect(odds.marketProbs(world.modelOf(fx), pub, 75)).toEqual(odds.marketProbs(JSON.parse(fx.raw), pub, 75));
  });
});
