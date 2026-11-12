/** #228: prices use the stance already public at this event, with kickoff fallback and separate caches. */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js"), odds = lib("odds.js"), markets = lib("markets.js");
const { TEAMS } = lib("teams.js"), { defaultStarters } = lib("tournament.js");
const team = (n: number, ai = false, stance = "balanced") => {
  const t = TEAMS[n];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players), ai, stance };
};
const make = (homeAI = false, awayAI = false) => eng.createMatch({ fixtureId: "published", seed: 228, kickoffAt: 0, timing: eng.buildTiming(6000, 1), home: team(0, homeAI), away: team(5, awayAI) });
const publicState = (home = "balanced", away = "balanced") => ({ ph: "second_half", sc: [0, 1], cs: [home, away], d: 0 });
const maxDiff = (a: Record<string, number>, b: Record<string, number>) => Math.max(0, ...Object.keys(a).map((k) => Math.abs(a[k] - (b[k] || 0))));

describe("current published stances (#228)", () => {
  it("changes prices at the coaching row, never from a queued command or advanced hidden state", () => {
    const st = make(), model = eng.inPlayModel(st);
    const ev = eng.advanceTo(st, st.nextAt);
    const before = ev.at(-1);
    const oldPrice = odds.nextGoal(model, before.st, 0);
    eng.queueStance(st, "home", "attack");
    eng.queueStance(st, "away", "defend");
    expect(odds.nextGoal(model, before.st, 0)).toEqual(oldPrice);
    const next = eng.advanceTo(st, st.nextAt);
    const commands = next.filter((e: { t: string }) => e.t === "coaching");
    expect(commands).toHaveLength(2);
    expect(commands[0].st.cs).toEqual(["attack", "balanced"]);
    expect(commands[1].st.cs).toEqual(["attack", "defend"]);
    expect(odds.nextGoal(model, commands[0].st, 0)).not.toEqual(oldPrice);
    expect(odds.nextGoal(model, commands[1].st, 0)).not.toEqual(odds.nextGoal(model, commands[0].st, 0));
    eng.advanceTo(st, Infinity);
    expect(odds.nextGoal(model, before.st, 0)).toEqual(oldPrice);
    expect(before.st.cs).toEqual(["balanced", "balanced"]);
  });

  it("prices either manager and separates alternating stance/cache inputs, including equal-tempo choices", () => {
    const model = eng.inPlayModel(make());
    const b = odds.marketProbs(model, publicState(), 75);
    const h = odds.marketProbs(model, publicState("attack"), 75);
    const a = odds.marketProbs(model, publicState("balanced", "attack"), 75);
    expect(h.next.none).toBeLessThan(b.next.none);
    expect(a.next.none).toBeLessThan(b.next.none);
    const first = odds.marketProbs(model, publicState("attack", "defend"), 75);
    const second = odds.marketProbs(model, publicState("defend", "attack"), 75);
    expect(first).not.toBe(second); // same tempo does not collapse their stance cache keys
    expect(odds.marketProbs(model, publicState(), 75)).toBe(b);
    expect(odds.marketProbs(model, publicState("attack"), 75)).toBe(h);
    expect(odds.marketProbs(model, publicState("attack", "defend"), 75)).toBe(first);
    const saved = JSON.stringify(model);
    const fresh = JSON.parse(saved);
    expect(odds.marketProbs(fresh, publicState("attack"), 75)).toEqual(h);
    expect(JSON.stringify(model)).toBe(saved);
    expect(saved).not.toContain("__stances");
  });

  it("falls back to kickoff stances, keeps AI future policy and preserves legacy model prices", () => {
    const st = make(false, true), model = eng.inPlayModel(st);
    const old = { ph: "second_half", sc: [1, 0] };
    expect(odds.nextGoal(model, old, 85)).toEqual(odds.nextGoal(model, { ...old, cs: ["balanced", "balanced"] }, 85));
    expect(odds.nextGoal(model, { ...old, cs: ["attack", "attack"] }, 85)).toEqual(odds.nextGoal(model, { ...old, cs: ["attack", "defend"] }, 85));
    const { v, ai, cs, ...legacy } = JSON.parse(JSON.stringify(model));
    void v; void ai; void cs;
    for (const m of [legacy, { lh: 0.03, la: 0.02 }]) {
      expect(odds.marketProbs(m, old, 85)).toEqual(odds.marketProbs(m, { ...old, cs: ["attack", "attack"] }, 85));
    }
  });

  it("keeps fixture catalogue and reference probabilities equal for all manager stance combinations", () => {
    for (const [h, a] of [[0, 5], [1, 15], [8, 2]]) {
      const st = eng.createMatch({ fixtureId: "grid", seed: 1, kickoffAt: 0, home: team(h), away: team(a) });
      const model = eng.inPlayModel(st);
      for (const hs of ["balanced", "attack", "defend"]) for (const as of ["balanced", "attack", "defend"]) for (const minute of [60, 75, 85, 105]) {
        const pub = { ...publicState(hs, as), ph: minute > 90 ? "extra_time_1" : "second_half" };
        const fast = odds.marketProbs(model, pub, minute), ref = odds.finalDist(model, pub, minute);
        expect(fast.qualifyHome).toBeCloseTo(ref.qualifyHome, 7);
        expect(maxDiff(fast.exact, ref.dist)).toBeLessThan(1e-7);
        expect(maxDiff(fast.next, odds._ref.next(model, pub, minute))).toBeLessThan(1e-10);
        const cat = markets.fixtureMarkets({ status: "live", kickoffAt: 0, model, home: team(h), away: team(a) }, pub, minute, 1);
        expect(markets.findSelection(cat, "winner", "home")).toMatchObject({ odds: markets.okP(fast.qualifyHome, true) });
        expect(odds.fixturePrices(model, pub, minute).winner.home).toBe(markets.okP(ref.qualifyHome, true));
      }
    }
  });

  it("keeps the known high-score R8 rounding boundary explicit instead of confusing it with stance selection", () => {
    const st = eng.createMatch({ fixtureId: "rounding", seed: 1, kickoffAt: 0, home: team(15), away: team(6) });
    const model = eng.inPlayModel(st), pub = { ...publicState("attack", "attack"), sc: [0, 6] };
    const fast = odds.marketProbs(model, pub, 60), ref = odds.finalDist(model, pub, 60);
    const p = Object.entries(ref.dist).reduce((sum: number, [key, value]) => {
      const [h, a] = key.split("-").map(Number);
      return sum + (a - h === 3 ? Number(value) : 0);
    }, 0);
    expect(Math.abs(fast.margin.away3 - p)).toBeLessThan(1e-7);
    expect(Math.abs(fast.margin.away3 - p)).toBeGreaterThan(1e-9);
    expect(markets.okP(fast.margin.away3, true)).toBe(400.58);
    expect(markets.okP(p, true)).toBe(400.57);
  });

});
