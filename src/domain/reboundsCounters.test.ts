/**
 * #219: game state. A side trailing from 70' attacks in more of its possession minutes; a side that won the ball can break at
 * once (a counter-attack: `ctr` on the build-up, one or two passes, then a progression); a parried save or a loose block can
 * fall to an attacker for a second shot in the same chain (`loose` on the result, `reb` on the shot), with markets suspended
 * throughout; and the in-play odds model walks the remaining minutes through those game states.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sampleN, sceneFor, short, type Pt, type Scene } from "./scenes";
import { frameAt, type Lineups } from "./sim";
import type { MatchEvent, Side } from "../lib/pocketbase";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const odds = lib("odds.js");
const mkt = lib("markets.js");
const { BALANCE } = lib("balance.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");

const PROGRESSIONS = new Set(["through_ball", "dribble", "cross"]);
const along = (side: Side, x: number) => (side === "home" ? x : 100 - x);
const end = (s: Scene): Pt => s.ball[s.ball.length - 1];
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const team = (t: (typeof TEAMS)[number], ai = true) => ({ id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players), ai });
/** The balance runs' fixtures (engine-calibrate --pairs all): every ordered pairing, 6 s minutes. */
const pairing = (i: number) => [TEAMS[i % 16], TEAMS[(i % 16 + 1 + (Math.floor(i / 16) % 15)) % 16]];

type Played = { events: MatchEvent[]; lineups: Lineups; st: { score: number[]; winner: Side } };
function play(n: number, prefix: string): Played[] {
  const out: Played[] = [];
  for (let i = 0; i < n; i++) {
    const [a, b] = pairing(i);
    const st = eng.createMatch({ fixtureId: prefix + i, seed: eng.hashSeed(prefix + i), kickoffAt: 0, home: team(a), away: team(b), timing: eng.buildTiming(6000, 1) });
    const events: MatchEvent[] = eng.advanceTo(st, Infinity);
    const lineups = Object.fromEntries((["home", "away"] as Side[]).map((s) => [s, st.teams[s].players.map((p: { name: string; no: number; role: string; is_starter: boolean }) => ({ name: p.name, no: p.no, role: p.role, starter: p.is_starter }))])) as Lineups;
    out.push({ events: events.filter((e) => !e.cos), lineups, st });
  }
  return out;
}

describe("counter-attacks and rebounds (issue #219)", () => {
  const matches = play(240, "rc");
  const all = matches.flatMap((m) => m.events);
  const counters = matches.flatMap(({ events }) => events.flatMap((e, i) => (e.t === "build_up" && e.ctr ? [{ e, i, events }] : [])));
  const loose = matches.flatMap(({ events, lineups }) => events.flatMap((e, i) => (e.loose ? [{ e, reb: events[i + 1], res: events[i + 2], events, lineups, i, shots: events.filter((x) => x.chain === e.chain && x.t === "shot").length }] : [])));

  it("plays one to three counter-attacks and one to two rebound shots a match", () => {
    expect(counters.length / matches.length).toBeGreaterThan(1);
    expect(counters.length / matches.length).toBeLessThan(3);
    const rebounds = all.filter((e) => e.t === "shot" && e.reb).length;
    expect(rebounds / matches.length).toBeGreaterThan(1);
    expect(rebounds / matches.length).toBeLessThan(2);
  });

  it("a counter breaks from where the ball was won: one or two forward passes, then a progression into the final third", () => {
    const shapes = new Set<string>();
    for (const { e, i, events } of counters) {
      const side = e.side as Side;
      // The turnover (or save) that won it, last minute: the last row before it that moved the ball (fouls, cards and stance
      // changes this minute come in between).
      let w = i - 1;
      while (["foul", "yellow_card", "red_card", "coaching"].includes(events[w].t)) w--;
      const won = events[w];
      expect(won.side, `#${e.seq}`).toBe(side);
      expect(e.from, `#${e.seq}`).toEqual(won.ball);
      expect(won.min, `#${e.seq}`).toBe(e.min - 1);
      const chain = events.filter((x) => x.chain === e.chain); // chains are numbered per match
      const prog = chain.findIndex((x) => PROGRESSIONS.has(x.t));
      expect(prog, `#${e.seq}`).toBeGreaterThan(0);
      const passes = chain.slice(1, prog);
      expect(passes.length).toBeGreaterThanOrEqual(1);
      expect(passes.length).toBeLessThanOrEqual(2);
      let x = along(side, e.ball![0]);
      for (const p of passes) {
        expect(p.t).toBe("pass");
        expect(along(side, p.ball![0]), `pass #${p.seq}`).toBeGreaterThanOrEqual(Math.min(x + 11, 69)); // a long stride forward (to x 70 at most)
        x = along(side, p.ball![0]);
      }
      expect(along(side, chain[prog].ball![0])).toBeGreaterThanOrEqual(74);
      expect(chain.some((x) => x.t === "shot" && x.long)).toBe(false);
      for (const x of chain) shapes.add(x.t);
    }
    for (const t of ["goal", "save", "miss", "block", "tackle", "interception", "cross", "through_ball", "dribble"]) expect(shapes.has(t), t).toBe(true);
    // Ordinary build-ups are as before: two to four passes, from deep.
    const plain = all.filter((e) => e.t === "build_up" && !e.ctr);
    expect(plain.length).toBeGreaterThan(counters.length * 5);
  });

  it("a counter converts more often than an ordinary attack", () => {
    // Chains are numbered per match: count shots (first shots only) per build-up within each match.
    const n = { ctr: [0, 0], plain: [0, 0] };
    for (const { events } of matches) {
      const shot = new Set(events.filter((x) => x.t === "shot" && !x.reb).map((x) => x.chain));
      for (const e of events) if (e.t === "build_up") {
        const k = e.ctr ? n.ctr : n.plain;
        k[0]++;
        k[1] += shot.has(e.chain) ? 1 : 0;
      }
    }
    expect(n.ctr[1] / n.ctr[0]).toBeGreaterThan((n.plain[1] / n.plain[0]) * 1.1);
  });

  it("a parried save or a loose block falls to an attacker for one second shot in the same chain, from where it dropped", () => {
    const kinds = new Set<string>();
    expect(loose.length).toBeGreaterThan(200);
    for (const { e, reb, res, shots } of loose) {
      expect(["save", "block"]).toContain(e.t);
      kinds.add(e.t);
      expect(reb).toMatchObject({ t: "shot", reb: 1, chain: e.chain, side: e.side === "home" ? "away" : "home", seq: e.seq + 1 });
      expect(reb.ball).toEqual(e.ball);
      const atk = reb.side as Side;
      expect(along(atk, reb.ball![0])).toBeGreaterThanOrEqual(62);
      expect(["goal", "save", "block", "miss", "woodwork"]).toContain(res.t);
      expect(res.loose).toBeUndefined(); // never a third shot
      expect(shots).toBe(2);
    }
    expect([...kinds].sort()).toEqual(["block", "save"]);
    // Stats: both shots count, the parry is a save.
    const st = matches[0].st as unknown as { stats: Record<Side, { sh: number }> };
    const ev = matches[0].events;
    expect(st.stats.home.sh + st.stats.away.sh).toBe(ev.filter((x) => x.t === "shot" || x.t === "penalty_setup").length);
  });

  it("keeps markets suspended from the first shot through the rebound, and reopens them with its result", () => {
    const fx = { status: "live", kickoffAt: 0 };
    for (const { e, reb, res } of loose) {
      for (const x of [e, reb]) {
        expect(x.st.d, `${x.t} #${x.seq}`).toBe(1);
        expect(mkt.fixtureState(fx, x.st, 1).closed).toBe("Suspended — incident in progress");
      }
      if (res.t === "goal") expect(res.st.d).toBe(1); // through the celebration to the restart, as any goal
      else expect(mkt.fixtureState(fx, res.st, 1).closed, `${res.t} #${res.seq}`).toBeNull();
    }
  });

  it("gives the loose save or block scene its time before the rebound is struck, at the 6 s pace", () => {
    for (const { e, reb } of loose) {
      const s = sceneFor(e, e.from as Pt, 6000, reb)!;
      expect(reb.at - e.at, `${e.t} #${e.seq}`).toBeGreaterThanOrEqual(s.ms);
    }
  });

  it("draws the loose ball to the engine's spot and the rebound's taker onto it, without a teleport", () => {
    let checked = 0;
    for (const { e, reb, events, lineups, i } of loose.slice(0, 120)) {
      const prevShot = events[i - 1];
      expect(prevShot.t).toBe("shot");
      const shotScene = sceneFor(prevShot, prevShot.ball as Pt, 6000, e)!;
      const s = sceneFor(e, end(shotScene), 6000, reb, sampleN(shotScene.ballHeight, 1))!;
      expect(end(s), `#${e.seq}`).toEqual(e.ball);
      // The rebound's taker is the shooter himself or a labelled team-mate following in; he arrives next to the ball.
      const taker = s.actors.find((a) => a.side === reb.side && a.label === short(reb.p))!;
      expect(taker, `#${e.seq}`).toBeTruthy();
      expect(dist(taker.path.at(-1)!, e.ball as Pt)).toBeLessThan(2.5);
      // The keeper does not end up with a parried ball; a blocker does not win a loose one.
      if (e.t === "save") expect(dist(s.actors.find((a) => a.keeper)!.path.at(-1)!, e.ball as Pt)).toBeGreaterThan(5);
      const rs = sceneFor(reb, end(s), 6000, events[i + 2])!;
      expect(rs.ball[0]).toEqual(end(s)); // the second shot starts where the loose ball stopped
      let b = frameAt(shotScene, 1, lineups).ball;
      for (const sc of [s, rs]) {
        for (let k = 0; k <= 60; k++) {
          const f = frameAt(sc, k / 60, lineups);
          expect(dist(f.ball, b), `#${sc.seq} t=${k}/60`).toBeLessThan(4);
          b = f.ball;
        }
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("a trailing side shoots more from 70' (urgency), more than the shared Attack tempo alone", () => {
    const rate = { pre: [0, 0], late: [0, 0] };
    for (const { events } of matches) {
      let sc = [0, 0];
      let j = 0;
      const byMin = new Map<number, MatchEvent[]>();
      for (const e of events) byMin.set(e.min, [...(byMin.get(e.min) ?? []), e]);
      for (let m = 1; m <= 90; m++) {
        while (j < events.length && events[j].min < m) sc = events[j++].st.sc;
        if (sc[0] === sc[1]) continue;
        const side = sc[0] < sc[1] ? "home" : "away";
        const mine = byMin.get(m) ?? [];
        if (mine.find((e) => e.t === "build_up" || e.t === "pass")?.side !== side) continue;
        const r = m >= 70 ? rate.late : rate.pre;
        r[0]++;
        r[1] += mine.filter((e) => e.side === side && (e.t === "shot" || e.t === "penalty_setup")).length;
      }
    }
    const pre = rate.pre[1] / rate.pre[0];
    const late = rate.late[1] / rate.late[0];
    expect(late).toBeGreaterThan(0.26);
    expect(late / pre).toBeGreaterThan(1.3);
  });
});

describe("in-play odds with game states (issue #219)", () => {
  const [a, b] = [TEAMS[2], TEAMS[9]];
  const model = eng.inPlayModel(eng.createMatch({ fixtureId: "m", seed: 1, kickoffAt: 0, home: team(a), away: team(b) }));
  const legacy = { lh: model.lh, la: model.la };
  const live = (sc: number[], ph = "second_half") => ({ sc, ph, x: [[], []], d: 0, so: null });

  it("builds the kickoff model from the engine: kickoff rates plus each late game state, the trailing side attacking harder", () => {
    const r = eng.goalRates(eng.createMatch({ fixtureId: "m", seed: 1, kickoffAt: 0, home: team(a), away: team(b) }));
    expect(model.lh).toBe(Math.round(r.home * 1e6) / 1e6);
    expect(model.la).toBe(Math.round(r.away * 1e6) / 1e6);
    expect(model.at).toEqual({ chase: BALANCE.match.urgencyMinute, protect: 78, settle: 100 });
    expect(model.k).toEqual([0, 60, 120]);
    expect(Object.keys(model.r).sort()).toEqual(["L", "aT", "aT1", "hT", "hT1", "n"]);
    for (const key of Object.keys(model.r)) expect(model.r[key]).toHaveLength(6); // [h, a] at each sample minute
    expect([model.r.n[0], model.r.n[1]]).toEqual([model.lh, model.la]);
    const at = (key: string, k: number) => odds.stageRates(model, k, key === "hT" ? -2 : key === "hT1" ? -1 : key === "aT" ? 2 : key === "aT1" ? 1 : 0);
    expect(at("hT", 75)[0]).toBeGreaterThan(at("n", 75)[0] * 1.1); // home chasing
    expect(at("aT", 75)[1]).toBeGreaterThan(at("n", 75)[1] * 1.1);
    expect(at("hT", 75)[1]).toBeGreaterThan(at("n", 75)[1]); // ...and more open at the back (tempo, counters)
    expect(at("hT1", 80)[1]).toBeLessThan(at("hT", 80)[1]); // a side protecting a one-goal lead sits deep
    expect(odds.stageRates(model, 69, -1)).toEqual(odds.stageRates(model, 69, 0)); // before the chase the score does not matter
    expect(odds.stageRates(model, 70, -1)).not.toEqual(odds.stageRates(model, 70, 0));
    expect(odds.stageRates(model, 100, 0)).not.toEqual(odds.stageRates(model, 99, 0)); // level from 100′: both attack
    // Players tire: the gap between the sides narrows as the match goes on (interpolated between the sample minutes).
    const gap = (k: number) => odds.stageRates(model, k, 0)[0] / odds.stageRates(model, k, 0)[1];
    expect(gap(1)).toBeGreaterThan(1);
    expect(gap(90)).toBeLessThan(gap(1));
    const e60 = eng.goalRates(eng.createMatch({ fixtureId: "m", seed: 1, kickoffAt: 0, home: team(a), away: team(b) }), { minute: 60 });
    expect(odds.stageRates(model, 60, 0)).toEqual([Math.round(e60.home * 1e6) / 1e6, Math.round(e60.away * 1e6) / 1e6]);
  });

  it("prices fast exactly as the reference walk: every market probability within 1e-9, cached or not, red cards included", () => {
    let checked = 0;
    for (const [h, aw] of [[0, 15], [2, 9], [7, 8], [12, 3], [15, 0]]) {
      const m = eng.inPlayModel(eng.createMatch({ fixtureId: "m", seed: 1, kickoffAt: 0, home: team(TEAMS[h]), away: team(TEAMS[aw]) }));
      for (const [sc, min, ph, reds] of [
        [[0, 0], 0, "pre", [0, 0]], [[0, 0], 30, "first_half", [0, 0]], [[1, 0], 45, "half_time", [0, 0]], [[0, 2], 60, "second_half", [0, 1]],
        [[1, 1], 69, "second_half", [0, 0]], [[1, 1], 75, "second_half", [1, 0]], [[2, 1], 80, "second_half", [0, 0]], [[3, 3], 89, "second_half", [0, 0]],
        [[1, 1], 90, "second_half", [0, 0]], [[1, 1], 90, "et_break", [0, 0]], [[2, 2], 99, "extra_time_1", [0, 0]], [[2, 3], 104, "extra_time_2", [1, 1]], [[4, 0], 85, "second_half", [0, 0]],
      ] as [number[], number, string, number[]][]) {
        const st = { sc, ph, x: [[0, 0, 0, 0, 0, 0, reds[0]], [0, 0, 0, 0, 0, 0, reds[1]]], d: 0, so: null };
        for (const cached of [false, true]) {
          if (!cached) odds._clearCache();
          const ref = odds._ref.dist(m, st, min);
          const rn = odds._ref.next(m, st, min);
          const mp = odds.marketProbs(m, st, min);
          const tag = `${h}v${aw} ${sc} ${min}' ${ph} reds ${reds}${cached ? " cached" : ""}`;
          expect(Math.abs(mp.qualifyHome - ref.qualifyHome), tag).toBeLessThan(1e-9);
          expect(Math.abs(odds.finalDist(m, st, min, true).qualifyHome - ref.qualifyHome), tag).toBeLessThan(1e-9);
          for (let i = 0; i <= 5; i++)
            for (let j = 0; j <= 5; j++) {
              const k = `${sc[0] + i}-${sc[1] + j}`;
              expect(Math.abs((mp.exact[k] ?? 0) - (ref.dist[k] ?? 0)), `${tag} exact ${k}`).toBeLessThan(1e-9);
            }
          for (const side of ["home", "away"])
            for (let n = 1; n <= 3; n++) {
              let p = 0;
              for (const k in ref.dist) {
                const [x, y] = k.split("-").map(Number);
                if ((side === "home" ? x - y : y - x) === n) p += ref.dist[k];
              }
              expect(Math.abs(mp.margin[side + n] - p), `${tag} margin ${side}${n}`).toBeLessThan(1e-9);
            }
          for (const s2 of ["home", "away", "none"]) expect(Math.abs(mp.next[s2] - rn[s2]), `${tag} next ${s2}`).toBeLessThan(1e-9);
          checked++;
        }
      }
    }
    expect(checked).toBe(130);
  });

  it("a side its manager runs keeps its kickoff stance in every game state; urgency still applies", () => {
    const managed = { ...team(a, false), stance: "defend" };
    const m = eng.inPlayModel(eng.createMatch({ fixtureId: "m", seed: 1, kickoffAt: 0, home: managed, away: team(b) }));
    const st = eng.createMatch({ fixtureId: "m", seed: 1, kickoffAt: 0, home: managed, away: team(b) });
    const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
    for (const [i, minute] of [[0, 0], [1, 60], [2, 120]]) {
      const r = eng.goalRates(st, { stance: { home: "defend", away: "balanced" }, urg: { home: true, away: false }, minute });
      expect([m.r.hT[2 * i], m.r.hT[2 * i + 1]]).toEqual([r6(r.home), r6(r.away)]);
    }
    expect(st.teams.home.stance).toBe("defend"); // goalRates never changes the match state
  });

  it("prices a coherent distribution from any state, and the cheap qualify walk agrees with the full one", () => {
    for (const [sc, min, ph] of [[[0, 0], 0, "pre"], [[0, 1], 60, "second_half"], [[2, 1], 85, "second_half"], [[1, 1], 90, "second_half"], [[2, 2], 104, "extra_time_2"], [[0, 0], 45, "half_time"], [[1, 1], 90, "et_break"]] as [number[], number, string][]) {
      const st = live(sc, ph);
      const fd = odds.finalDist(model, st, min);
      const total = Object.values(fd.dist as Record<string, number>).reduce((s, p) => s + p, 0);
      expect(total, `${sc} ${min}`).toBeCloseTo(1, 9);
      for (const k of Object.keys(fd.dist)) {
        const [h, aw] = k.split("-").map(Number);
        expect(h).toBeGreaterThanOrEqual(sc[0]);
        expect(aw).toBeGreaterThanOrEqual(sc[1]);
      }
      expect(odds.finalDist(model, st, min, true).qualifyHome).toBeCloseTo(fd.qualifyHome, 12);
      const ng = odds.nextGoal(model, st, min);
      expect(ng.home + ng.away + ng.none).toBeCloseTo(1, 12);
      expect(ng.none).toBeCloseTo(fd.dist[sc.join("-")] ?? 0, 9); // no further goal = the final score is the current one
    }
  });

  it("prices the trailing side's late chances up against the constant-rate model, and the market catalogue offers those prices", () => {
    const st = live([0, 1]);
    expect(odds.finalDist(model, st, 75).qualifyHome).toBeGreaterThan(odds.finalDist(legacy, st, 75).qualifyHome + 0.02);
    expect(odds.nextGoal(model, st, 75).home).toBeGreaterThan(odds.nextGoal(legacy, st, 75).home + 0.03);
    expect(odds.nextGoal(model, st, 75).none).toBeLessThan(odds.nextGoal(legacy, st, 75).none);
    const fx = { id: "f", status: "live", kickoffAt: 0, model, home: { id: "h", abbr: "H", name: "H" }, away: { id: "a", abbr: "A", name: "A" } };
    const cat = mkt.fixtureMarkets(fx, st, 75, 1);
    const sel = (k: string, id: string) => cat.markets.find((m: { key: string }) => m.key === k).sel.find((s: { id: string }) => s.id === id).odds;
    expect(sel("winner", "home")).toBe(mkt.okP(odds.finalDist(model, st, 75).qualifyHome, true));
    expect(sel("next_goal", "home")).toBe(mkt.okP(odds.nextGoal(model, st, 75).home, true));
  });

  it("still prices a legacy kickoff model (a match in flight at the deploy) with the constant-rate model", () => {
    const st = live([1, 0]);
    const L = legacy.lh + legacy.la;
    const none = Math.exp(-L * 15);
    expect(odds.nextGoal(legacy, st, 75).none).toBeCloseTo(none, 12);
    expect(odds.nextGoal(legacy, st, 75).home).toBeCloseTo(((1 - none) * legacy.lh) / L, 12);
  });

  it("an engine state saved mid-match before the deploy resumes on the new engine: same shape, a valid stream", () => {
    const st = eng.createMatch({ fixtureId: "old", seed: 4321, kickoffAt: 0, home: team(a), away: team(b), timing: eng.buildTiming(6000, 1) });
    while (st.minute < 72) eng.advanceTo(st, st.nextAt);
    const saved = JSON.parse(JSON.stringify(st));
    saved.counter = saved.counter ?? "away"; // the old engine left its flag set at a minute's end, exactly as this one does
    const a1 = eng.advanceTo(JSON.parse(JSON.stringify(saved)), Infinity);
    const a2 = eng.advanceTo(JSON.parse(JSON.stringify(saved)), Infinity);
    expect(JSON.stringify(a1)).toBe(JSON.stringify(a2));
    expect(a1.at(-1).t).toBe("match_end");
    expect(a1[0].seq).toBe(saved.seq + 1);
  });
});
