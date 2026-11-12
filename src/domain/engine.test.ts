/**
 * Engine v2, odds and market rules — run against the real PocketBase hook modules.
 */
import { createHash } from "node:crypto";
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

describe("midfield play goes on from the ball (#213)", () => {
  type Pass = Ev & { min: number; chain?: number; from: [number, number]; ball: [number, number]; side: "home" | "away" };
  const along = (side: string, p: [number, number]) => (side === "home" ? p[0] : 100 - p[0]);
  const passes: Pass[] = [];
  for (let seed = 1; seed <= 60; seed++) for (const e of full(seed, seed % 16, (seed * 7 + 3) % 16) as Pass[]) if (e.t === "pass" && !e.chain) passes.push(e);

  it("each pass lands a little ahead of where the ball was, never more than a few units back, in either direction of play", () => {
    expect(passes.length).toBeGreaterThan(3000);
    let back = 0;
    let forward = 0;
    for (const side of ["home", "away"]) {
      const own = passes.filter((e) => e.side === side);
      expect(own.length).toBeGreaterThan(1000);
      for (const e of own) {
        const from = along(side, e.from);
        const to = along(side, e.ball);
        expect(to, `#${e.seq}`).toBeGreaterThanOrEqual(22 - 0.5); // midfield: out of his own box, short of the final third
        expect(to, `#${e.seq}`).toBeLessThanOrEqual(66 + 0.5);
        // From anywhere in midfield it moves on from the ball's spot: at most 3 back and at most 13 on.
        if (from >= 25 && from <= 63) expect(to - from, `#${e.seq} ${side} ${from} -> ${to}`).toBeGreaterThanOrEqual(-3.5);
        if (from >= 22) expect(to - from, `#${e.seq} ${side} ${from} -> ${to}`).toBeLessThanOrEqual(13.5);
        if (to - from < -3) back++;
        forward += to - from;
      }
    }
    // The old placement ignored the ball: about half of these went backwards, by 3.4 units on average.
    expect(back / passes.length).toBeLessThan(0.1);
    expect(forward / passes.length).toBeGreaterThan(2);
  });

  it("possession carries the ball up the pitch: a run of passes ends further up than it started", () => {
    // Consecutive midfield passes by the same side (no tackle in between) keep going forward rather than shuttling about.
    let runs = 0;
    let up = 0;
    for (let i = 1; i < passes.length; i++) {
      const a = passes[i - 1];
      const b = passes[i];
      if (a.side !== b.side || b.seq !== a.seq + 1 || along(a.side, a.from) > 50) continue;
      runs++;
      if (along(b.side, b.ball) > along(a.side, a.from)) up++;
    }
    expect(runs).toBeGreaterThan(500);
    expect(up / runs).toBeGreaterThan(0.85);
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
  it.each([[0, 0], [0, 15], [15, 0]])("normalises current tuned rates and prices for pair %s/%s", (home, away) => {
    const rates = eng.goalRates(match(1, home, away));
    const p = odds.pairQualify({ lh: rates.home, la: rates.away });
    const reverse = odds.pairQualify({ lh: rates.away, la: rates.home });
    // The existing Poisson model truncates tiny score tails; use the same 0.5%
    // mass tolerance as the final-score distribution check below.
    expect(p + reverse).toBeGreaterThan(0.995);
    expect(p + reverse).toBeLessThanOrEqual(1.000001);
    for (const probability of [p, reverse]) {
      expect(probability).toBeGreaterThan(0);
      expect(probability).toBeLessThan(1);
      expect(Number.isFinite(odds.price(probability))).toBe(true);
      expect(odds.price(probability)).toBeGreaterThanOrEqual(1.01);
    }
    const distribution = odds.finalDist({ lh: rates.home, la: rates.away }, { sc: [0, 0], ph: "first_half", x: [[], []] }, 0);
    const total = Object.values(distribution.dist as Record<string, number>).reduce((sum, probability) => sum + probability, 0);
    expect(total).toBeGreaterThan(0.995);
    expect(total).toBeLessThanOrEqual(1.000001);
  });

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

  it("in play, withdraws a near-certain selection instead of pricing it at 1.01 (#203)", () => {
    expect(odds.MIN_OFFER).toBe(1.05);
    const edge = (1 - odds.MARGIN) / odds.MIN_OFFER; // ≈ 0.895: the last probability still offered, at exactly 1.05
    expect(odds.price(edge, true)).toBe(1.05);
    expect(odds.price(edge + 0.001, true)).toBeNull();
    expect(odds.price(0.89, true)).toBe(1.06);
    for (const p of [0.9, 0.95, 0.99, 1]) expect(odds.price(p, true)).toBeNull(); // 0.9–0.93 used to be 1.01–1.04, above 0.93 clamped to 1.01
    expect(odds.price(0, true)).toBeNull(); // long shots are unchanged
    expect(odds.price(0.002, true)).toBe(470);
    for (const ph of ["first_half", "half_time", "second_half", "et_break", "extra_time_1", "et_half_time", "extra_time_2", "shootout"]) expect(odds.inPlay({ ph }), ph).toBe(true);
    expect(odds.inPlay({ ph: "pre" })).toBe(false);
    expect(odds.inPlay(null)).toBe(false);
  });

  it("pre-match prices are unchanged: a near-certain favourite keeps main's 1.01 floor (#203)", () => {
    for (const p of [0.9, 0.93, 0.95, 0.978, 0.99, 1]) {
      expect(odds.price(p)).toBe(Math.round(Math.max(1.01, 0.94 / p) * 100) / 100);
      expect(odds.price(p, false)).toBe(odds.price(p));
    }
    expect(odds.price(0.99)).toBe(1.01);
    const lopsided = { model: { lh: 0.05, la: 0.002 }, home: { name: "Strong", abbr: "STR" }, away: { name: "Weak", abbr: "WEK" } };
    const scheduled = mkt.fixtureMarkets({ status: "scheduled", kickoffAt: 1_000_000, ...lopsided }, null, 0, 0);
    const fav = scheduled.markets.find((m: { key: string }) => m.key === "winner").sel.find((s: { id: string }) => s.id === "home");
    expect(odds.finalDist(lopsided.model, { sc: [0, 0], ph: "pre" }, 0).qualifyHome).toBeGreaterThan(0.93);
    expect(fav.odds).toBe(1.01);
    expect(mkt.findSelection(scheduled, "winner", "home")).toMatchObject({ odds: 1.01 });
  });

  it("the playtest's 0–5 late on: the decided outcome is withdrawn and cannot be bet; nothing anywhere is priced under 1.05 (#203)", () => {
    const sides = { model: { lh: 0.02, la: 0.03 }, home: { name: "Mega City Two", abbr: "MC2" }, away: { name: "New Metro City", abbr: "MET" } };
    const at = (sc: [number, number], ph: string, minute: number) => mkt.fixtureMarkets({ status: "live", kickoffAt: 0, ...sides }, { sc, ph, x: [[], []], d: 0 }, minute, 1);
    const late = at([0, 5], "second_half", 87);
    const winner = late.markets.find((m: { key: string }) => m.key === "winner").sel;
    expect(winner.find((s: { id: string }) => s.id === "away").odds).toBeNull();
    expect(mkt.findSelection(late, "winner", "away")).toEqual({ closed: "Selection unavailable" });
    // A shootout already won (4–1 with one kick each left) is withdrawn too; the loser stays unoffered as a long shot.
    const so = mkt.fixtureMarkets({ status: "live", kickoffAt: 0, ...sides }, { sc: [1, 1], ph: "shootout", so: { h: 4, a: 1, th: 4, ta: 4, next: "home" }, x: [[], []], d: 0 }, 120, 1);
    expect(mkt.findSelection(so, "winner", "home")).toEqual({ closed: "Selection unavailable" });
    // A real contest stays open on both sides.
    const open = at([1, 1], "second_half", 60).markets.find((m: { key: string }) => m.key === "winner").sel;
    for (const s of open) expect(s.odds).toBeGreaterThan(1.05);
    for (const [sc, ph, minute] of [[[0, 5], "second_half", 87], [[0, 3], "half_time", 45], [[2, 0], "second_half", 89], [[1, 1], "extra_time_2", 119], [[0, 0], "first_half", 1]] as const) {
      for (const m of at([...sc], ph, minute).markets) for (const s of m.sel) if (s.odds !== null) expect(s.odds, `${m.key}/${s.id} at ${sc} ${minute}'`).toBeGreaterThanOrEqual(1.05);
    }
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

  it("offers a one-goal margin at the same cutoff and settles it with the existing rule", () => {
    const sides = {
      model: { lh: 0.02, la: 0.02 },
      home: { name: "Home City", abbr: "HOM" },
      away: { name: "Doge City", abbr: "DOG" },
    };
    const pre = mkt.fixtureMarkets({ status: "scheduled", kickoffAt: 1_000_000, ...sides }, null, 0, 0);
    const offered = pre.markets.find((m: { key: string }) => m.key === "margin").sel;
    expect(offered.map((s: { id: string }) => s.id)).toEqual(["home1", "home2", "home3", "away1", "away2", "away3"]);
    for (const id of ["home1", "away1", "home2", "away3"]) {
      const row = offered.find((s: { id: string }) => s.id === id);
      expect(row.odds).toBeGreaterThanOrEqual(1.01);
      expect(mkt.findSelection(pre, "margin", id)).toMatchObject({ odds: row.odds });
    }
    // #203: 80', not 90'. At 90' with nothing left to play away3 is a certainty and is now withdrawn (asserted below); ten minutes
    // out it is still a live, priced selection, which is what this test is about.
    const late = mkt.fixtureMarkets(
      { status: "live", kickoffAt: 0, ...sides },
      { sc: [0, 3], ph: "second_half", x: [[], []], d: 0 },
      80,
      1,
    );
    const rare = late.markets.find((m: { key: string }) => m.key === "margin").sel;
    const home1 = rare.find((s: { id: string }) => s.id === "home1");
    const away3 = rare.find((s: { id: string }) => s.id === "away3");
    expect(mkt.MIN_P).toBe(0.002);
    expect(home1.odds).toBeNull();
    expect(mkt.findSelection(late, "margin", "home1")).toEqual({ closed: "Selection unavailable" });
    expect(away3.odds).toBeGreaterThanOrEqual(1.05);
    expect(mkt.findSelection(late, "margin", "away3")).toMatchObject({ odds: away3.odds });
    const decided = mkt.fixtureMarkets({ status: "live", kickoffAt: 0, ...sides }, { sc: [0, 3], ph: "second_half", x: [[], []], d: 0 }, 90, 1);
    expect(mkt.findSelection(decided, "margin", "away3")).toEqual({ closed: "Selection unavailable" });
    expect(mkt.settleFixtureBet("margin", "home1", res(1, 0, "home"))).toBe("won");
    expect(mkt.settleFixtureBet("margin", "home1", res(2, 0, "home"))).toBe("lost");
    expect(mkt.settleFixtureBet("margin", "home1", res(1, 1, "home"))).toBe("lost");
    expect(mkt.settleFixtureBet("margin", "away1", res(0, 1, "away"))).toBe("won");
    expect(mkt.settleFixtureBet("margin", "home2", res(3, 1, "home"))).toBe("won");
    expect(mkt.settleFixtureBet("margin", "away3", res(0, 3, "away"))).toBe("won");
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

describe("authoritative outcomes are pinned to a fixed engine baseline", () => {
  // The pin guards against UNINTENTIONAL outcome drift: any engine change that alters who shoots, what the
  // RNG draws, or who wins must fail this test and be re-pinned deliberately (with old→new recorded below).
  // Same probe as the reviewer's rng-probe: 200 seeds (1000..1199),
  // event tuples (seq/at/type/actors/score/shootout) plus final state (`score`, `winner`, `by`, `so`) and RNG draw
  // count (`rc`), SHA-256 of the JSON manifest.
  // The original pin was generated from the base engine compiled straight from `git show 33dc1b8:pocketbase/pb_hooks/lib/matchEngine.js`
  // (78,776 events) — pinned as a constant so the test runs on shallow clones and source archives with no git history.
  // Issue #9 re-pin (cf385510aa429a37077f5dc8e0b8f1fd4c79657f8ce35184e9c2dab9d94333f1 →
  // f1e646ad18a3fa5c6f8318b46da0a21df7252d99ed639e3b766ad020086dad4d): attack-variety tuning deliberately changes
  // seeded outcomes — 2–4 passes per chain, occasional long-range shots, higher shot/save base rates.
  // Blocked-shot re-pin (f1e646ad18a3fa5c6f8318b46da0a21df7252d99ed639e3b766ad020086dad4d →
  // eef854d6f94f24c999783c2d6454d144d9fd16546e66a7fcddebd0b36ca2395b): blocks no longer add resultHoldMs,
  // so `at` timestamps after a block shift; outcomes, actors, scores and RNG draw count are untouched.
  // Issue #135 fitness re-pin (eef854d6f94f24c999783c2d6454d144d9fd16546e66a7fcddebd0b36ca2395b →
  // ea5b06fd2b4bc44fcc5e49d375da92d0738b8ded6ae5feaa5afd21ed20a97ab8): energy and condition now cost a player
  // 1 - 0.35 × (share missing) instead of 0.65/0.70, so the in-match wear every side carries changes seeded outcomes.
  // Same 200 inputs, projection and assertions. RNG call sites and implementation are unchanged; per-match draw
  // counts may change with play.
  // Issue #195 re-pin (ea5b06fd… → 2d0870bf…): recommended on-target/save tuning intentionally
  // changes seeded outcomes. Same 200 seeds, explicit legacy 8s snapshot and projection;
  // no RNG implementation/call-site changes. Full old/new pins and calibration: docs/balance-195.md.
  const BASE_SHA256 = "2d0870bfb62a6539a7119bc42088cddf863c1161e62a108fc2ba6c03e8f9da80";
  const liveTiming = eng.buildTiming(8000, 1);
  type Final = { score: [number, number]; winner: string | null; by: string | null; so: unknown; rc: number };
  // Issue #73 transport projection: cosmetic rows (`cos: 1`) are dropped and the real rows' integer transport `seq` is
  // renumbered 1..n in order — exactly the original sequence, since cosmetic rows only ever sit between real ones. Nothing
  // else is normalised; cosmeticShots.test.ts pins the full payload and final state under the same projection.
  const run = (seed: number) => {
    const st = eng.createMatch({ fixtureId: "f" + seed, seed, kickoffAt: 0, home: team(seed % 16), away: team((seed * 7 + 3) % 16), timing: liveTiming });
    const events = (eng.advanceTo(st, 1e13) as Array<Ev & { p?: string; p2?: string; cos?: number }>).filter((x) => !x.cos);
    const final: Final = { score: st.score, winner: st.winner, by: st.by, so: st.so, rc: st.rc };
    return { tuples: events.map((x, i) => [i + 1, x.at, x.t, x.p, x.p2, x.st.sc, x.st.so]), final };
  };

  it("200 seeds: identical event tuples, final state and RNG draw count", () => {
    const manifest = [];
    for (let seed = 1000; seed < 1200; seed++) manifest.push(run(seed));
    const digest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    expect(digest, "200-seed authoritative outcome manifest differs from the #195 balance baseline").toBe(BASE_SHA256);
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
