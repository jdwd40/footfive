/**
 * Issue #73: more shots, not more goals. In a minute's spare time the engine may add a cosmetic long-range attempt —
 * shot, then miss or block, then the ball back off the boards — flagged `cos: 1`. It draws only from its own
 * minute-keyed stream, so the real match is the original engine's to the byte; cards, prices and quotes anchor on real play.
 *
 * Transport projection (the only normalisation used here): `match_events.seq` is an integer cursor, so a cosmetic row
 * takes the next integer and later real rows' `seq` — and `chain`, which is the seq of its move's build_up — move up by the
 * cosmetic rows before them. Comparing with the original engine therefore drops `cos` rows, renumbers the real rows 1..n
 * in order, maps each `chain` to its build_up's new number and subtracts the cosmetic count from the final state's `seq`.
 * Every other field of every real event — `at`, clock, players, positions, text, snapshot — and the rest of the final
 * state, RNG counter included, must be identical, as must the match state after every step (transport counters aside).
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clockSeconds } from "../lib/live";
import type { MatchEvent, MatchView, Side } from "../lib/pocketbase";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const world = lib("worldService.js") as {
  matchView: (app: unknown, id: string, since: number, userId: string, throughMs?: number) => MatchView;
  lastPublished: (app: unknown, id: string, now: number) => MatchEvent | null;
  publishedEvents: (app: unknown, id: string, now: number, since: number, limit: number) => MatchEvent[];
};
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");

/** Pre-#73 engine (git 2a17bda, identical to the lead's captured matchEngine-before.cjs), 200 seeds at the live 8 s pace. */
const ORIGINAL = {
  /** engine.test.ts pin: event tuples + final score/winner/by/shootout/rc. Same constant, same projection. */
  pin: "eef854d6f94f24c999783c2d6454d144d9fd16546e66a7fcddebd0b36ca2395b",
  /** Every field of every event plus the whole final state. */
  full: "e8da709c2894b3e5b1d2c79f40082ad238d7b2905ca2cafe4a92173cd38b0909",
  /** The whole match state after every step, saved and reloaded between steps, without `seq` and `lastAt`. */
  steps: "8014fab6860c030dbb20cb2019da1a0fed741158d02e373a452f75b1abd5240a",
};

type Ev = MatchEvent & { long?: number; high?: number };
type State = { seq: number; lastAt?: number; phase: string; nextAt: number; minute: number; score: [number, number]; winner: string | null; by: string | null; so: unknown; rc: number; ball: [number, number]; bs: Side | null; timing: Record<string, number>; teams: Record<Side, { players: Array<{ name: string; role: string; is_starter: boolean; sentOff: boolean }> }> };
const team = (i: number) => {
  const t = TEAMS[i];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) };
};
const LIVE = eng.buildTiming(8000, 1);
const match = (seed: number, timing = LIVE): State => eng.createMatch({ fixtureId: "f" + seed, seed, kickoffAt: 0, home: team(seed % 16), away: team((seed * 7 + 3) % 16), timing });
const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const along = (side: Side, p: number[]) => (side === "home" ? p[0] : 100 - p[0]);
const other = (side: Side): Side => (side === "home" ? "away" : "home");
const cosmetic = (e: Ev) => e.cos === 1;
const noClock = (st: MatchEvent["st"]) => {
  const c: Partial<MatchEvent["st"]> = { ...st };
  delete c.clk;
  return c;
};

/** The transport projection described above: real rows only, integer seq/chain canonicalised, final seq less the cosmetic rows. */
function project(events: Ev[], st: State) {
  const real = events.filter((e) => !cosmetic(e));
  const renumber = new Map(real.map((e, i) => [e.seq, i + 1]));
  const out = real.map((e) => {
    const c = structuredClone(e); // key order kept: values are replaced in place
    c.seq = renumber.get(e.seq)!;
    if (c.chain !== undefined) c.chain = renumber.get(e.chain!)!;
    return c;
  });
  const final = structuredClone(st);
  final.seq = st.seq - (events.length - real.length);
  return { out, final };
}

const SEEDS = Array.from({ length: 200 }, (_, i) => 1000 + i);
const runs = SEEDS.map((seed) => {
  const st = match(seed);
  const events = eng.advanceTo(st, 1e13) as Ev[];
  return { seed, st, events };
});

describe("cosmetic attempts never change the real match (issue #73)", () => {
  it("200 seeds at the live pace: every real event's full payload and the final state are the original engine's", () => {
    const pin = [];
    const full = [];
    for (const { st, events } of runs) {
      const { out, final } = project(events, st);
      pin.push({ tuples: out.map((x) => [x.seq, x.at, x.t, x.p, x.p2, x.st.sc, x.st.so]), final: { score: st.score, winner: st.winner, by: st.by, so: st.so, rc: st.rc } });
      full.push({ ev: out, final });
    }
    expect(sha(pin), "engine.test.ts pin").toBe(ORIGINAL.pin);
    expect(sha(full), "full real payload + final state").toBe(ORIGINAL.full);
  });

  it("saved and reloaded every step: the same stream, cosmetic rows included, and the original match state after every step", () => {
    const steps = createHash("sha256");
    for (const { seed, events } of runs) {
      let st = match(seed);
      const split: Ev[] = [];
      while (st.phase !== "finished") {
        split.push(...(eng.advanceTo(st, st.nextAt) as Ev[]));
        const saved = JSON.parse(JSON.stringify(st));
        delete saved.seq;
        delete saved.lastAt;
        steps.update(JSON.stringify(saved));
        st = JSON.parse(JSON.stringify(st));
        if (st.nextAt === null) st.nextAt = Infinity;
      }
      expect(JSON.stringify(split), `seed ${seed}`).toBe(JSON.stringify(events));
    }
    expect(steps.digest("hex"), "state after every step: stats, score, ball, possession, counter, RNG, nextAt, wear").toBe(ORIGINAL.steps);
  });

  it("an old saved state (legacy timing, no new fields) resumes with the identical stream, cosmetics included", () => {
    expect(Object.keys(match(1000))).toEqual(["v", "fx", "seed", "rc", "seq", "timing", "teams", "phase", "minute", "nextAt", "score", "so", "stats", "possMin", "ball", "bs", "counter", "pending", "danger", "winner", "by", "finishedAt"]);
    const st = match(1000);
    eng.advanceTo(st, 30 * LIVE.minuteMs);
    const twin = JSON.parse(JSON.stringify(st));
    const legacy = JSON.parse(JSON.stringify(st));
    delete legacy.timing.resultHoldMs;
    delete legacy.timing.kickoffHoldMs;
    const a = eng.advanceTo(legacy, 1e13) as Ev[];
    const b = eng.advanceTo(twin, 1e13) as Ev[];
    expect(a).toEqual(b);
    expect(a.some(cosmetic)).toBe(true);
  });
});

describe("cosmetic rows (issue #73)", () => {
  const all = runs.map(({ events }) => events);
  /** Each attempt with its neighbouring real events. */
  const attempts = all.flatMap((events) =>
    events.flatMap((e, i) => (cosmetic(e) && e.t === "shot" ? [{ before: events[i - 1], rows: events.slice(i, i + 3), after: events[i + 3], events }] : [])),
  );

  it("transport: unique integer seq in order, publication time never goes back, cosmetic rows only between real ones", () => {
    for (const events of all) {
      events.forEach((e, i) => {
        expect(e.seq).toBe(i + 1);
        if (i) expect(e.at).toBeGreaterThanOrEqual(events[i - 1].at);
      });
      expect(cosmetic(events[0]) || cosmetic(events[events.length - 1])).toBe(false);
    }
    // Every cosmetic row belongs to exactly one shot → miss|block → bounce run.
    expect(attempts.length * 3).toBe(all.flat().filter(cosmetic).length);
  });

  it("flagged, never a goal, no chain, never major or ticker; both misses and blocks", () => {
    for (const { rows } of attempts) {
      expect(rows.map((e) => e.t)).toEqual(["shot", rows[1].t === "miss" ? "miss" : "block", "bounce"]);
      for (const e of rows) {
        expect(e.cos).toBe(1);
        for (const k of ["chain", "major", "tick", "pen", "kick"] as const) expect(e[k], `${e.t} #${e.seq} ${k}`).toBeUndefined();
      }
      expect(rows[0]).toMatchObject({ from: null, header: 0 });
    }
    expect(attempts.some(({ rows }) => rows[1].t === "miss")).toBe(true);
    expect(attempts.some(({ rows }) => rows[1].t === "block")).toBe(true);
  });

  it("each row carries the last real snapshot — score, stats, shootout, danger — with its own running clock", () => {
    for (const { before, rows, after } of attempts) {
      const real = noClock(before.st);
      for (const e of rows) {
        const clk = e.st.clk;
        expect(noClock(e.st), `#${e.seq}`).toEqual(real);
        expect(e.st.d).toBe(0);
        // Its own fraction of the same minute, running: the shown clock never steps back into it or out of it.
        expect(clk?.run).toBe(1);
        expect(clk!.s).toBeGreaterThanOrEqual((e.min - 1) * 60);
        expect(clk!.s).toBeLessThanOrEqual((e.min - 1) * 60 + 59);
      }
      const shown = (row: Ev, now: number) => clockSeconds(row.st, row.at, now, LIVE.minuteMs);
      const chain = [before, ...rows, ...(after.st.clk ? [after] : [])]; // a shootout start carries no clock
      for (let i = 1; i < chain.length; i++) expect(shown(chain[i], chain[i].at)!, `#${chain[i].seq}`).toBeGreaterThanOrEqual(shown(chain[i - 1], chain[i].at)!);
    }
  });

  it("each attempt sits in the minute's spare time after open play and leaves room for the next real event; a miss is held", () => {
    const hold = LIVE.resultHoldMs;
    for (const { before, rows, after } of attempts) {
      const [shot, result, back] = rows;
      expect(["pass", "tackle", "interception", "bounce"]).toContain(before.t);
      for (const e of rows) expect(e.min).toBe(before.min);
      expect(shot.at - before.at, `#${shot.seq}`).toBeGreaterThanOrEqual(0.1 * LIVE.minuteMs);
      expect(after.at - back.at, `#${back.seq}`).toBeGreaterThanOrEqual(0.1 * LIVE.minuteMs);
      if (result.t === "miss") expect(back.at - result.at).toBeGreaterThanOrEqual(hold);
      // The next real event starts the next minute (or closes the period): the attempt never splits a real move.
      expect(after.min > before.min || ["half_time", "end_of_normal_time", "et_half_time", "shootout_start", "match_end"].includes(after.t), `#${after.seq} ${after.t}`).toBe(true);
    }
  });

  it("possession and ball come back exactly: the side that had it, on the spot real play left it, so nothing snaps", () => {
    for (const { before, rows, events } of attempts) {
      const [shot, result, back] = rows;
      const side = before.side as Side;
      expect(shot.side).toBe(side);
      expect(back.side).toBe(side);
      expect(back.ball).toEqual(before.ball);
      // The next real move starts from that spot (fouls, cards and coaching in between leave the ball where it is).
      const k = events.indexOf(back) + 1;
      const j = events.findIndex((e, i) => i >= k && !["coaching", "foul", "yellow_card", "red_card"].includes(e.t));
      if (["pass", "build_up"].includes(events[j].t)) expect(events[j].from, `#${events[j].seq}`).toEqual(back.ball);
      // A real try from distance: forward of where play was, outside the box; the ball comes back off a board.
      expect(along(side, shot.ball!)).toBeGreaterThan(along(side, before.ball!));
      expect(along(side, shot.ball!)).toBeLessThan(84);
      const [x, y] = back.from!;
      expect(x === 0 || x === 100 || y === 0 || y === 64, `bounce off a board ${back.from}`).toBe(true);
      if (result.t === "miss") {
        expect(result).toMatchObject({ side, p: shot.p, from: shot.ball });
        expect(along(side, result.target!)).toBe(100);
        if (!result.high) expect(result.target![1] < 28 || result.target![1] > 36).toBe(true);
      } else {
        expect(result).toMatchObject({ side: other(side), p2: shot.p, from: shot.ball });
        expect(along(side, result.ball!)).toBeGreaterThan(along(side, shot.ball!));
      }
      // Real, active outfielders of the right teams (none already sent off).
      const off = new Set(events.filter((e) => e.t === "red_card" && e.seq < shot.seq).map((e) => e.side + ":" + e.p));
      const st = runs.find((r) => r.events === events)!.st;
      const outfield = (s: Side, name?: string) => st.teams[s].players.some((p) => p.name === name && p.is_starter && p.role !== "gk") && !off.has(s + ":" + name);
      expect(outfield(side, shot.p)).toBe(true);
      expect(outfield(side, back.p)).toBe(true);
      if (result.t === "block") expect(outfield(other(side), result.p)).toBe(true);
    }
  });

  it("spectacle stays moderate: about four or five extra attempts a match at the live pace; none at a 1 s test pace", () => {
    const per = all.map((events) => events.filter((e) => cosmetic(e) && e.t === "shot").length);
    const mean = per.reduce((a, b) => a + b, 0) / per.length;
    expect(mean).toBeGreaterThan(3);
    expect(mean).toBeLessThan(6);
    expect(Math.max(...per)).toBeLessThanOrEqual(15);
    for (let seed = 1000; seed < 1050; seed++) expect((eng.advanceTo(match(seed, eng.buildTiming(1000, 1)), 1e13) as Ev[]).some(cosmetic)).toBe(false);
  });
});

// ------------------------------------------------------------------ server consumers

const row = (id: string, data: Record<string, unknown>) => ({ id, get: (key: string) => data[key] });
/** PocketBase stand-in honouring the filters, ordering, offset and limit these reads use. No writes. */
function appFor(events: Ev[]) {
  const teams = Array.from({ length: 16 }, (_, i) => row(`team${i}`, { slug: `test${i}`, abbreviation: `T${i}` }));
  const fx = row("fx1", { round: "r1", status: "live", home_team: "team0", away_team: "team1", scheduled_at: new Date(0).toISOString(), match_minute_real_ms: LIVE.minuteMs, model_json: JSON.stringify({ lh: 0.021, la: 0.017 }) });
  const round = row("r1", { round_key: "r16", status: "live" });
  const rows = events.map((e) => row(`e${e.seq}`, { fixture: "fx1", seq: e.seq, at: e.at, type: e.t, data: JSON.stringify(e) }));
  return {
    findCollectionByNameOrId: (name: string) => ({ name }),
    findRecordById: (name: string, id: string) => {
      if (name === "shared_fixtures" && id === fx.id) return fx;
      if (name === "shared_rounds" && id === round.id) return round;
      throw new Error(`Unexpected lookup ${name}/${id}`);
    },
    findRecordsByFilter: (name: string, filter: string, sort: string, limit: number, offset: number, params: Record<string, number | string> = {}) => {
      if (name === "world") return [row("world", {})];
      if (name === "proball_teams") return filter.includes("manager") ? [] : teams;
      if (name === "global_team_records") return teams;
      if (name === "match_states") return [];
      if (name !== "match_events") throw new Error(`Unexpected query ${name}`);
      let found = rows.filter((r) => r.get("fixture") === params.f && Number(r.get("at")) <= Number(params.n));
      if (filter.includes("seq >")) found = found.filter((r) => Number(r.get("seq")) > Number(params.s));
      if (filter.includes('type = "red_card"')) found = found.filter((r) => r.get("type") === "red_card");
      found.sort((a, b) => (Number(a.get("seq")) - Number(b.get("seq"))) * (sort === "-seq" ? -1 : 1));
      return found.slice(offset, offset + limit);
    },
    save: () => {
      throw new Error("reads must not write");
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("cards, prices and quotes anchor on real play (issue #73)", () => {
  const busy = runs.find(({ events }) => events.filter((e) => cosmetic(e) && e.t === "shot").length >= 5);
  const { events } = busy ?? runs[0];
  const real = events.filter((e) => !cosmetic(e));
  const withCos = appFor(events);
  const without = appFor(real);
  const lastReal = (now: number) => real.filter((e) => e.at <= now).at(-1)!;
  const cosTimes = events.filter(cosmetic).flatMap((e) => [e.at, e.at + 1, e.at + Math.round(LIVE.minuteMs / 10)]);

  it("lastPublished skips cosmetic rows: the real seq, snapshot and clock anchor while an attempt plays", () => {
    expect(busy, "a match with at least five attempts").toBeDefined();
    expect(cosTimes.length).toBeGreaterThan(30);
    for (const now of cosTimes) expect(world.lastPublished(withCos, "fx1", now), `now ${now}`).toEqual(lastReal(now));
  });

  it("the fixture card and its prices are identical with or without cosmetic rows; match history still serves them", () => {
    vi.useFakeTimers();
    for (const now of cosTimes) {
      vi.setSystemTime(now);
      const a = world.matchView(withCos, "fx1", 0, "user");
      const b = world.matchView(without, "fx1", 0, "user");
      expect(a.fixture, `now ${now}`).toEqual(b.fixture);
      expect(a.fixture.odds).toBeTruthy();
      expect(a.fixture.seq).toBe(lastReal(now).seq);
    }
    vi.setSystemTime(events[events.length - 1].at);
    const page = world.matchView(withCos, "fx1", events.find(cosmetic)!.seq - 1, "user");
    expect(page.events.some((e) => e.cos === 1)).toBe(true);
  });

  it("a quote taken before an attempt still validates after its rows publish (the bet check's seq is unchanged)", () => {
    for (const shot of events.filter((e) => cosmetic(e) && e.t === "shot")) {
      const priced = world.lastPublished(withCos, "fx1", shot.at - 1)!.seq; // what fixtureCtx priced
      const i = events.indexOf(shot);
      for (const e of events.slice(i, i + 3)) expect(world.lastPublished(withCos, "fx1", e.at)!.seq, `#${e.seq}`).toBe(priced);
    }
  });

  it("settlement and summaries read the real final snapshot", () => {
    const tail = world.publishedEvents(withCos, "fx1", 9e15, 0, 2000);
    expect(tail.at(-1)).toEqual(real.at(-1));
    expect(tail.at(-1)!.t).toBe("match_end");
  });
});
