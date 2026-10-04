/**
 * Engine v2, odds and market rules — run against the real PocketBase hook modules.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const odds = lib("odds.js");
const mkt = lib("markets.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters, drawRoundOf16 } = lib("tournament.js");

type Ev = { seq: number; at: number; t: string; side?: string; st: { sc: [number, number]; so: null | { h: number; a: number; th: number; ta: number }; ph: string; d: number; win: string | null; by: string | null } };

const team = (i: number) => {
  const t = TEAMS[i];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) };
};
const timing = eng.buildTiming(1000, 1);
const match = (seed: number, h = 0, a = 1) => eng.createMatch({ fixtureId: "f" + seed, seed, kickoffAt: 0, home: team(h), away: team(a), timing });
const full = (seed: number, h = 0, a = 1): Ev[] => eng.advanceTo(match(seed, h, a), 1e12);

describe("incremental, server-authoritative engine", () => {
  it("never simulates beyond 'now' and is deterministic for a seed", () => {
    const st = match(7);
    const early = eng.advanceTo(st, 30_000);
    expect(early.every((e: Ev) => e.at <= 30_000 + timing.goalPauseMs + timing.penAwardMs + timing.penSetupMs)).toBe(true);
    expect(st.phase).not.toBe("finished");
    const rest = eng.advanceTo(st, 1e12);
    const again = full(7);
    expect([...early, ...rest].map((e: Ev) => e.t + e.seq)).toEqual(again.map((e) => e.t + e.seq));
  });

  it("orders events by seq with non-decreasing publication time", () => {
    for (let s = 1; s <= 30; s++) {
      const ev = full(s, s % 16, (s * 5 + 1) % 16);
      ev.forEach((e, i) => {
        expect(e.seq).toBe(i + 1);
        if (i) expect(e.at).toBeGreaterThanOrEqual(ev[i - 1].at);
      });
      expect(ev[ev.length - 1].t).toBe("match_end");
    }
  });

  it("follows the competition rules: 90, extra time if level, then penalties", () => {
    let et = 0;
    let pens = 0;
    for (let s = 1; s <= 300; s++) {
      const ev = full(s, s % 16, (s * 3 + 7) % 16);
      const end = ev[ev.length - 1].st;
      const types = new Set(ev.map((e) => e.t));
      if (end.by === "normal") expect(types.has("extra_time")).toBe(false);
      if (end.by === "aet") {
        et++;
        expect(types.has("extra_time")).toBe(true);
        expect(end.sc[0]).not.toBe(end.sc[1]);
      }
      if (end.by === "pens") {
        pens++;
        expect(types.has("shootout_start")).toBe(true);
        expect(end.sc[0]).toBe(end.sc[1]); // football score level, shootout decides
        const so = end.so!;
        expect(end.win).toBe(so.h > so.a ? "home" : "away");
        if (so.th > 5 || so.ta > 5) expect(so.th).toBe(so.ta); // sudden death: equal kicks
      }
    }
    expect(et).toBeGreaterThan(0);
    expect(pens).toBeGreaterThan(0);
  });

  it("shootout decisions end early only when the other side cannot catch up", () => {
    expect(eng.shootoutDecided(3, 0, 3, 3)).toBe("home"); // away can reach at most 2
    expect(eng.shootoutDecided(3, 1, 3, 3)).toBe(null);
    expect(eng.shootoutDecided(5, 5, 6, 5)).toBe(null); // sudden death: wait for the pair
    expect(eng.shootoutDecided(6, 5, 6, 6)).toBe("home");
  });

  it("shootout kicks never touch the football score", () => {
    for (let s = 1; s <= 400; s++) {
      const ev = full(s, s % 16, (s * 11 + 3) % 16);
      const start = ev.find((e) => e.t === "shootout_start");
      if (!start) continue;
      ev.filter((e) => e.seq > start.seq).forEach((e) => expect(e.st.sc).toEqual(start.st.sc));
      return;
    }
    throw new Error("no shootout in sample");
  });

  it("suspends markets from the attack until the outcome is published", () => {
    const ev = full(42);
    const shot = ev.findIndex((e) => e.t === "shot");
    expect(ev[shot].st.d).toBe(1);
    const res = ev.slice(shot + 1).find((e) => ["goal", "save", "miss", "block", "woodwork"].includes(e.t))!;
    if (res.t === "goal") expect(res.st.d).toBe(1); // stays suspended through the celebration
    else expect(res.st.d).toBe(0);
  });

  it("queued coaching applies only to future minutes", () => {
    const st = match(9);
    eng.advanceTo(st, 20 * timing.minuteMs);
    const minute = st.minute;
    eng.queueStance(st, "home", "attack");
    const later = eng.advanceTo(st, 1e12) as Array<Ev & { stance?: string; min: number }>;
    const c = later.find((e) => e.t === "coaching" && e.side === "home");
    expect(c && c.min).toBeGreaterThan(minute);
  });
});

describe("legacy persisted-state compatibility", () => {
  type St = {
    fx: string;
    phase: string;
    minute: number;
    seq: number;
    rc: number;
    score: [number, number];
    nextAt: number;
    lastAt: number;
    timing: Record<string, number>;
    winner?: string | null;
  };
  /** Advance a fresh match until it sits at the extra-time half-time break. */
  const toEtHalfTime = (st: St): boolean => {
    let now = 0;
    while (st.phase !== "et_half_time" && st.phase !== "finished") {
      now += st.timing.minuteMs + st.timing.goalPauseMs + st.timing.resultHoldMs + 1000;
      eng.advanceTo(st, now);
    }
    return st.phase === "et_half_time";
  };
  const etMatch = (timingOverride?: Record<string, number>): St => {
    for (let s = 1; s < 400; s++) {
      const st = eng.createMatch({ fixtureId: "f" + s, seed: s, kickoffAt: 0, home: team(s % 16), away: team((s * 3 + 7) % 16), timing: timingOverride || timing });
      if (toEtHalfTime(st)) return st;
    }
    throw new Error("no seed reached extra time");
  };
  const stripNewFields = (st: St) => {
    st.timing = { ...st.timing }; // clone: the match() helper shares one timing object
    delete st.timing.resultHoldMs;
    delete st.timing.kickoffHoldMs;
  };

  it("repairs the null cursor at the extra_time_2 minute-105 resume and finishes with exactly one match_end", () => {
    const st = etMatch(); // et_half_time break at minute 105, exactly where production persisted null
    stripNewFields(st);
    st.nextAt = NaN; // the deployed engine persisted null here instead
    const seq = st.seq;
    const seed = Number(st.fx.slice(1));
    expect(st.minute).toBe(105);
    const persisted = JSON.parse(JSON.stringify(st)); // exact legacy combination: both fields absent + null cursor, before any engine call
    expect(persisted.nextAt).toBe(null);
    expect(persisted.timing.resultHoldMs).toBeUndefined();
    expect(persisted.timing.kickoffHoldMs).toBeUndefined();
    const ev = eng.advanceTo(persisted, Number.MAX_SAFE_INTEGER) as Ev[];
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => Number.isFinite(e.at))).toBe(true);
    ev.forEach((e, i) => {
      expect(e.seq).toBe(seq + i + 1);
      if (i) expect(e.at).toBeGreaterThanOrEqual(ev[i - 1].at);
    });
    expect(ev[ev.length - 1].t).toBe("match_end");
    expect(ev.filter((e) => e.t === "match_end")).toHaveLength(1);
    // the hydrated match follows the identical deterministic path as an unpoisoned twin
    const twin = etMatch(); // same first seed: identical teams and trajectory
    expect(Number(twin.fx.slice(1))).toBe(seed);
    const twinEv = [...(eng.advanceTo(twin, twin.nextAt) as Ev[]), ...(eng.advanceTo(twin, Number.MAX_SAFE_INTEGER) as Ev[])]; // resume + remainder, matching ev's span
    const minOf = (e: Ev) => (e as Ev & { min?: number }).min;
    const twinRest = twinEv.filter((e) => e.seq > seq).map((e) => [e.t, e.seq, minOf(e), e.st.sc]);
    expect(ev.map((e) => [e.t, e.seq, minOf(e), e.st.sc])).toEqual(twinRest);
    const reloaded = JSON.parse(JSON.stringify(persisted));
    const after = eng.advanceTo(reloaded, Number.MAX_SAFE_INTEGER);
    expect(after.filter((e: Ev) => e.t === "match_end")).toHaveLength(0); // no duplicate after reload
  });

  it("derives the missing timings at the saved time scale", () => {
    const scaled = eng.buildTiming(15000, 3); // halfTimeMs 10000 -> k = 3
    const st = etMatch(scaled);
    stripNewFields(st);
    eng.advanceTo(st, st.nextAt + 1);
    const persisted = JSON.parse(JSON.stringify(st));
    eng.advanceTo(persisted, st.lastAt + 10 * scaled.minuteMs);
    expect(persisted.timing.kickoffHoldMs).toBe(Math.max(20, Math.round(4000 / 3)));
    expect(persisted.timing.resultHoldMs).toBe(Math.max(20, Math.round(1200 / 3)));
  });

  it("repairs a null cursor poisoned inside a live minute", () => {
    const st = match(8);
    eng.advanceTo(st, 5 * timing.minuteMs);
    stripNewFields(st);
    st.nextAt = null; // poisoned cursor mid live phase
    const seq = st.seq;
    const ev = eng.advanceTo(st, 1e12) as Ev[];
    expect(ev[ev.length - 1].t).toBe("match_end");
    expect(ev.filter((e) => e.t === "match_end")).toHaveLength(1);
    expect(ev.every((e) => Number.isFinite(e.at))).toBe(true);
    expect(ev[0].seq).toBe(seq + 1);
  });

  it("leaves a finished match with serialized nextAt null untouched", () => {
    const st = match(11);
    eng.advanceTo(st, 1e12);
    expect(st.phase).toBe("finished");
    const winner = st.winner;
    const persisted = JSON.parse(JSON.stringify(st));
    expect(persisted.nextAt).toBe(null);
    const ev = eng.advanceTo(persisted, 1e12);
    expect(ev).toEqual([]);
    expect(persisted.nextAt).toBe(null);
    expect(persisted.winner).toBe(winner);
  });

  it("preserves explicit valid timing fields, including zero", () => {
    const st = match(12);
    eng.advanceTo(st, 2 * timing.minuteMs);
    st.timing.kickoffHoldMs = 777;
    st.timing.resultHoldMs = 0;
    eng.advanceTo(st, 1e12);
    expect(st.timing.kickoffHoldMs).toBe(777);
    expect(st.timing.resultHoldMs).toBe(0);
  });
});

describe("odds", () => {
  it("prices are valid and favour the stronger team", () => {
    const st = match(1, 0, 15); // A++ v C-
    const r = eng.goalRates(st);
    const p = odds.pairQualify({ lh: r.home, la: r.away });
    expect(p).toBeGreaterThan(0.6);
    expect(odds.price(p)).toBeGreaterThanOrEqual(1.01);
    expect(odds.price(1 - p)).toBeLessThanOrEqual(500);
    expect(odds.price(0.5)).toBeCloseTo(0.94 / 0.5, 2);
  });

  it("final-score distribution sums to 1 and respects the current score", () => {
    const m = { lh: 0.02, la: 0.015 };
    const fd = odds.finalDist(m, { sc: [2, 1], ph: "second_half", x: [[], []] }, 60);
    const total = Object.values(fd.dist as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0.995);
    expect(Object.keys(fd.dist).every((k) => +k.split("-")[0] >= 2 && +k.split("-")[1] >= 1)).toBe(true);
    expect(fd.qualifyHome).toBeGreaterThan(0.7);
  });

  it("championship probabilities over the bracket sum to 1; semi-finalists to 4", () => {
    const ids = TEAMS.map((t: { slug: string }) => t.slug);
    const r16 = Array.from({ length: 8 }, (_, i) => ({ home: ids[2 * i], away: ids[2 * i + 1] }));
    const b = odds.bracket(r16, (x: string, y: string) => (x < y ? 0.55 : 0.45));
    const sum = (o: Record<string, number>) => Object.values(o).reduce((a, x) => a + x, 0);
    expect(sum(b.champion)).toBeCloseTo(1, 6);
    expect(sum(b.reachSF)).toBeCloseTo(4, 6);
    expect(b.quarters).toHaveLength(4);
  });
});

describe("market rules", () => {
  const res = (sh: number, sa: number, winner: string) => ({ sh, sa, winner });
  it("winner includes extra time and penalties", () => {
    expect(mkt.settleFixtureBet("winner", "away", res(1, 1, "away"))).toBe("won");
  });
  it("exact score excludes shootout goals", () => {
    expect(mkt.settleFixtureBet("exact", "1-1", res(1, 1, "home"))).toBe("won");
    expect(mkt.settleFixtureBet("exact", "2-1", res(1, 1, "home"))).toBe("lost");
  });
  it("margin uses the football score; a shootout win has margin 0", () => {
    expect(mkt.settleFixtureBet("margin", "home2", res(3, 1, "home"))).toBe("won");
    expect(mkt.settleFixtureBet("margin", "away3", res(0, 3, "away"))).toBe("won");
    expect(mkt.settleFixtureBet("margin", "home2", res(2, 2, "home"))).toBe("lost");
  });
  it("next goal 'none' wins at full time with no further goal", () => {
    expect(mkt.settleFixtureBet("next_goal", "none", res(1, 0, "home"))).toBe("won");
    expect(mkt.settleFixtureBet("next_goal", "home", res(1, 0, "home"))).toBe("lost");
  });
  it("stakes are whole credits; payouts round down", () => {
    expect(mkt.validStake(2.5).error).toBeTruthy();
    expect(mkt.validStake(0).error).toBeTruthy();
    expect(mkt.validStake(10).stake).toBe(10);
    expect(mkt.payout(10, 2.35)).toBe(23);
  });
  it("semi-finalists must be one per quarter", () => {
    const q = [["a", "b"], ["c", "d"], ["e", "f"], ["g", "h"]];
    expect(mkt.normaliseSemis("a,c,e,g", q).ids).toEqual(["a", "c", "e", "g"]);
    expect(mkt.normaliseSemis("a,b,e,g", q).error).toBeTruthy();
    expect(mkt.normaliseSemis("a,c,e", q).error).toBeTruthy();
  });
  it("markets close while a critical incident is unresolved", () => {
    const fx = { status: "live", kickoffAt: 0 };
    expect(mkt.fixtureState(fx, { ph: "second_half", d: 1 }, 1).closed).toBeTruthy();
    expect(mkt.fixtureState(fx, { ph: "second_half", d: 0 }, 1).closed).toBe(null);
    expect(mkt.fixtureState(fx, { ph: "shootout", d: 1 }, 1).closed).toBeTruthy();
  });
});

describe("tournament draw", () => {
  it("pairs 16 teams into 8 fixtures", () => {
    const ids = Array.from({ length: 16 }, (_, i) => `t${i}`);
    const fixtures = drawRoundOf16(ids, 42) as Array<{ homeId: string; awayId: string }>;
    expect(fixtures).toHaveLength(8);
    expect(new Set(fixtures.flatMap((f) => [f.homeId, f.awayId])).size).toBe(16);
  });
});
