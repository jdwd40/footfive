/**
 * Issue #215: cosmetic half-chances in midfield minutes. When play has gone a while without a chance, a minute's spare time may carry
 * a cross headed clear, a ball in behind too heavy for the keeper, or a last-ditch slide on the edge of the box: three `cos: 1` rows
 * with `hc` (delivery, the defending side's answer, back off the boards). They draw from their own seed+minute stream and never
 * touch the real match — cosmeticShots.test.ts pins every real payload and state against the original engine; here: their shape,
 * that prices never suspend for them, how often they come, and how their scenes end.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MatchEvent, Side } from "../lib/pocketbase";
import { HALF_CHANCE_FLASH, sceneFor, type Pt } from "./scenes";
import { frameAt, type Lineups } from "./sim";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const mkt = lib("markets.js") as { fixtureState: (fx: unknown, st: unknown, now: number) => { phase: string; closed: string | null } };
const world = lib("worldService.js") as { lastPublished: (app: unknown, id: string, now: number) => MatchEvent | null };
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");

type Player = { name: string; no: number; role: string; is_starter: boolean; sentOff: boolean };
type State = { seed: number; rc: number; phase: string; nextAt: number; lastChance?: number; teams: Record<Side, { players: Player[] }> };
const team = (i: number) => {
  const t = TEAMS[i];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) };
};
const LIVE = eng.buildTiming(6000, 1); // production pace (#195)
const match = (seed: number, timing = LIVE): State => eng.createMatch({ fixtureId: "f" + seed, seed, kickoffAt: 0, home: team(seed % 16), away: team((seed * 7 + 3) % 16), timing });
const other = (s: Side): Side => (s === "home" ? "away" : "home");
const along = (side: Side, p: number[]) => (side === "home" ? p[0] : 100 - p[0]);
const noClock = (st: MatchEvent["st"]) => ({ ...st, clk: undefined });

const runs = Array.from({ length: 200 }, (_, i) => {
  const st = match(2000 + i);
  return { st, events: eng.advanceTo(st, 1e13) as MatchEvent[] };
});
/** Each half-chance with its neighbouring real events. */
const groups = runs.flatMap(({ st, events }) =>
  events.flatMap((e, i) => (e.hc && e.t !== "clearance" && e.t !== "bounce" ? [{ st, events, before: events[i - 1], rows: events.slice(i, i + 3), after: events[i + 3] }] : [])),
);
const DELIVERY = { head: "cross", keeper: "through_ball", slide: "pass" } as const;

describe("half-chance rows (issue #215)", () => {
  it("delivery, answer, back off the boards: cosmetic, no chain, never major or ticker, only between real open play and the next real event", () => {
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.length * 3).toBe(runs.flatMap(({ events }) => events).filter((e) => e.hc).length);
    for (const { before, rows, after } of groups) {
      const kind = rows[0].hc!;
      expect(rows.map((e) => e.t)).toEqual([DELIVERY[kind], "clearance", "bounce"]);
      for (const e of rows) {
        expect(e).toMatchObject({ cos: 1, hc: kind, min: before.min });
        for (const k of ["chain", "major", "tick", "pen", "kick", "turn"] as const) expect(e[k], `${e.t} #${e.seq} ${k}`).toBeUndefined();
      }
      expect(before.cos).toBeUndefined();
      expect(["pass", "tackle", "interception", "bounce"]).toContain(before.t);
      expect(after.cos).toBeUndefined();
      expect(after.min > before.min || ["half_time", "end_of_normal_time", "et_half_time", "shootout_start", "match_end"].includes(after.t), `#${after.seq} ${after.t}`).toBe(true);
      expect(after.at - rows[2].at).toBeGreaterThanOrEqual(0.1 * LIVE.minuteMs);
    }
    for (const kind of ["head", "keeper", "slide"]) expect(groups.some(({ rows }) => rows[0].hc === kind), kind).toBe(true);
  });

  it("each row carries the last real snapshot with danger off, so prices never suspend for one", () => {
    for (const { before, rows } of groups) {
      for (const e of rows) {
        expect(noClock(e.st)).toEqual(noClock(before.st));
        expect(e.st.d).toBe(0);
        expect(e.st.clk?.run).toBe(1);
        expect(mkt.fixtureState({ status: "live", kickoffAt: 0 }, e.st, e.at).closed).toBeNull();
      }
    }
  });

  it("the server prices on real play while a half-chance publishes (lastPublished is the real event before it)", () => {
    const { events } = runs.find((r) => r.events.filter((e) => e.hc).length >= 15)!;
    const records = events.map((e) => ({ get: (k: string) => (k === "fixture" ? "fx" : k === "seq" ? e.seq : k === "at" ? e.at : JSON.stringify(e)) }));
    const app = {
      findRecordsByFilter: (_c: string, _f: string, _s: string, limit: number, offset: number, p: { n: number }) =>
        records.filter((r) => Number(r.get("at")) <= p.n).sort((a, b) => Number(b.get("seq")) - Number(a.get("seq"))).slice(offset, offset + limit),
    };
    for (const e of events.filter((x) => x.hc)) {
      const real = events.filter((x) => !x.cos && x.at <= e.at).at(-1)!;
      expect(world.lastPublished(app, "fx", e.at), `#${e.seq}`).toEqual(real);
      expect(real.st.d).toBe(0);
    }
  });

  it("the defending side (or keeper) answers it; the ball comes back to the side and spot real play left it", () => {
    for (const { st, before, rows, events } of groups) {
      const [delivery, answer, back] = rows;
      const side = before.side as Side;
      const def = other(side);
      expect(delivery.side).toBe(side);
      expect(delivery.from).toEqual(before.ball);
      expect(along(side, delivery.ball!)).toBeGreaterThan(along(side, before.ball!));
      expect(answer.side).toBe(def);
      expect(answer.p2).toBe(delivery.p2);
      const role = st.teams[def].players.find((p) => p.name === answer.p)!.role;
      expect(role === "gk").toBe(delivery.hc === "keeper");
      expect(back.side).toBe(side);
      expect(back.ball).toEqual(before.ball);
      const [x, y] = back.from!;
      expect(x === 0 || x === 100 || y === 0 || y === 64, `off a board ${back.from}`).toBe(true);
      // Real, active players of the right sides (none sent off before it).
      const off = new Set(events.filter((e) => e.t === "red_card" && e.seq < delivery.seq).map((e) => e.side + ":" + e.p));
      for (const [s, name] of [[side, delivery.p], [side, delivery.p2], [def, answer.p], [side, back.p]] as [Side, string][]) {
        expect(st.teams[s].players.some((p) => p.name === name && p.is_starter) && !off.has(s + ":" + name), `${s} ${name}`).toBe(true);
      }
    }
  });

  it("about 6–8 a match at the live pace, and the longest gap between chances is under 9 minutes; none at a 1 s test pace", () => {
    const chanceAt = (e: MatchEvent) => e.st.clk!.s / 60;
    const per = runs.map(({ events }) => events.filter((e) => e.t === "clearance").length);
    const mean = per.reduce((a, b) => a + b, 0) / per.length;
    expect(mean).toBeGreaterThanOrEqual(6);
    expect(mean).toBeLessThanOrEqual(8);
    const gaps = runs.map(({ events }) => {
      const ts = events.filter((e) => e.min <= 90 && ((e.t === "shot" || e.t === "penalty_setup" || e.t === "clearance") && e.st.clk)).map(chanceAt);
      return Math.max(...ts.slice(1).map((t, i) => t - ts[i]));
    });
    expect(gaps.reduce((a, b) => a + b, 0) / gaps.length).toBeLessThanOrEqual(9);
    for (let seed = 2000; seed < 2050; seed++) expect((eng.advanceTo(match(seed, eng.buildTiming(1000, 1)), 1e13) as MatchEvent[]).some((e) => e.hc)).toBe(false);
  });

  it("its stream is its own: replaying from a saved state mid-match gives the same rows, the real RNG counter untouched", () => {
    const { st: done, events } = runs.find((r) => r.events.some((e) => e.hc && e.min > 40))!;
    const st = match(done.seed);
    eng.advanceTo(st, 40 * LIVE.minuteMs);
    const saved = JSON.parse(JSON.stringify(st));
    const rest = eng.advanceTo(saved, 1e13) as MatchEvent[];
    expect(rest.some((e) => e.hc)).toBe(true);
    expect(rest).toEqual(events.slice(events.length - rest.length));
    expect(saved.rc).toBe(done.rc);
  });
});

describe("half-chance scenes (issue #215)", () => {
  const lineups = (st: State) => Object.fromEntries((["home", "away"] as Side[]).map((s) => [s, st.teams[s].players.map((p) => ({ name: p.name, no: p.no, role: p.role, starter: p.is_starter }))])) as Lineups;

  it("each answer shows its badge, and ends with the defending side (the keeper, when too heavy) on the ball where the engine left it", () => {
    for (const { st, events, rows } of groups.slice(0, 120)) {
      let prev: Pt = [50, 32];
      for (const e of events.slice(0, events.indexOf(rows[1]))) prev = sceneFor(e, prev, LIVE.minuteMs)?.ball.at(-1) ?? prev;
      const answer = rows[1];
      const s = sceneFor(answer, prev, LIVE.minuteMs)!;
      expect(s.flash).toBe(HALF_CHANCE_FLASH[answer.hc!]);
      expect(s.ball.at(-1)).toEqual(answer.ball);
      const f = frameAt(s, 1, lineups(st));
      const def = answer.side as Side;
      expect(f.carrier?.startsWith(def + ":"), `${answer.hc} #${answer.seq}`).toBe(true);
      const holder = f.players.find((p) => p.side + ":" + p.no === f.carrier)!;
      expect(holder.gk).toBe(answer.hc === "keeper");
      expect(Math.hypot(holder.x - answer.ball![0], holder.y - answer.ball![1])).toBeLessThan(3);
    }
  });
});
